import "./Config.scss";
import * as SDK from "azure-devops-extension-sdk";
import * as Dashboard from "azure-devops-extension-api/Dashboard";
import { TeamSettingsIteration } from "azure-devops-extension-api/Work";
import { getTeams, getBacklogsForTeam, getTeamIterations } from "../../Library/adoLibrary";
import { ThroughputSettings, IntervalType, DEFAULT_SETTINGS, sanitizeNumIntervals } from "../../Library/widgetSettings";

export type { ThroughputSettings, IntervalType };

// AgileViz content URLs. Centralized so future URL changes are a one-line edit.
const URL_LEARN   = "https://agileviz.com/";
const URL_SUPPORT = "https://agileviz.com/plugins/throughput/";

// New-tab icon SVG (currentColor so it tracks the link's theme-aware color).
const ICON_EXTERNAL = `<svg class="agv-icon-external" aria-hidden="true" viewBox="0 0 16 16" width="11" height="11"><path fill="currentColor" d="M10 1h5v5h-1V2.7L7.4 9.3l-.7-.7L13.3 2H10V1zM2 3v11h11V8h1v7H1V2h7v1H2z"/></svg>`;

// Sprint eligibility: a team's Sprint option is offered only if it has at
// least 2 dated iterations AND either a currently-running iteration OR a
// recent one (most recent finishDate within SPRINT_STALE_WINDOW_DAYS). This
// prevents the widget from showing a Sprint dropdown for teams that haven't
// run iterations in years (the chart would still work, but the labels would
// reference long-dead sprints, which is misleading).
//
// 60 days covers normal between-sprint gaps for 2/3/4-week cadences plus
// late-December slowdowns and define-as-you-go teams. Tighter would
// false-flag healthy teams; looser would let a 3-year-old sprint schedule
// qualify, which is the exact failure mode the guard is meant to prevent.
const SPRINT_STALE_WINDOW_DAYS = 60;
const SPRINT_STALE_MS          = SPRINT_STALE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Pure — exported indirectly via being the only consumer in this module so
// it stays inlinable and unit-testable in the future.
//
// Deliberately does NOT require ≥2 dated iterations. A brand-new team with
// only its first current sprint set up should be allowed to configure this
// widget — they'll see "Team only has 1 sprint with dates" via the count
// caption, and the chart renders a single in-progress bar. The recency
// check below already filters out the case the count threshold was
// guarding against (a team with one ancient sprint that ended years ago).
function isSprintEligible(iterations: TeamSettingsIteration[]): boolean {
    const dated = iterations.filter(it =>
        it.attributes?.startDate && it.attributes?.finishDate
    );

    const now = Date.now();
    const hasCurrent = dated.some(it => {
        const start  = new Date(it.attributes.startDate!).getTime();
        const finish = new Date(it.attributes.finishDate!).getTime();
        return start <= now && finish >= now;
    });
    if (hasCurrent) return true;

    // Most recent finish strictly before now. If none — i.e., all iterations
    // are in the future, or no iterations at all — the team has no completed
    // history to chart; not eligible (the widget looks backward only).
    const pastFinishes = dated
        .map(it => new Date(it.attributes.finishDate!).getTime())
        .filter(t => t < now);
    if (pastFinishes.length === 0) return false;
    return (now - Math.max(...pastFinishes)) <= SPRINT_STALE_MS;
}

// Count sprints that are usable for backward-looking throughput: dated AND
// already-started (startDate <= now). Future-only sprints are dated but
// not yet useful — the chart can't show data that hasn't happened. Drives
// the "Team has X sprints with dates" caption when X < numIntervals.
function countUsableDatedSprints(iterations: TeamSettingsIteration[]): number {
    const now = Date.now();
    return iterations.filter(it => {
        const start  = it.attributes?.startDate;
        const finish = it.attributes?.finishDate;
        if (!start || !finish) return false;
        return new Date(start).getTime() <= now;
    }).length;
}

class ThroughputWidgetConfig implements Dashboard.IWidgetConfiguration {

    private configContext?: Dashboard.IWidgetConfigurationContext;
    private settings: ThroughputSettings = { ...DEFAULT_SETTINGS };
    private currentIterations: TeamSettingsIteration[] = [];

