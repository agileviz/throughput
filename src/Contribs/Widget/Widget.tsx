import "./Widget.scss";
import * as SDK from "azure-devops-extension-sdk";
import * as Dashboard from "azure-devops-extension-api/Dashboard";
import { ThroughputSettings, DEFAULT_SETTINGS, sanitizeNumIntervals } from "../../Library/widgetSettings";
import { fetchThroughput, ThroughputResult, ThroughputBucket } from "../../Library/throughputData";
import { applyTypeFilter, computeMeanPerInterval, computeGlobalTypeOrder, buildTsv, countVisibleItems } from "../../Library/throughputView";

interface WidgetState {
    title:       string;
    size:        { columnSpan: number; rowSpan: number };
    settings:    ThroughputSettings;
    configured:  boolean;
    loading:     boolean;
    error:       string;
    result:      ThroughputResult | null;
    // Session-only legend filter. Click a legend entry to toggle a work-item
    // type out of the chart (segments removed, headline recomputed, tooltip
    // pruned). Reset whenever the fetched data changes (new team / backlog /
    // interval / numIntervals) — type sets can differ across configs, so old
    // filters wouldn't carry meaningful intent. Preserved across the
    // showBreakdown toggle since the type set is unchanged.
    hiddenTypes: Set<string>;
}

const DEFAULT_TYPE_COLOR = "#888888";

// AgileViz brand blue. Used for the unified-bar color when the breakdown
// toggle is OFF. Decoupled from TYPE_PALETTE[0] in throughputData.ts on
// purpose — this is a brand color, not a palette slot. They happen to share
// a hex right now; future palette tweaks should not silently re-paint the
// breakdown-OFF view.
const BRAND_BLUE = "#0092da";

// Clipboard write that works inside ADO extension iframes.
//
// We deliberately do NOT try navigator.clipboard.writeText() first. ADO does
// not include `clipboard-write` in the Permissions Policy header for widget
// iframes (verified 2026-04-26 — see crbug.com/414348233 for the underlying
// Chromium tightening). The modern API will always throw NotAllowedError
// here, and the browser logs the violation to the console even when the
// throw is handled — that noise alarms users every click. Going straight
// to the legacy API gives a clean console and the same outcome.
//
// document.execCommand('copy') is officially deprecated but is not gated by
// Permissions Policy and is universally supported. It requires a focused,
// selected text-bearing element, so we drop a transient off-screen
// <textarea>, select it, exec copy, then clean up. Must run synchronously
// inside the click handler's task to preserve transient user activation.
function writeClipboard(text: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Position off-screen but still in the layout so .select() works.
    // `display: none` would defeat selection; opacity 0 + fixed off-screen
    // keeps it invisible without removing it from the accessibility tree
    // for the millisecond it lives.
    textarea.style.position      = 'fixed';
    textarea.style.left          = '-9999px';
    textarea.style.top           = '0';
    textarea.style.opacity       = '0';
    textarea.setAttribute('readonly', '');   // suppress mobile keyboard popup
    document.body.appendChild(textarea);
    textarea.select();
    // No initializer: both the try and the catch assign, so seeding `false`
    // here is dead (ESLint 9's no-useless-assignment flags it).
    let ok: boolean;
    try {
        ok = document.execCommand('copy');
    } catch (err) {
        console.error("Throughput: execCommand('copy') threw", err);
        ok = false;
    }
    document.body.removeChild(textarea);
    return ok;
}

class ThroughputWidget implements Dashboard.IConfigurableWidget {

    private state: WidgetState = {
        title:       "Throughput",
        size:        { columnSpan: 4, rowSpan: 2 },
        settings:    { ...DEFAULT_SETTINGS },
        configured:  false,
        loading:     false,
        error:       "",
        result:      null,
        hiddenTypes: new Set<string>()
    };

    private root: HTMLElement;
    private lastConfigKey = "";
    private lastDataKey   = "";
    // Monotonic token for fetchThroughput races. ADO calls load() / reload()
    // / preload() in quick succession when the user flips configs, and the
    // network responses can arrive out of order. Each invocation captures
    // its token before awaiting; the result is only assigned to state if
    // the captured token still matches — otherwise a newer fetch already
    // superseded us and writing would clobber fresher data.
    private fetchSeq = 0;

