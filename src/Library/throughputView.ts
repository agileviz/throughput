import { ThroughputBucket, ThroughputResult } from "./throughputData";

// View-layer helpers for the Throughput widget. Pure transforms over the
// already-fetched ThroughputResult shape — no ADO calls, no DOM, no SDK.
// Living here (not in throughputData.ts) keeps the data-pipeline file
// focused on fetch+bucket and lets these helpers be unit-tested in
// isolation without standing up jsdom or mocking the ADO SDK.

// Apply the user's legend-driven type filter to a bucket array. Returns
// new buckets with byType pruned to non-hidden entries and total recomputed
// from the surviving counts. Empty filter is the identity (returns original
// references unchanged so callers can short-circuit downstream work).
export function applyTypeFilter(
    buckets:     ReadonlyArray<ThroughputBucket>,
    hiddenTypes: ReadonlySet<string>
): Array<ThroughputBucket> {
    if (hiddenTypes.size === 0) return buckets.slice();
    return buckets.map(b => {
        const byType = b.byType.filter(t => !hiddenTypes.has(t.name));
        const total  = byType.reduce((s, t) => s + t.count, 0);
        return { ...b, byType, total };
    });
}

// Headline scalar: mean items per fully-elapsed, non-empty interval.
// Excluding empties stops pre-history zeros from dragging the number down.
// Excluding partials prevents a partway-through interval from skewing the
// average — a month that's 80% elapsed isn't fair to compare against full
// months. Fallback: if everything is partial-or-empty, use any non-empty
// bucket regardless of partiality so the headline isn't mysteriously zero.
export function computeMeanPerInterval(buckets: ReadonlyArray<ThroughputBucket>): number {
    const fullCompleted = buckets.filter(b => b.total > 0 && !b.isPartial);
    const pool          = fullCompleted.length > 0 ? fullCompleted : buckets.filter(b => b.total > 0);
    if (pool.length === 0) return 0;
    return Math.round(pool.reduce((s, b) => s + b.total, 0) / pool.length);
}

// Build a TSV (tab-separated values) string suitable for clipboard write
// and Excel paste. Walks every visible item across every bucket, applying
// the legend filter so the export reflects exactly what the user sees in
// the chart. Emits a header row + one row per item; cells are tab-separated
// and rows are LF-separated (Excel accepts both LF and CRLF on paste).
//
// 15 columns: ID, Title, Type, State, Created Date, Activated Date,
// Closed Date, Bucket, Bucket Start Date, Bucket End Date, Bucket Status,
// Assigned To, Tags, URL, Area Path. See the slice 3 design conversation
// for the rationale on each.
//
// Cell hygiene:
//   - Title and Tags have tabs/CR/LF stripped so a malformed entry can't
//     break Excel's column/row parsing. Replace with single space rather
//     than concatenate so word boundaries are preserved.
//   - Date fields are truncated to "YYYY-MM-DD" (slice the first 10 chars
//     of the ISO timestamp). Sortable, locale-stable, Excel-friendly.
//   - Empty cells stay empty rather than becoming "null" or "undefined" —
//     blank in Excel is the right semantic for "this field was not set."
//   - Bucket End Date uses w.end - 1ms to land on the inclusive last day,
//     matching the chart's tooltip range display. Without this, a "Apr"
//     bucket would show End = "2026-05-01", contradicting the chart.
export const TSV_HEADERS: ReadonlyArray<string> = [
    "ID", "Title", "Type", "State",
    "Created Date", "Activated Date", "Closed Date",
    "Bucket", "Bucket Start Date", "Bucket End Date", "Bucket Status",
    "Assigned To", "Tags", "URL", "Area Path"
];