    private teamSelect!: HTMLSelectElement;
    private backlogSelect!: HTMLSelectElement;
    private intervalSelect!: HTMLSelectElement;
    private numIntervalsInput!: HTMLInputElement;
    private breakdownCheckbox!: HTMLInputElement;
    private intervalHint!: HTMLElement;
    private sprintOption!: HTMLOptionElement;
    private teamError!: HTMLElement;

    constructor() {
        document.getElementById("root")!.innerHTML = `
            <div class="content">
                <div id="team-error" class="error-message" style="display:none">You must select a team.</div>
                <div id="team-load-error" class="error-message" style="display:none">Couldn't load the list of teams. Reload the page to try again.</div>

                <div class="config-field-wrapper">
                    <label class="config-label" for="team-select">Team <span class="error-indicator">*</span></label>
                    <div class="config-select-wrapper">
                        <select class="config-select" id="team-select">
                            <option value="">Loading…</option>
                        </select>
                    </div>
                </div>

                <div class="config-field-wrapper">
                    <label class="config-label" for="backlog-select">Backlog Level</label>
                    <div class="config-select-wrapper">
                        <select class="config-select" id="backlog-select">
                            <option value="">Select a team first</option>
                        </select>
                    </div>
                </div>

                <div class="config-field-row">
                    <div class="config-field-wrapper config-field-half">
                        <label class="config-label" for="interval-select">
                            Interval<a class="config-help-link"
                                       href="${URL_SUPPORT}#sprint-bucketing-by-close-date-not-iteration-path"
                                       target="_blank"
                                       rel="noopener noreferrer"
                                       title="Items group by closed date, regardless of iteration path.">ⓘ</a>
                        </label>
                        <div class="config-select-wrapper">
                            <select class="config-select" id="interval-select">
                                <option value="Sprint" id="interval-option-sprint">Sprint</option>
                                <option value="Month">Month</option>
                                <option value="Quarter">Quarter</option>
                            </select>
                        </div>
                    </div>

                    <div class="config-field-wrapper config-field-half">
                        <label class="config-label" for="num-intervals-input">Number of intervals</label>
                        <input class="config-input" id="num-intervals-input" type="number" min="3" max="26" step="1" value="12" />
                    </div>
                </div>
                <p class="config-interval-hint" id="interval-hint" hidden></p>

                <div class="config-checkbox-wrapper">
                    <label class="config-checkbox-label">
                        <input class="config-checkbox" id="show-breakdown-checkbox" type="checkbox" checked />
                        <span>Show breakdown by work item type</span>
                    </label>
                    <p class="config-checkbox-hint">When off, bars show total items per interval in a single color.</p>
                </div>

                <section class="agv-pitch">
                    <p class="agv-pitch-headline">
                        <strong>Throughput shows how many items you complete.</strong><br>
                        <strong>AgileViz shows how to get more done.</strong>
                    </p>
                    <p class="agv-pitch-body">
                        See where time gets lost, forecast completion dates, spot anomalies, and get AI-assisted coaching.
                    </p>
                    <p class="agv-pitch-link-primary">
                        <a class="agv-link" href="${URL_LEARN}" target="_blank" rel="noopener noreferrer">
                            Where does your team's time go?${ICON_EXTERNAL}<span class="agv-visually-hidden"> (opens in a new tab)</span>
                        </a>
                    </p>
                    <p class="agv-pitch-link-support">
                        <a class="agv-link" href="${URL_SUPPORT}" target="_blank" rel="noopener noreferrer">
                            Learn how Throughput works or get support${ICON_EXTERNAL}<span class="agv-visually-hidden"> (opens in a new tab)</span>
                        </a>
                    </p>
                </section>
            </div>`;

        this.teamSelect        = document.getElementById("team-select")             as HTMLSelectElement;
        this.backlogSelect     = document.getElementById("backlog-select")          as HTMLSelectElement;
        this.intervalSelect    = document.getElementById("interval-select")         as HTMLSelectElement;
        this.numIntervalsInput = document.getElementById("num-intervals-input")     as HTMLInputElement;
        this.breakdownCheckbox = document.getElementById("show-breakdown-checkbox") as HTMLInputElement;
        this.intervalHint      = document.getElementById("interval-hint")           as HTMLElement;
        this.sprintOption      = document.getElementById("interval-option-sprint")  as HTMLOptionElement;
        this.teamError         = document.getElementById("team-error")              as HTMLElement;

        this.teamSelect.addEventListener("change", () => {
            const opt = this.teamSelect.selectedOptions[0];
            this.settings.teamId   = this.teamSelect.value;
            this.settings.teamName = opt ? opt.text : "";
            if (this.settings.teamId) this.teamError.style.display = "none";
            this.notify();
            // Don't clear the current backlog — loadBacklogs() preserves it if
            // the new team also has that backlog, falling back to the
            // requirement-level backlog ("Backlog items") otherwise.
            this.loadBacklogs(this.settings.teamId).catch(err => {
                console.error("Throughput config: failed to load backlogs for team", err);
            });
            // Sprint eligibility is per-team (different teams have different
            // iteration cadences). Re-evaluate every team change.
            this.loadIterations(this.settings.teamId).catch(err => {
                console.error("Throughput config: failed to load iterations for team", err);
            });
        });

        this.backlogSelect.addEventListener("change", () => {
            const opt = this.backlogSelect.selectedOptions[0];
            this.settings.backlogCategoryReferenceName = this.backlogSelect.value;
            this.settings.backlogCategoryName          = opt ? opt.text : "";
            this.notify();
        });

        this.intervalSelect.addEventListener("change", () => {
            this.settings.interval = this.intervalSelect.value as IntervalType;
            this.notify();
            // Caption visibility depends on interval (only Sprint shows it).
            this.updateSprintHint();
        });

        this.numIntervalsInput.addEventListener("change", () => {
            const parsed = parseInt(this.numIntervalsInput.value, 10);
            this.settings.numIntervals  = sanitizeNumIntervals(parsed);
            this.numIntervalsInput.value = String(this.settings.numIntervals);
            this.notify();
            // Caption shows when usable sprints < numIntervals — re-check.
            this.updateSprintHint();
        });

        this.breakdownCheckbox.addEventListener("change", () => {
            this.settings.showBreakdown = this.breakdownCheckbox.checked;
            this.notify();
        });
    }