    constructor() {
        this.root = document.getElementById("root")!;
        // Document-level dismissal handlers for the right-click context menu.
        // Installed ONCE here (not per render) — the document survives
        // innerHTML rewrites, so re-adding listeners every render would leak.
        // Handlers re-locate the current menu element via querySelector since
        // the node identity changes each render.
        document.addEventListener('click', (e) => {
            const menu = this.root.querySelector('.tp-context-menu') as HTMLElement | null;
            if (!menu || menu.hidden) return;
            if (menu.contains(e.target as Node)) return;
            menu.hidden = true;
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const menu = this.root.querySelector('.tp-context-menu') as HTMLElement | null;
            if (menu && !menu.hidden) menu.hidden = true;
        });
    }

    private async processSettings(widgetSettings: Dashboard.WidgetSettings): Promise<void> {
        let saved: ThroughputSettings | null = null;
        try {
            saved = JSON.parse(widgetSettings.customSettings.data);
        } catch { /* fresh install: data is "" — unconfigured */ }

        const settings: ThroughputSettings = saved
            ? { ...DEFAULT_SETTINGS, ...saved }
            : { ...DEFAULT_SETTINGS };
        // Persistence-boundary sanitization. Mirrors Config.tsx so a
        // corrupted dashboard JSON (older schema, manual REST edit, partial
        // migration) can't reach the runtime clamp in computeIntervalWindows.
        // Same fallback as Config — DEFAULT_SETTINGS.numIntervals — keeps
        // the UI and the data path in lockstep.
        settings.numIntervals = sanitizeNumIntervals(settings.numIntervals);
        const configured = !!saved && !!settings.teamId;

        Object.assign(this.state, {
            title: widgetSettings.name,
            size:  widgetSettings.size,
            settings,
            configured
        });

        // Data key (drives refetch + filter reset) excludes showBreakdown — that
        // toggle is purely a render-time switch over the same fetched data, so
        // the user's legend filter should survive flipping breakdown off and on.
        const dataKey = configured
            ? `${settings.teamId}|${settings.backlogCategoryReferenceName}|${settings.interval}|${settings.numIntervals}`
            : "";
        const configKey = configured
            ? `${dataKey}|${settings.showBreakdown ? '1' : '0'}`
            : "";

        if (!configured) {
            // Bump the token so any in-flight fetchThroughput that resolves
            // after this point won't write back over the cleared state.
            ++this.fetchSeq;
            this.state.loading      = false;
            this.state.error        = "";
            this.state.result       = null;
            this.state.hiddenTypes  = new Set();
            this.lastConfigKey      = "";
            this.lastDataKey        = "";
            this.render();
            return;
        }

        if (configKey === this.lastConfigKey && this.state.result) {
            this.render();
            return;
        }
        this.lastConfigKey = configKey;

        // Wipe the legend filter when the underlying data set changes — the
        // type names from another team/backlog wouldn't refer to anything
        // meaningful here. Breakdown-toggle changes don't trip this reset.
        if (dataKey !== this.lastDataKey) {
            this.state.hiddenTypes = new Set();
            this.lastDataKey       = dataKey;
        }

        this.state.loading = true;
        this.state.error   = "";
        this.render();

        const myFetchId = ++this.fetchSeq;
        try {
            const result = await fetchThroughput(settings);
            // Drop the result if a newer processSettings invocation has
            // already kicked off a fresh fetch — this older response would
            // otherwise clobber the user's current selection with stale data.
            if (myFetchId !== this.fetchSeq) return;
            this.state.result  = result;
            this.state.loading = false;
            this.state.error   = "";
        } catch (err) {
            if (myFetchId !== this.fetchSeq) return;
            console.error("Throughput: data fetch failed", err);
            this.state.result  = null;
            this.state.loading = false;
            this.state.error   = "Couldn't load throughput data. Try refreshing the page; contact your admin if this persists.";
        }
        this.render();
    }

    public async preload(s: Dashboard.WidgetSettings) {
        await this.processSettings(s);
        return Dashboard.WidgetStatusHelper.Success();
    }

    public async load(s: Dashboard.WidgetSettings) {
        await this.processSettings(s);
        return Dashboard.WidgetStatusHelper.Success();
    }

