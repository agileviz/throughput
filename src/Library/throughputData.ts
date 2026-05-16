import {
    getTeamAreaPaths,
    getTeamIterations,
    getBacklogsForTeam,
    getCompletedStateNamesForTypes,
    queryWorkItemIds,
    getWorkItems,
    getWorkItemUrlPrefix,
    TeamAreaPathRef
} from "./adoLibrary";
import { computeIntervalWindows, IntervalWindow } from "./intervalWindows";
import { ThroughputSettings } from "./widgetSettings";

// Categorical palette for stacked-segment coloring. Deliberately AVOIDS ADO's
// native work-item-type colors — those are designed for icon-accent use, not
// large-area fill use, AND admins can customize them freely (which means
// distinct types might be configured to render visually identical, or
// alarm-loaded reds and bright purples can land on completed-work charts
// where they're semantically wrong). Curated 2026-04-25 through variation G
// of a side-by-side preview kept at tools/palette-preview.html — a portfolio-
// level design tool for any plugin's chart palette decisions.
//
// Slot ordering rationale: blues anchor (slots 0-1), then cool family
// progression (navy → teal → slate, slots 2-4), then a quiet chromatic
// break (mid-muted purple, slot 5), then a neutral tail (warm gray, slot 6
// — only seen when 7+ types stack). Never red, never green, never yellow.
// Saturation decreases as slot rarity increases — common slots anchor
// attention, rare slots stay out of the way.
export const TYPE_PALETTE = [
    '#0092da',  // AgileViz brand blue   — primary type anchor          S:100 L:43
    '#4FC1EA',  // sky blue accent       — typically Bug for Scrum      S:80  L:62
    '#1d4f87',  // true navy             — cool, distinct from brand    S:65  L:32
    '#307991',  // teal                  — desaturated cool              S:50  L:38
    '#4b719b',  // slate blue            — calm cool, chromatic family   S:35  L:45
    '#74579B',  // mid-muted purple      — chromatic break, quiet        S:28  L:47
    '#9e9e9e'   // warm gray             — neutral fallback for 7+ types S:0   L:62
];

// Assign colors to work-item types deterministically. The backlog's primary
// type (per ADO process template — e.g., "Product Backlog Item" for Scrum,
// "User Story" for Agile, "Requirement" for CMMI) gets index 0 (brand blue).
// All other types follow alphabetically. This puts the "main" type in the
// anchor color so the chart visually emphasizes the primary work; secondary
// types like Bug fall to the lighter sky-blue accent.
//
// Process-template-portable: no hardcoded type names. Falls back to pure
// alphabetical if no primary type is provided or if the primary doesn't
// appear in the data.
export function assignTypeColors(
    buckets:           ReadonlyArray<ThroughputBucket>,
    primaryTypeName?:  string
): Record<string, string> {
    const seen = new Set<string>();
    for (const b of buckets) for (const t of b.byType) seen.add(t.name);
    const types = Array.from(seen);

    const sorted = [
        ...(primaryTypeName && seen.has(primaryTypeName) ? [primaryTypeName] : []),
        ...types.filter(t => t !== primaryTypeName).sort((a, b) => a.localeCompare(b))
    ];

    const colors: Record<string, string> = {};
    sorted.forEach((name, idx) => {
        colors[name] = TYPE_PALETTE[idx % TYPE_PALETTE.length];
    });
    return colors;
}

// Single work item, in the shape the chart's TSV export needs. Captured at
// fetch time so the right-click "Copy items" action is instant — no second
// API round-trip on user demand. Fields are kept narrowly to what the
// export uses (id, title, type, state, three lifecycle dates, assignee,
// tags, area path); everything else from ADO's batched work-item response
// is dropped to keep memory footprint modest.
//
// Date fields hold ADO's raw ISO timestamps (e.g., "2026-04-15T08:23:45Z")
// — full precision so the bucketer's ms-timestamp comparison is exact, and
// the TSV writer can truncate to "YYYY-MM-DD" for display without losing
// data. Empty string means the field was absent on the work item (e.g.,
// ActivatedDate on an item that was created and closed without ever moving
// to Active in a non-standard process).
export interface WorkItemRow {
    id:            number;
    title:         string;
    workItemType:  string;
    state:         string;
    createdDate:   string;   // full ISO timestamp; "" if missing
    activatedDate: string;   // full ISO timestamp; "" if never activated
    closedDate:    string;   // full ISO timestamp; non-empty (filtered to non-empty at fetch time)
    assignedTo:    string;   // display name; "" if unassigned
    tags:          string;   // semicolon-separated, as ADO returns
    areaPath:      string;
}