    public load(
        widgetSettings: Dashboard.WidgetSettings,
        widgetConfigurationContext: Dashboard.IWidgetConfigurationContext
    ): Promise<Dashboard.WidgetStatus> {
        this.configContext = widgetConfigurationContext;

        try {
            const saved: ThroughputSettings = JSON.parse(widgetSettings.customSettings.data);
            if (saved) {
                this.settings = { ...DEFAULT_SETTINGS, ...saved };
                // Sanitize at the persistence boundary so a corrupted saved
                // value (older schema, manual REST edit, partial migration)
                // can't reach the runtime clamp via the input field's
                // String(...) round-trip below.
                this.settings.numIntervals = sanitizeNumIntervals(this.settings.numIntervals);
            }
        } catch { /* fresh install: data is "" — use defaults */ }

        // Default the Team selection to the dashboard's team context on fresh
        // installs. SDK.getWebContext().team is populated when the widget runs
        // on a team-scoped dashboard (~99% case); undefined for project-scoped
        // dashboards. Only applies when no team has been saved yet — never
        // overrides a user's existing selection. notify() so the dashboard's
        // live preview reflects the auto-selected team immediately.
        if (!this.settings.teamId) {
            const dashboardTeam = SDK.getWebContext().team;
            if (dashboardTeam?.id) {
                this.settings.teamId   = dashboardTeam.id;
                this.settings.teamName = dashboardTeam.name || "";
                this.notify();
            }
        }

        // Reflect settings into non-team controls. Team + Backlog dropdowns are
        // populated async by loadTeams() / loadBacklogs() below — they also
        // restore saved selections.
        this.intervalSelect.value      = this.settings.interval;
        this.numIntervalsInput.value   = String(this.settings.numIntervals);
        this.breakdownCheckbox.checked = this.settings.showBreakdown;

        // loadTeams is async — don't await (load() must return quickly for the
        // dashboard SDK). Surface failures inline rather than reject silently.
        this.loadTeams().catch(err => {
            console.error("Throughput config: failed to load teams", err);
            const loadError = document.getElementById("team-load-error") as HTMLElement | null;
            if (loadError) loadError.style.display = "block";
        });
        return Dashboard.WidgetStatusHelper.Success();
    }

