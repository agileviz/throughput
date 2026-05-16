export type IntervalType = 'Sprint' | 'Month' | 'Quarter';

export interface ThroughputSettings {
    teamId: string;
    teamName: string;
    backlogCategoryReferenceName: string;
    backlogCategoryName: string;
    interval: IntervalType;
    numIntervals: number;
    // When true, bars are stacked by work-item type (team-dashboard view —
    // shows mix as well as volume). When false, bars are unified brand blue
    // (report-out view — emphasizes total volume only). Both states use the
    // AgileViz palette; the toggle controls information density, not color
    // system. Default ON because the team-dashboard use case is primary.
    // Existing saved settings without this field get the default via the
    // { ...DEFAULT_SETTINGS, ...saved } spread in Config/Widget.
    showBreakdown: boolean;
}

export const DEFAULT_SETTINGS: ThroughputSettings = {
    teamId: '',
    teamName: '',
    // Empty on fresh install — Config's loadBacklogs() picks the team's
    // requirement-level backlog ("Backlog items" / "Stories" / "PBIs" etc.
    // depending on process template) as the default once a team is chosen.
    backlogCategoryReferenceName: '',
    backlogCategoryName: '',
    interval: 'Sprint',
    numIntervals: 12,
    showBreakdown: true
};

// User-facing numIntervals bounds. Tighter than the runtime clamp in
// computeIntervalWindows([1, 52]) — that wider range exists only to defang
// a corrupted value during execution. The UI contract is 3 to 26, applied
// at every persistence boundary (Config load, Config change) so a bad
// value can't reach the runtime clamp via a corrupted saved widget JSON,
// an older-version migration, or a manual REST edit of the dashboard.
export const NUM_INTERVALS_MIN = 3;
export const NUM_INTERVALS_MAX = 26;

// Returns a valid numIntervals: an integer in [MIN, MAX], or
// DEFAULT_SETTINGS.numIntervals if the input is non-finite, non-numeric,
// or out of range. Uses the default rather than clamping so an obviously
// bad input (NaN, undefined, "100") doesn't silently masquerade as a
// reasonable user choice.
export function sanitizeNumIntervals(n: unknown): number {
    if (typeof n !== "number") return DEFAULT_SETTINGS.numIntervals;
    if (!Number.isFinite(n))   return DEFAULT_SETTINGS.numIntervals;
    const i = Math.trunc(n);
    if (i < NUM_INTERVALS_MIN || i > NUM_INTERVALS_MAX) return DEFAULT_SETTINGS.numIntervals;
    return i;
}