// Per-bucket summary: which interval, total item count, per-type breakdown
// (sorted descending by count), and the underlying items themselves. Slice 2A
// displayed this as text; slice 2B uses byType for stacked bar segments;
// slice 3 (right-click copy) walks `items` to build the TSV export.
//
// isPartial=true when the interval's end is in the future relative to now —
// the bucket represents only the elapsed-so-far portion of its window.
// Used to exclude partial buckets from the mean calculation (a month that's
// 80% elapsed isn't a fair comparison to a complete month) AND to mark the
// in-progress bar visually (diagonal hatching) AND to populate the export's
// Bucket Status column ("Complete" vs "In progress").
export interface ThroughputBucket {
    label:            string;   // the interval's axis label (e.g., "Sprint 47", "Apr 2026")
    windowRangeLabel: string;   // human-readable date range (e.g., "Apr 1 – Apr 14")
    total:            number;
    byType:           Array<{ name: string; count: number }>;
    isPartial:        boolean;
    items:            Array<WorkItemRow>;   // items whose ClosedDate landed in this window
}

export interface ThroughputResult {
    buckets:    Array<ThroughputBucket>;
    totalItems: number;
    windows:    Array<IntervalWindow>;
    // Map of work-item-type name → "#RRGGBB" hex color. Computed deterministically
    // from a categorical AgileViz-brand palette (NOT ADO's native palette — see
    // TYPE_PALETTE above for why).
    typeColors: Record<string, string>;
    // True when interval is Sprint AND no team iteration covers "now"
    // (no iteration where startDate ≤ now ≤ finishDate). Drives the
    // widget's "No current sprint" warning. Always false in Month/Quarter
    // mode — the calendar always has a current month/quarter.
    noCurrentSprint: boolean;
    // URL prefix for individual work items
    // ("https://dev.azure.com/{org}/{project}/_workitems/edit/"). The
    // export's URL column appends each item's id to this. Empty when the
    // host context isn't reachable (e.g., empty-result short-circuit paths
    // that never call ensureProject) — the URL column degrades to id only.
    urlPrefix: string;
}