    public onSave(): Promise<Dashboard.SaveStatus> {
        if (!this.settings.teamId) {
            this.teamError.style.display = "block";
            return Dashboard.WidgetConfigurationSave.Invalid();
        }
        this.teamError.style.display = "none";
        return Dashboard.WidgetConfigurationSave.Valid({ data: JSON.stringify(this.settings) });
    }

    private notify(): void {
        this.configContext?.notify(
            Dashboard.ConfigurationEvent.ConfigurationChange,
            Dashboard.ConfigurationEvent.Args({ data: JSON.stringify(this.settings) })
        );
    }

    private async loadTeams(): Promise<void> {
        const teams = await getTeams();
        teams.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

        const frag = document.createDocumentFragment();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.text  = "Select a team…";
        frag.appendChild(placeholder);
        for (const team of teams) {
            const opt = document.createElement("option");
            opt.value = team.id;
            opt.text  = team.name;
            frag.appendChild(opt);
        }
        this.teamSelect.innerHTML = "";
        this.teamSelect.appendChild(frag);

        // Restore previously-selected team if it still exists, then cascade
        // into backlog + iteration loads for that team. Run them concurrently
        // — they're independent fetches, both team-scoped.
        if (this.settings.teamId && teams.some(t => t.id === this.settings.teamId)) {
            this.teamSelect.value = this.settings.teamId;
            await Promise.all([
                this.loadBacklogs(this.settings.teamId),
                this.loadIterations(this.settings.teamId)
            ]);
        }
    }

    // Fetch iterations and refresh Sprint-related guidance. Two cases drive
    // the helper text below the Interval row:
    //   1. Team is INELIGIBLE for Sprint at all — show the eligibility hint,
    //      disable the Sprint option, and (if Sprint was the saved interval)
    //      defensively switch the current selection to Month.
    //   2. Team is ELIGIBLE but has fewer started+dated sprints than the
    //      user's numIntervals — show the count caption ("Team has X
    //      sprints with dates").
    private async loadIterations(teamId: string): Promise<void> {
        if (!teamId) {
            this.currentIterations = [];
            this.updateSprintHint();
            return;
        }
        this.currentIterations = await getTeamIterations(teamId);

        // Defensive interval reset: if Sprint is no longer eligible but was
        // the saved value, drop to Month and notify so the dashboard's live
        // preview reflects the change. Without this, browsers render a
        // disabled-but-selected option as confusing empty space, and the
        // data layer would compute an empty windows list.
        if (!isSprintEligible(this.currentIterations) && this.settings.interval === 'Sprint') {
            this.settings.interval    = 'Month';
            this.intervalSelect.value = 'Month';
            this.notify();
        }

        this.updateSprintHint();
    }

    // Set the Sprint option's disabled state + helper text from the cached
    // iterations and current settings. Called after iterations load AND on
    // any change to interval or numIntervals — the count caption depends on
    // both, so we re-evaluate every relevant change.
    private updateSprintHint(): void {
        const eligible = isSprintEligible(this.currentIterations);
        this.sprintOption.disabled = !eligible;

        if (!eligible) {
            // Show the eligibility hint regardless of which interval is
            // currently selected — the user might pick Month/Quarter to work
            // around it but still need to see why Sprint is disabled when
            // they glance back at the dropdown.
            this.intervalHint.textContent = "This team doesn't have an active sprint schedule. Set iteration dates in Project Settings → Iterations, or choose Month or Quarter.";
            this.intervalHint.hidden = false;
            return;
        }

        // Eligible — predictive "Chart will show X of Y sprints" caption,
        // shown only when Sprint is the active interval AND the team has
        // fewer usable sprints than the user requested. Predictive framing
        // avoids the "but I configured N sprints!" confusion that any
        // count-of-sprints framing produces — it makes claims about the
        // chart's output, not about the team's setup.
        //
        // For Month/Quarter the calendar always provides N windows;
        // sparseness in those modes is "no data in old intervals" (which is
        // fine — it's just the team's history), not a calibration concern.
        // Always-plural "sprints" is safe because numIntervals min is 3
        // (HTML input min attribute, enforced by the change handler).
        if (this.settings.interval === 'Sprint') {
            const usable = countUsableDatedSprints(this.currentIterations);
            if (usable < this.settings.numIntervals) {
                this.intervalHint.textContent = `Visual will show ${usable} of ${this.settings.numIntervals} sprints, more as sprints complete.`;
                this.intervalHint.hidden = false;
                return;
            }
        }

        this.intervalHint.hidden = true;
    }

