import { TeamSettingsIteration } from "azure-devops-extension-api/Work";
import { IntervalType } from "./widgetSettings";

// An interval bucket on the throughput x-axis.
// start is inclusive, end is exclusive (half-open interval).
//
// timeZoneBasis tells the display formatter which timezone to render dates in.
// All three interval types currently use UTC so the widget's bucket boundaries
// match what a hand-built WIQL with date-only filters would return — ADO
// interprets bare date strings as UTC. Sprint dates come from ADO's UTC-stored
// iteration dates; Month/Quarter dates are constructed via Date.UTC().
//
// The field is preserved (rather than dropped) for future flexibility — a
// future "Calendar week" or other interval type might legitimately want local
// timezone alignment, and the formatter would then read this hint to render
// correctly per-window.
//
// Bucketing comparisons (closedDate timestamp vs window timestamps) are
// timezone-agnostic — millisecond comparisons. Only the display label cares.
export interface IntervalWindow {
    start:         Date;
    end:           Date;
    label:         string;
    timeZoneBasis: 'utc' | 'local';
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Compute the set of N interval windows ending at the current date. Pure
// function — no network, no SDK. Takes team iterations as input so Sprint
// bucketing can be computed deterministically from a given iteration list.
export function computeIntervalWindows(
    interval: IntervalType,
    numIntervals: number,
    iterations: Array<TeamSettingsIteration>
): Array<IntervalWindow> {
    const n = Math.max(1, Math.min(numIntervals, 52));
    const now = new Date();

    if (interval === 'Sprint') {
        // Iterations with both start and finish dates. ADO's finishDate is
        // INCLUSIVE (the last day of the sprint), so add a day to convert to
        // the exclusive `end` our bucketing expects. Sort by start ASC, keep
        // iterations whose start <= now (past + current, no future), take
        // the most recent N.
        const dated = iterations
            .filter(it => it.attributes && it.attributes.startDate && it.attributes.finishDate)
            .map(it => ({
                start: new Date(it.attributes.startDate),
                end:   new Date(it.attributes.finishDate),
                label: it.name || ""
            }))
            .sort((a, b) => a.start.getTime() - b.start.getTime());

        const nowTime = now.getTime();
        const notFuture = dated.filter(it => it.start.getTime() <= nowTime);
        const recent = notFuture.slice(-n);
        return recent.map(it => ({
            start:         it.start,
            end:           new Date(it.end.getTime() + DAY_MS),
            label:         it.label,
            timeZoneBasis: 'utc'    // ADO iteration dates are UTC; display in UTC to match ADO's UI
        }));
    }

    if (interval === 'Month') {
        // Walk back from the current UTC month. Use UTC throughout so the
        // widget's "April 2026" boundaries match what a hand-built WIQL with
        // date-only filters (`ClosedDate >= '2026-04-01'`) would return —
        // ADO interprets bare date strings as UTC. Date.UTC handles negative
        // month values by borrowing years (Date.UTC(2026, -2, 1) === Oct 2025).
        const nowYear  = now.getUTCFullYear();
        const nowMonth = now.getUTCMonth();
        const windows: IntervalWindow[] = [];
        for (let i = n - 1; i >= 0; i--) {
            const start = new Date(Date.UTC(nowYear, nowMonth - i, 1));
            const end   = new Date(Date.UTC(nowYear, nowMonth - i + 1, 1));
            const label = start.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
            windows.push({ start, end, label, timeZoneBasis: 'utc' });
        }
        return windows;
    }

    if (interval === 'Quarter') {
        // Same UTC alignment as Month — quarter boundaries match the
        // hand-built WIQL convention.
        const nowYear              = now.getUTCFullYear();
        const currQuarterStartUTC  = Math.floor(now.getUTCMonth() / 3) * 3;
        const windows: IntervalWindow[] = [];
        for (let i = n - 1; i >= 0; i--) {
            const start = new Date(Date.UTC(nowYear, currQuarterStartUTC - i * 3, 1));
            const end   = new Date(Date.UTC(nowYear, currQuarterStartUTC - i * 3 + 3, 1));
            const q     = Math.floor(start.getUTCMonth() / 3) + 1;
            const label = `Q${q} ${start.getUTCFullYear()}`;
            windows.push({ start, end, label, timeZoneBasis: 'utc' });
        }
        return windows;
    }

    return [];
}