// Orchestrates the full data pipeline for a given Throughput configuration:
// team area paths + iterations + backlog types + completed-state names →
// WIQL → ID list → batch fetch → interval bucketing → per-bucket summary.
//
// All ADO API calls run in parallel where independent. The pipeline is linear
// from WIQL onward because each step depends on the previous result.
export async function fetchThroughput(settings: ThroughputSettings): Promise<ThroughputResult> {
    // 1. Parallel: team scoping, iterations (for Sprint), backlog config.
    const [areaPaths, iterations, backlogs] = await Promise.all([
        getTeamAreaPaths(settings.teamId),
        settings.interval === 'Sprint' ? getTeamIterations(settings.teamId) : Promise.resolve([]),
        getBacklogsForTeam(settings.teamId)
    ]);

    // No-current-sprint detection. Drives the widget's "⚠ No current sprint"
    // warning. Only meaningful in Sprint mode — Month/Quarter always have a
    // current calendar window, so the concept doesn't apply. Intentionally
    // separate from the config-side eligibility rule (which uses a 60-day
    // staleness window): a configured widget that's been running for months
    // can hit this state the moment the most recent sprint ends without a
    // successor — that's exactly when the user wants to know.
    const noCurrentSprint = settings.interval === 'Sprint' && !iterations.some(it => {
        const start  = it.attributes?.startDate;
        const finish = it.attributes?.finishDate;
        if (!start || !finish) return false;
        const ts = new Date(start).getTime();
        const tf = new Date(finish).getTime();
        const now = Date.now();
        return ts <= now && tf >= now;
    });

    // 2. Find the selected backlog's work-item types and primary type.
    const backlog = backlogs.find(b => b.id === settings.backlogCategoryReferenceName);
    const workItemTypes: string[] = (backlog?.workItemTypes || [])
        .map(t => t.name)
        .filter((n): n is string => !!n);
    const primaryTypeName = backlog?.defaultWorkItemType?.name;

    // URL prefix is needed by the TSV export's URL column. Look it up once
    // here so the right-click action doesn't pay a round-trip; the call is
    // already cached after ensureProject() ran above as part of the parallel
    // step 1 dependencies.
    const urlPrefix = await getWorkItemUrlPrefix();

    if (workItemTypes.length === 0) {
        return { buckets: [], totalItems: 0, windows: [], typeColors: {}, noCurrentSprint, urlPrefix };
    }

    // 3. Compute interval windows.
    const windows = computeIntervalWindows(settings.interval, settings.numIntervals, iterations);
    if (windows.length === 0) {
        return { buckets: [], totalItems: 0, windows: [], typeColors: {}, noCurrentSprint, urlPrefix };
    }

    // 4. Completed-state names (WIQL can't filter by StateCategory).
    const states = await getCompletedStateNamesForTypes(workItemTypes);
    if (states.length === 0) {
        const emptyBuckets = windows.map(emptyBucket);
        return { buckets: emptyBuckets, totalItems: 0, windows, typeColors: assignTypeColors(emptyBuckets, primaryTypeName), noCurrentSprint, urlPrefix };
    }

    // 5. Build + execute WIQL covering the full window range.
    const startDate = windows[0].start;
    const endDate   = windows[windows.length - 1].end;
    const wiql = buildThroughputWiql({ areaPaths, workItemTypes, states, startDate, endDate });
    const ids = await queryWorkItemIds(wiql);

    // 6. Batch-fetch the full WorkItemRow shape. Extra fields land in the
    //    bucket so the right-click TSV export is instant — no second
    //    round-trip when the user copies. Activated and AssignedTo can be
    //    absent (custom processes that skip Active state, unassigned work);
    //    we coerce to "" rather than null/undefined so downstream TSV code
    //    can treat every cell as a string.
    let items: Array<WorkItemRow> = [];
    if (ids.length > 0) {
        // The SDK's WorkItemBatchGetRequest type lists asOf / $expand /
        // errorPolicy as required fields, but the REST endpoint accepts the
        // request without them. Building the object with the optional fields
        // genuinely absent (and asserting the type) is cleaner than threading
        // `undefined as any` per field — the SDK type is overly strict, and
        // we don't want to send the optional fields we have no value for.
        const raw = await getWorkItems({
            ids,
            fields: [
                "System.Id",
                "System.Title",
                "System.WorkItemType",
                "System.State",
                "System.CreatedDate",
                "Microsoft.VSTS.Common.ActivatedDate",
                "Microsoft.VSTS.Common.ClosedDate",
                "System.AssignedTo",
                "System.Tags",
                "System.AreaPath"
            ]
        } as Parameters<typeof getWorkItems>[0]);
        items = raw
            .filter(wi => wi.fields && wi.fields["Microsoft.VSTS.Common.ClosedDate"])
            .map(wi => {
                const f = wi.fields;
                // System.AssignedTo is an IdentityRef object ({displayName, ...})
                // when assigned, absent when not. Narrow to the one field the
                // export needs (displayName) — the full IdentityRef has many
                // more fields that aren't relevant here.
                const assignedRaw = f["System.AssignedTo"] as { displayName?: string } | undefined;
                const assignedTo  = assignedRaw?.displayName ? String(assignedRaw.displayName) : "";
                return {
                    id:            wi.id,
                    title:         (f["System.Title"]                          as string) || "",
                    workItemType:  (f["System.WorkItemType"]                   as string) || "",
                    state:         (f["System.State"]                          as string) || "",
                    createdDate:   (f["System.CreatedDate"]                    as string) || "",
                    activatedDate: (f["Microsoft.VSTS.Common.ActivatedDate"]   as string) || "",
                    closedDate:    (f["Microsoft.VSTS.Common.ClosedDate"]      as string) || "",
                    assignedTo,
                    tags:          (f["System.Tags"]                           as string) || "",
                    areaPath:      (f["System.AreaPath"]                       as string) || ""
                };
            });
    }

    // 7. Bucket into windows, then assign type colors deterministically.
    const buckets = bucketByInterval(items, windows);
    const typeColors = assignTypeColors(buckets, primaryTypeName);
    return { buckets, totalItems: items.length, windows, typeColors, noCurrentSprint, urlPrefix };
}