export function buildTsv(result: ThroughputResult, hiddenTypes: ReadonlySet<string>): string {
    // Invariant: fetchThroughput guarantees one bucket per window across all
    // return paths (full pipeline, empty types, empty states, empty windows).
    // Asserting at the top — rather than silently skipping misaligned rows
    // inside the loop, as the previous defensive sentinel did — converts a
    // would-be invisible data-loss bug into a loud failure that the right-
    // click handler in Widget.tsx surfaces as "Couldn't copy" rather than
    // shipping the user a partial TSV. Trust-critical for an export feature.
    if (result.buckets.length !== result.windows.length) {
        throw new Error(
            `buildTsv: bucket/window length mismatch (${result.buckets.length} vs ${result.windows.length}). ` +
            `fetchThroughput should always pair them — this is a programmer error.`
        );
    }

    const lines: Array<string> = [TSV_HEADERS.join('\t')];

    result.buckets.forEach((bucket, idx) => {
        const window = result.windows[idx];
        const bucketStart = isoDate(window.start);
        // Inclusive last day: subtract 1ms from the exclusive window end before
        // truncating. Otherwise "Apr" reads as ending "2026-05-01".
        const bucketEnd   = isoDate(new Date(window.end.getTime() - 1));
        const bucketStatus = bucket.isPartial ? "In progress" : "Complete";

        for (const item of bucket.items) {
            if (hiddenTypes.has(item.workItemType)) continue;
            lines.push([
                String(item.id),
                cleanCell(item.title),
                item.workItemType,
                item.state,
                isoDate(item.createdDate),
                isoDate(item.activatedDate),
                isoDate(item.closedDate),
                bucket.label,
                bucketStart,
                bucketEnd,
                bucketStatus,
                item.assignedTo,
                cleanCell(item.tags),
                result.urlPrefix ? `${result.urlPrefix}${item.id}` : String(item.id),
                item.areaPath
            ].join('\t'));
        }
    });

    return lines.join('\n');
}

// Count visible items in the result under the current filter. Used by the
// context menu to show "Copy 47 items" instead of just "Copy items" — and
// to decide whether to disable the menu when the visible set is empty.
export function countVisibleItems(result: ThroughputResult, hiddenTypes: ReadonlySet<string>): number {
    let n = 0;
    for (const bucket of result.buckets) {
        for (const item of bucket.items) {
            if (!hiddenTypes.has(item.workItemType)) n++;
        }
    }
    return n;
}

function cleanCell(s: string): string {
    // TSV's structural characters are tab, CR, LF. Replace with single space
    // so Excel sees one cell of running text rather than column or row breaks.
    return s.replace(/[\t\r\n]+/g, ' ');
}

function isoDate(input: string | Date): string {
    if (!input) return "";
    const s = typeof input === "string" ? input : input.toISOString();
    // ADO's date strings are always ISO-8601 with a "T" separator at index 10
    // when the time component is present. Slicing off the first 10 chars is
    // safe for both date-only ("YYYY-MM-DD") and date+time ("YYYY-MM-DDTHH...")
    // representations.
    return s.length >= 10 ? s.slice(0, 10) : s;
}

// Global type order: every type that appears anywhere in the data, sorted
// by total count across all buckets (descending), with type-name as the
// tiebreaker for determinism. Used for both legend display and per-bar
// segment stacking so that:
//   1. Biggest contributors anchor the bottom of every bar (conventional
//      stacked-bar reading).
//   2. Segment positions are stable across buckets — Bug doesn't drift
//      between top and middle as bucket counts vary.
//   3. Legend order matches segment order, so visual scanning lines up.
// Stability also makes the legend-toggle filter feel right: hiding one
// type removes its segment cleanly without reordering the survivors.
export function computeGlobalTypeOrder(buckets: ReadonlyArray<ThroughputBucket>): Array<string> {
    const totals = new Map<string, number>();
    for (const b of buckets) {
        for (const t of b.byType) {
            totals.set(t.name, (totals.get(t.name) || 0) + t.count);
        }
    }
    return Array.from(totals.entries())
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([name]) => name);
}