    // Populate the Backlog Level dropdown with backlogs visible to the selected
    // team. Sorted by rank descending so Epic/Feature/portfolio levels appear
    // above the Requirement-level backlog (matches ADO's own Boards UI order).
    // Restores saved selection if still present; otherwise defaults to the
    // lowest-rank (most commonly used) level.
    private async loadBacklogs(teamId: string): Promise<void> {
        if (!teamId) {
            this.backlogSelect.innerHTML = `<option value="">Select a team first</option>`;
            return;
        }
        const backlogs = await getBacklogsForTeam(teamId);
        backlogs.sort((a, b) => (b.rank || 0) - (a.rank || 0));

        const frag = document.createDocumentFragment();
        if (backlogs.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.text  = "No backlogs configured for this team";
            frag.appendChild(opt);
        } else {
            for (const backlog of backlogs) {
                const opt = document.createElement("option");
                opt.value = backlog.id;
                opt.text  = backlog.name;
                frag.appendChild(opt);
            }
        }
        this.backlogSelect.innerHTML = "";
        this.backlogSelect.appendChild(frag);

        // Prefer prior selection if still present on the new team; otherwise
        // default to the requirement-level backlog ("Backlog items" / "Stories"
        // / "PBIs" depending on process template). Requirement level is where
        // throughput is most commonly measured; Task level would be the
        // lowest-rank fallback but is the wrong default for a throughput chart.
        const savedId = this.settings.backlogCategoryReferenceName;
        const matched = savedId ? backlogs.find(b => b.id === savedId) : undefined;
        if (matched) {
            this.backlogSelect.value = matched.id;
            // Refresh cached display name (process template renaming is rare,
            // but free to handle). No notify — the ID didn't change.
            this.settings.backlogCategoryName = matched.name;
        } else if (backlogs.length > 0) {
            // Prefer the requirement-level backlog ("Backlog items" / "Stories"
            // / "PBIs" depending on process template). Identified via the role
            // tag set by getBacklogsForTeam — it's the backlog that came from
            // BacklogConfiguration.requirementBacklog, NOT a property on the
            // entry itself. Falls back to first entry if no requirement-level
            // exists (extremely unusual — would mean team has only portfolio or
            // only task backlogs visible).
            const requirement = backlogs.find(b => b.role === 'requirement');
            const fallback = requirement || backlogs[0];
            this.backlogSelect.value = fallback.id;
            this.settings.backlogCategoryReferenceName = fallback.id;
            this.settings.backlogCategoryName          = fallback.name;
            this.notify();
        }
    }
}

async function init(): Promise<void> {
    const config = new ThroughputWidgetConfig();
    SDK.init();
    await SDK.ready();
    SDK.register("throughput-configuration", config);

    // Resize the config iframe to fit its actual content. Observing #root rather
    // than body: body is pinned to 100% viewport by azure-devops-ui's override,
    // so its size never changes when content grows. #root auto-sizes to children.
    //
    // Minimum 500px gives native <select> pickers room to open downward.
    const root = document.getElementById("root")!;
    const updateSize = () => SDK.resize(400, Math.max(root.offsetHeight + 16, 500));
    new ResizeObserver(updateSize).observe(root);
    updateSize();
}

init();