    public async reload(s: Dashboard.WidgetSettings) {
        await this.processSettings(s);
        return Dashboard.WidgetStatusHelper.Success();
    }

    private render(): void {
        this.root.innerHTML = this.buildHTML();
        // Re-wire the tooltip after every innerHTML write — the previous
        // listeners died with the old DOM. wireTooltip is a no-op when the
        // chart isn't on screen (e.g., loading/error/unconfigured states).
        this.wireTooltip();
        this.wireLegendToggles();
        this.wireContextMenu();
    }

    // Right-click on the chart-bars area opens a small context menu with a
    // single "Copy {N} items as TSV" action. Scoped to bars-only (not the
    // whole widget) so ADO's dashboard chrome retains its own right-click
    // gestures on the widget header / chart corners.
    private wireContextMenu(): void {
        const bars = this.root.querySelector('.tp-chart-bars') as HTMLElement | null;
        const menu = this.root.querySelector('.tp-context-menu') as HTMLElement | null;
        if (!bars || !menu) return;

        bars.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (!this.state.result) return;
            this.openContextMenu(menu, (e as MouseEvent).clientX, (e as MouseEvent).clientY);
        });

        menu.addEventListener('click', (e) => {
            // Clicks on the menu's padding/border land on the menu div itself,
            // not the button child — closest() walking UP from the target then
            // returns null and the handler would silently bail. Tolerate that
            // by falling back to the menu's single action when no menu-item
            // ancestor is in the click path. Any click on the menu surface
            // should activate the action it shows.
            let item = (e.target as HTMLElement).closest('[data-action="copy"]') as HTMLElement | null;
            if (!item) item = menu.querySelector('[data-action="copy"]') as HTMLElement | null;
            if (!item) return;
            if (item.getAttribute('aria-disabled') === 'true') return;
            this.copyTsvAndConfirm(menu);
        });
    }

    private openContextMenu(menu: HTMLElement, clientX: number, clientY: number): void {
        if (!this.state.result) return;
        const count    = countVisibleItems(this.state.result, this.state.hiddenTypes);
        const disabled = count === 0;
        // "1 item" / "47 items" — singular vs plural matters at small counts
        // because reading "Copy 1 items" is the kind of detail that makes a
        // polished tool feel sloppy.
        const label = disabled
            ? "No items to copy"
            : `Copy ${count} ${count === 1 ? 'item' : 'items'} as TSV`;
        menu.classList.remove('tp-context-menu--confirm');
        menu.innerHTML = `<button type="button" class="tp-context-menu-item" data-action="copy" aria-disabled="${disabled}">${this.esc(label)}</button>`;
        menu.hidden = false;

        // Position relative to .tp-chart (which has position: relative — same
        // anchor used by .tp-tooltip). Convert from viewport coords (clientX/Y)
        // to chart-relative, then clamp so the menu stays inside the widget.
        const chart = this.root.querySelector('.tp-chart') as HTMLElement | null;
        if (!chart) return;
        const chartRect = chart.getBoundingClientRect();
        const menuRect  = menu.getBoundingClientRect();
        const leftPx = Math.max(0, Math.min(clientX - chartRect.left, chartRect.width  - menuRect.width));
        const topPx  = Math.max(0, Math.min(clientY - chartRect.top,  chartRect.height - menuRect.height));
        menu.style.left = `${leftPx}px`;
        menu.style.top  = `${topPx}px`;
    }

    private copyTsvAndConfirm(menu: HTMLElement): void {
        if (!this.state.result) return;
        const count = countVisibleItems(this.state.result, this.state.hiddenTypes);
        // buildTsv asserts a bucket/window invariant — wrap so an assertion
        // failure surfaces as the same "Couldn't copy" UX as a clipboard
        // failure rather than an unhandled throw that freezes the menu.
        let tsv: string;
        try {
            tsv = buildTsv(this.state.result, this.state.hiddenTypes);
        } catch (err) {
            console.error("Throughput: buildTsv failed", err);
            menu.innerHTML = `<span class="tp-context-menu-confirm tp-context-menu-confirm--error">Couldn't copy — try again</span>`;
            menu.classList.add('tp-context-menu--confirm');
            setTimeout(() => { menu.hidden = true; }, 1800);
            return;
        }
        const ok = writeClipboard(tsv);
        if (!ok) {
            menu.innerHTML = `<span class="tp-context-menu-confirm tp-context-menu-confirm--error">Couldn't copy — try again</span>`;
            menu.classList.add('tp-context-menu--confirm');
            setTimeout(() => { menu.hidden = true; }, 1800);
            return;
        }
        menu.innerHTML = `<span class="tp-context-menu-confirm">✓ Copied ${count} ${count === 1 ? 'item' : 'items'}</span>`;
        menu.classList.add('tp-context-menu--confirm');
        // 1.5s feels right: long enough to read the confirmation, short enough
        // that the menu doesn't linger when the user is back at their next
        // action. Tooltip + outlier-export use similar values.
        setTimeout(() => { menu.hidden = true; }, 1500);
    }

    // Wire delegated click handler on the legend so each <button> toggles
    // its work-item type into/out of hiddenTypes. Locked entries (the last
    // visible type — see the floor rule in buildChart) carry aria-disabled
    // and are no-ops here so users can't filter the chart down to nothing.
    private wireLegendToggles(): void {
        const legend = this.root.querySelector('.tp-chart-legend') as HTMLElement | null;
        if (!legend) return;
        legend.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest('.tp-legend-item') as HTMLButtonElement | null;
            if (!btn) return;
            if (btn.getAttribute('aria-disabled') === 'true') return;
            const name = btn.dataset.typeName;
            if (!name) return;
            if (this.state.hiddenTypes.has(name)) {
                this.state.hiddenTypes.delete(name);
            } else {
                this.state.hiddenTypes.add(name);
            }
            this.render();
            // The render() above replaced every legend button — including the
            // one that was just clicked — so the browser dropped focus to
            // <body>. Restore it to the rebuilt entry for the same type so
            // keyboard users can keep tab/Enter/Space cycling through filters
            // without losing their place. Match by dataset.typeName rather
            // than a CSS attribute selector to sidestep selector-escaping for
            // type names with awkward characters (quotes, brackets, etc.).
            this.focusLegendButtonByType(name);
        });
    }

    private focusLegendButtonByType(name: string): void {
        const buttons = this.root.querySelectorAll<HTMLButtonElement>('.tp-chart-legend .tp-legend-item');
        for (const b of Array.from(buttons)) {
            if (b.dataset.typeName === name) {
                b.focus();
                return;
            }
        }
    }

    // Attach delegated hover handlers to the bars container, populating +
    // positioning the tooltip on bar hover and hiding it on container leave.
    // Single delegated mouseover catches every bar enter; mouseleave on the
    // container fires only when the cursor truly exits (doesn't bubble).
    private wireTooltip(): void {
        const barsContainer = this.root.querySelector('.tp-chart-bars') as HTMLElement | null;
        const tooltip      = this.root.querySelector('.tp-tooltip')      as HTMLElement | null;
        if (!barsContainer || !tooltip || !this.state.result) return;

        barsContainer.addEventListener('mouseover', (e) => {
            const col = (e.target as HTMLElement).closest('.tp-bar-column') as HTMLElement | null;
            if (!col) return;
            const idx = parseInt(col.dataset.bucketIndex || '', 10);
            const raw = this.state.result?.buckets[idx];
            if (!raw) return;
            // Tooltip respects the legend filter: the per-type list and total
            // reflect what's currently visible in the chart, not the full
            // fetched set. Hidden types are absent from both the list and the
            // total so the bar's apparent height matches the tooltip's count.
            const bucket = applyTypeFilter([raw], this.state.hiddenTypes)[0];
            this.showTooltip(tooltip, col, bucket);
        });

        barsContainer.addEventListener('mouseleave', () => {
            tooltip.hidden = true;
        });
    }

    // Build tooltip HTML for the hovered bucket and position it above the
    // column (or below if there isn't room above), clamped to the chart's
    // horizontal bounds so leftmost/rightmost bars don't overflow the widget.
    private showTooltip(tooltip: HTMLElement, col: HTMLElement, bucket: ThroughputBucket): void {
        const typeColors = this.state.result?.typeColors || {};

        // Always show the per-type breakdown in the tooltip, even when the
        // chart's breakdown toggle is OFF. The toggle controls chart density
        // (ambient awareness); the tooltip is the details-on-demand surface.
        // Type colors stay coherent across both states — they function as
        // persistent identifiers, not just chart paint. The legend on the
        // chart stays conditional on the toggle (a one-row "Total" legend
        // would be noise) — that asymmetry is intentional.
        const typesBlock = bucket.byType.length > 0
            ? `<ul class="tp-tooltip-types">${bucket.byType.map(t => {
                const color = typeColors[t.name] || DEFAULT_TYPE_COLOR;
                return `<li>
                    <span class="tp-tooltip-swatch" style="background:${color}"></span>
                    <span class="tp-tooltip-name">${this.esc(t.name)}</span>
                    <span class="tp-tooltip-count">${t.count}</span>
                </li>`;
            }).join('')}</ul>`
            : '';

        // "(in progress)" annotation pairs with the diagonal-stripe marker
        // on the bar itself (see .tp-bar-partial). Visual + text together is
        // the redundancy that makes the in-progress state read clearly even
        // for users who never hover or who miss the hatching at small sizes.
        const partialNote = bucket.isPartial ? ' (in progress)' : '';

        tooltip.innerHTML = `
            <div class="tp-tooltip-header">
                <strong>${this.esc(bucket.label)}</strong>
                <span class="tp-tooltip-range">${this.esc(bucket.windowRangeLabel)}${partialNote}</span>
            </div>
            ${typesBlock}
            <div class="tp-tooltip-total">
                <span>Total</span>
                <span class="tp-tooltip-count">${bucket.total}</span>
            </div>`;

        // Unhide before measuring — getBoundingClientRect on a hidden element
        // returns zeros, which would clamp leftPx to 0 unconditionally.
        tooltip.hidden = false;

        const chart = this.root.querySelector('.tp-chart') as HTMLElement | null;
        if (!chart) return;
        const chartRect = chart.getBoundingClientRect();
        const colRect   = col.getBoundingClientRect();
        const tipRect   = tooltip.getBoundingClientRect();

        // Horizontal: center on the hovered bar, clamped to chart bounds so
        // edge bars don't overflow the widget.
        const colCenterX = colRect.left + colRect.width / 2 - chartRect.left;
        const leftPx = Math.max(0, Math.min(colCenterX - tipRect.width / 2, chartRect.width - tipRect.width));

        // Vertical: pin to the viewport middle. Bar heights vary, so tracking
        // the bar's top would jitter the tooltip vertically as the user slides
        // between bars of different counts. A fixed vertical anchor keeps the
        // user's eye still while only the tooltip *content* changes per hover.
        // window.innerHeight equals the iframe content area inside an ADO
        // widget. Convert from viewport coords to chart-relative for style.top.
        const topPxViewport = Math.max(0, (window.innerHeight - tipRect.height) / 2);
        const topPx         = topPxViewport - chartRect.top;

        tooltip.style.left = `${leftPx}px`;
        tooltip.style.top  = `${topPx}px`;
    }

    private buildHTML(): string {
        const { title, configured, loading, error, result } = this.state;

        let body: string;
        if (!configured) {
            body = `<div class="vqw-centered-state">
                <img alt="Throughput" src="../../static/icon.png" />
                <p class="vqw-centered-hint">Configure this widget to get started.</p>
            </div>`;
        } else if (loading) {
            body = `<div class="vqw-status">Loading throughput data…</div>`;
        } else if (error) {
            body = `<div class="vqw-status vqw-error">${this.esc(error)}</div>`;
        } else if (result) {
            body = this.buildChart(result);
        } else {
            body = `<div class="vqw-status">No data.</div>`;
        }

        return `<div class="vqw-widget"><h2 class="vqw-title">${this.esc(title)}</h2>${body}</div>`;
    }

    private buildChart(result: ThroughputResult): string {
        const { settings, hiddenTypes } = this.state;
        const { typeColors } = result;

        // Apply the legend filter once at the top so every downstream computation
        // (headline, bar heights, segments, tooltip) sees the same view of the
        // data. Filter is empty by default; only non-empty after a legend click.
        const buckets = applyTypeFilter(result.buckets, hiddenTypes);

        // Global type order from the *unfiltered* buckets — drives both the
        // legend (every type stays clickable, hidden ones rendered "off") and
        // each bar's segment stacking. Sorting by total count descending puts
        // the biggest contributor at the bottom of every bar and keeps that
        // position stable as the user toggles types — without this, surviving
        // segments would reshuffle each click.
        const globalTypeOrder = computeGlobalTypeOrder(result.buckets);

        const meanPerInterval = computeMeanPerInterval(buckets);
        const intervalUnit    = settings.interval.toLowerCase();

        // Maximum bar height for proportional scaling — uses *filtered* totals
        // so the remaining types still fill the chart visually after a hide.
        // Avoid divide-by-zero when all buckets are empty.
        const maxCount = Math.max(1, ...buckets.map(b => b.total));

        // Right side of the chart-header. Priority chain: warning > info > meta.
        // Warning (⚠): real state nobody wants — no current sprint exists.
        // Info (ⓘ):    soft state often legitimate — fetch succeeded but no
        //              completed items in the timeframe.
        // Meta:        steady state — team / backlog / totals.
        // Same flex slot in all three; swap content rather than stack so the
        // chart-header height stays predictable. Static text below; no user
        // input flows in, so no escaping needed.
        let headerRight: string;
        if (result.noCurrentSprint) {
            headerRight = `<span class="tp-chart-warning"><span class="tp-chart-warning-icon">⚠</span>No current sprint. Add team iterations or switch widget to Month.</span>`;
        } else if (result.totalItems === 0) {
            headerRight = `<span class="tp-chart-info"><span class="tp-chart-info-icon">ⓘ</span>No completed items in this timeframe. Verify team or backlog if unexpected.</span>`;
        } else {
            headerRight = `<span class="tp-chart-meta">${this.esc(settings.teamName)} · ${this.esc(settings.backlogCategoryName)} · ${result.totalItems} total</span>`;
        }

        const header = `<div class="tp-chart-header">
            <span class="tp-chart-headline">${meanPerInterval} <span class="tp-chart-headline-unit">items / ${this.esc(intervalUnit)}</span></span>
            ${headerRight}
        </div>`;

        // Bar columns. Iterate chronologically (oldest left → newest right).
        // When showBreakdown is OFF, render a single brand-blue fill instead
        // of per-type stacked segments. Same data, same heights — only the
        // segment subdivision is suppressed. The headline scalar and totals
        // stay identical because they're computed from b.total.
        //
        // data-bucket-index pins each column to its index in result.buckets so
        // the delegated mouseover handler can look up bucket data without
        // duplicating it into the DOM. Native title= attrs intentionally
        // omitted — the custom tooltip (.tp-tooltip below) replaces them.
        const columns = buckets.map((b, i) => {
            const heightPct = (b.total / maxCount * 100).toFixed(1);
            const isEmpty  = b.total === 0;

            let segments: string;
            if (settings.showBreakdown) {
                // Stacked segments rendered in globalTypeOrder (count-desc across
                // all buckets, with name as tiebreaker). DOM order is top-to-
                // bottom but CSS `flex-direction: column-reverse` flips it, so
                // the highest-global-count type lands at the bottom of every
                // bar — stable across buckets and stable through filter toggles.
                // Per-bucket byType is keyed by name for O(1) lookup; types
                // missing from this bucket simply contribute no segment.
                const byTypeMap = new Map(b.byType.map(t => [t.name, t.count]));
                segments = globalTypeOrder.map(name => {
                    const count = byTypeMap.get(name);
                    if (!count) return '';
                    const segPct = (count / b.total * 100).toFixed(1);
                    const color  = typeColors[name] || DEFAULT_TYPE_COLOR;
                    return `<div class="tp-segment" style="height:${segPct}%;background:${color}"></div>`;
                }).join('');
            } else {
                // Single unified segment, brand blue. Filling the whole bar
                // keeps the same DOM shape as the stacked path so layout +
                // border-radius behavior stays consistent.
                segments = b.total > 0
                    ? `<div class="tp-segment" style="height:100%;background:${BRAND_BLUE}"></div>`
                    : '';
            }

            // Mark non-empty partial bars (current in-progress interval) with
            // diagonal hatching so readers don't misinterpret an artificially
            // low count as a real drop. Empty partials don't get the stripe —
            // a 2px-tall empty bar can't show the pattern meaningfully.
            const partialClass = (b.isPartial && !isEmpty) ? " tp-bar-partial" : "";
            const barClass = (isEmpty ? "tp-bar tp-bar-empty" : "tp-bar") + partialClass;
            const totalLabel = b.total > 0 ? `<span class="tp-bar-total">${b.total}</span>` : '';

            return `<div class="tp-bar-column" data-bucket-index="${i}">
                <div class="tp-bar-area">
                    ${totalLabel}
                    <div class="${barClass}" style="height:${heightPct}%">${segments}</div>
                </div>
                <div class="tp-bar-label">${this.esc(b.label)}</div>
            </div>`;
        }).join('');

        // Legend: every type that appears anywhere in the data, in globalTypeOrder
        // (matches the bar segment order). Only rendered when the breakdown is
        // shown — with breakdown OFF the chart is a single brand-blue fill, so a
        // legend reading "Total" would be noise.
        //
        // Each entry is a <button> toggle. Clicking adds/removes the type from
        // hiddenTypes; a re-render updates segments, headline, and tooltip.
        // aria-pressed communicates the current visibility; aria-disabled marks
        // the *last visible* type so a user can't filter the chart down to
        // nothing (an empty chart is a worse UX than locking the final segment
        // ON). Native <button> wins us focus rings, Enter/Space activation, and
        // the right semantics for screen readers — no manual key handling.
        const visibleTypeCount = globalTypeOrder.length - hiddenTypes.size;
        const legend = (settings.showBreakdown && globalTypeOrder.length > 0)
            ? `<div class="tp-chart-legend" role="group" aria-label="Filter by work item type">${globalTypeOrder.map(name => {
                const color    = typeColors[name] || DEFAULT_TYPE_COLOR;
                const isHidden = hiddenTypes.has(name);
                const isLocked = !isHidden && visibleTypeCount === 1;
                const classes  = ['tp-legend-item'];
                if (isHidden) classes.push('tp-legend-item--off');
                if (isLocked) classes.push('tp-legend-item--locked');
                const lockedTitle = isLocked ? ' title="At least one type must remain visible"' : '';
                return `<button type="button" class="${classes.join(' ')}" data-type-name="${this.esc(name)}" aria-pressed="${!isHidden}" aria-disabled="${isLocked}"${lockedTitle}><span class="tp-swatch" style="background:${color}"></span><span class="tp-legend-label">${this.esc(name)}</span></button>`;
            }).join('')}</div>`
            : '';

        // Footer hint surfaces the right-click affordance — invisible
        // otherwise. Rendered only when there's data to copy: hiding it on
        // empty results avoids advertising an action the user can't take.
        const hint = result.totalItems > 0
            ? `<div class="tp-chart-hint">Right-click visual to copy data →</div>`
            : '';

        // .tp-tooltip and .tp-context-menu are both positioned absolutely
        // inside .tp-chart (which has position: relative). Both stay hidden
        // until a handler shows them. See wireTooltip() and wireContextMenu()
        // for the event flow on each.
        return `<div class="tp-chart">
            ${header}
            <div class="tp-chart-bars">${columns}</div>
            ${legend}
            ${hint}
            <div class="tp-tooltip" hidden></div>
            <div class="tp-context-menu" hidden></div>
        </div>`;
    }

    // Escape user-derived strings for both text content and attribute values.
    // ADO custom-process work-item-type names are now interpolated into
    // data-type-name="..." attributes (legend buttons), so quotes have to
    // round-trip safely or a type name with a stray quote could break out
    // of the attribute. Single quote handled too in case future template
    // syntax switches.
    private esc(s: string): string {
        return String(s)
            .replace(/&/g,  "&amp;")
            .replace(/</g,  "&lt;")
            .replace(/>/g,  "&gt;")
            .replace(/"/g,  "&quot;")
            .replace(/'/g,  "&#39;");
    }
}

async function init(): Promise<void> {
    const widget = new ThroughputWidget();
    try {
        SDK.init();
        await SDK.ready();
        SDK.register("throughput", widget);
    } catch (err) {
        console.error("Throughput: failed to initialize SDK", err);
    }
}

init();