// Build a WIQL string selecting completed work items in the team's area paths,
// of the given types, with a completion ClosedDate in the window range.
// Pure — no SDK calls, deterministic given inputs.
export function buildThroughputWiql(params: {
    areaPaths:     Array<TeamAreaPathRef>;
    workItemTypes: Array<string>;
    states:        Array<string>;
    startDate:     Date;
    endDate:       Date;
}): string {
    if (params.workItemTypes.length === 0 || params.states.length === 0) {
        // Defensive — shouldn't be called in these states. Return a query
        // that deterministically yields no rows.
        return "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0";
    }

    const areaClauses = params.areaPaths.length === 0
        // No team area paths configured. Rare; don't accidentally grab the
        // whole project — constrain to a non-match.
        ? "[System.Id] = 0"
        : params.areaPaths.map(a => a.includeChildren
            ? `[System.AreaPath] UNDER '${escapeWiql(a.path)}'`
            : `[System.AreaPath] = '${escapeWiql(a.path)}'`
        ).join(' OR ');

    const types  = params.workItemTypes.map(t => `'${escapeWiql(t)}'`).join(', ');
    const states = params.states.map(s => `'${escapeWiql(s)}'`).join(', ');
    const startIso = params.startDate.toISOString();
    const endIso   = params.endDate.toISOString();

    return `SELECT [System.Id] FROM WorkItems
        WHERE (${areaClauses})
          AND [System.WorkItemType] IN (${types})
          AND [System.State] IN (${states})
          AND [Microsoft.VSTS.Common.ClosedDate] >= '${startIso}'
          AND [Microsoft.VSTS.Common.ClosedDate] < '${endIso}'
        ORDER BY [Microsoft.VSTS.Common.ClosedDate] DESC`;
}

function escapeWiql(s: string): string {
    return s.replace(/'/g, "''");
}

// Assign each item to the window its ClosedDate falls into, group by work-item
// type within each window, produce per-bucket summary. Pure (other than reading
// the current time once for the partial flag). The full WorkItemRow rides
// along on each bucket so the right-click TSV export can walk the bucket
// list and emit one row per item without a second pass over the data.
export function bucketByInterval(
    items:   ReadonlyArray<WorkItemRow>,
    windows: Array<IntervalWindow>
): Array<ThroughputBucket> {
    const now = Date.now();
    // Pre-parse closedDate to ms once per item — avoids re-parsing inside the
    // O(windows × items) filter loop below.
    const indexed = items.map(it => ({ row: it, closedAtMs: new Date(it.closedDate).getTime() }));
    return windows.map(w => {
        const winStart = w.start.getTime();
        const winEnd   = w.end.getTime();
        const inBucket = indexed.filter(i => i.closedAtMs >= winStart && i.closedAtMs < winEnd);
        const byType = new Map<string, number>();
        for (const i of inBucket) {
            byType.set(i.row.workItemType, (byType.get(i.row.workItemType) || 0) + 1);
        }
        return {
            label:            w.label,
            windowRangeLabel: formatWindowRange(w),
            total:            inBucket.length,
            byType: Array.from(byType.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([name, count]) => ({ name, count })),
            isPartial:        winEnd > now,
            items:            inBucket.map(i => i.row)
        };
    });
}

function emptyBucket(w: IntervalWindow): ThroughputBucket {
    return {
        label:            w.label,
        windowRangeLabel: formatWindowRange(w),
        total:            0,
        byType:           [],
        isPartial:        w.end.getTime() > Date.now(),
        items:            []
    };
}

function formatWindowRange(w: IntervalWindow): string {
    // "Apr 1 – Apr 14" format. The `end` is exclusive in our model; for display,
    // subtract one millisecond to land on the inclusive last day.
    //
    // Timezone choice depends on the window's basis: Sprint windows use UTC
    // (ADO's iteration date semantics); Month/Quarter windows use the user's
    // local timezone (so "April 2026" boundaries match calendar intuition).
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (w.timeZoneBasis === 'utc') opts.timeZone = 'UTC';
    const fmt = (d: Date) => d.toLocaleString('en-US', opts);
    const endInclusive = new Date(w.end.getTime() - 1);
    return `${fmt(w.start)} – ${fmt(endInclusive)}`;
}
