import { TeamSettingsIteration } from "azure-devops-extension-api/Work";
import { computeIntervalWindows, IntervalWindow } from "../intervalWindows";

// Pure date math, no SDK. We pin "now" via Jest's modern fake timers so
// month/quarter walkbacks are deterministic. Sprint tests pin a fake "now"
// too so the future-iteration filter has predictable cutoff semantics.

// Minimal iteration fixture. The function only reads name + attributes.startDate
// + attributes.finishDate, so we cast through `unknown` to skip modeling the
// rest of the heavy SDK type. Dates accept either Date or ISO string — the
// production code calls `new Date(...)` on whatever lands here.
function iter(name: string, start: string, finish: string): TeamSettingsIteration {
    return {
        name,
        id:   name,
        path: `path/${name}`,
        url:  '',
        attributes: {
            startDate:  new Date(start),
            finishDate: new Date(finish),
            timeFrame:  0
        }
    } as unknown as TeamSettingsIteration;
}

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
});

describe("computeIntervalWindows — Sprint", () => {
    test("returns the most recent N iterations whose start is in the past", () => {
        // now = 2026-04-15. Five sprints exist; the last one is fully in the
        // future (start > now) and should be filtered out.
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        const iterations = [
            iter("S1", "2026-01-01", "2026-01-14"),
            iter("S2", "2026-01-15", "2026-01-28"),
            iter("S3", "2026-01-29", "2026-02-11"),
            iter("S4", "2026-04-01", "2026-04-14"),
            iter("S5", "2026-05-01", "2026-05-14")    // future — must be excluded
        ];
        const windows = computeIntervalWindows("Sprint", 3, iterations);
        expect(windows.map(w => w.label)).toEqual(["S2", "S3", "S4"]);
    });

    test("includes a current sprint whose start is past but finish is future", () => {
        // The "current" sprint started before now and finishes after — it
        // belongs in the result. The exclusivity converter (+1 day) lands
        // its end in the future, which is what drives the partial-bucket
        // flag downstream in bucketByInterval.
        jest.setSystemTime(new Date("2026-04-10T00:00:00Z"));
        const iterations = [
            iter("S1", "2026-04-01", "2026-04-14")
        ];
        const windows = computeIntervalWindows("Sprint", 3, iterations);
        expect(windows).toHaveLength(1);
        expect(windows[0].label).toBe("S1");
    });

    test("converts ADO inclusive finishDate to exclusive end (+1 day)", () => {
        // ADO stores finishDate as the LAST day of the sprint. Our windows
        // model is half-open, so end must be one day past the inclusive last
        // day. Without the +1, items closed on the last day would be missed.
        jest.setSystemTime(new Date("2026-04-30T12:00:00Z"));
        const iterations = [iter("S1", "2026-04-01T00:00:00Z", "2026-04-14T00:00:00Z")];
        const [w] = computeIntervalWindows("Sprint", 1, iterations);
        expect(w.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
        expect(w.end.toISOString()).toBe(  "2026-04-15T00:00:00.000Z");
    });

    test("drops iterations with missing dates rather than crashing", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        const valid   = iter("S1", "2026-01-01", "2026-01-14");
        const noStart = { ...iter("S2", "2026-02-01", "2026-02-14"),
                          attributes: { ...valid.attributes, startDate: undefined } } as unknown as TeamSettingsIteration;
        const noEnd   = { ...iter("S3", "2026-03-01", "2026-03-14"),
                          attributes: { ...valid.attributes, finishDate: undefined } } as unknown as TeamSettingsIteration;
        const windows = computeIntervalWindows("Sprint", 5, [valid, noStart, noEnd]);
        expect(windows.map(w => w.label)).toEqual(["S1"]);
    });

    test("returns [] when no iterations are configured", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        expect(computeIntervalWindows("Sprint", 6, [])).toEqual([]);
    });

    test("tags every window timeZoneBasis='utc' so display formatter renders ADO-aligned dates", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        const windows = computeIntervalWindows("Sprint", 1, [iter("S1", "2026-01-01", "2026-01-14")]);
        expect(windows[0].timeZoneBasis).toBe("utc");
    });
});

describe("computeIntervalWindows — Month", () => {
    test("walks back exactly N months ending at the current UTC month", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        const windows = computeIntervalWindows("Month", 4, []);
        expect(windows.map(w => w.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026"]);
    });

    test("crosses a year boundary using Date.UTC's negative-month borrowing", () => {
        // now = Feb 2026. Walking back 4 months should land in Nov 2025,
        // exercising Date.UTC's behavior for negative month indices.
        jest.setSystemTime(new Date("2026-02-15T12:00:00Z"));
        const windows = computeIntervalWindows("Month", 4, []);
        expect(windows.map(w => w.label)).toEqual(["Nov 2025", "Dec 2025", "Jan 2026", "Feb 2026"]);
    });

    test("each window is a half-open [start, end) UTC month interval", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        const [w] = computeIntervalWindows("Month", 1, []);
        expect(w.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
        expect(w.end.toISOString()).toBe(  "2026-05-01T00:00:00.000Z");
    });
});

describe("computeIntervalWindows — Quarter", () => {
    test("aligns to UTC quarter boundaries (Q2 starts April 1)", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        const [w] = computeIntervalWindows("Quarter", 1, []);
        expect(w.label).toBe("Q2 2026");
        expect(w.start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
        expect(w.end.toISOString()).toBe(  "2026-07-01T00:00:00.000Z");
    });

    test("walks back exactly N quarters across a year boundary", () => {
        // now = Q1 2026. Walking back 3 should land Q3 2025.
        jest.setSystemTime(new Date("2026-02-15T12:00:00Z"));
        const windows = computeIntervalWindows("Quarter", 3, []);
        expect(windows.map(w => w.label)).toEqual(["Q3 2025", "Q4 2025", "Q1 2026"]);
    });
});

describe("computeIntervalWindows — numIntervals clamping", () => {
    test("clamps numIntervals=0 up to 1", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        expect(computeIntervalWindows("Month", 0, [])).toHaveLength(1);
    });

    test("clamps numIntervals=53 down to 52", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        expect(computeIntervalWindows("Month", 53, [])).toHaveLength(52);
    });

    test("treats negative numIntervals as 1", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        expect(computeIntervalWindows("Month", -10, [])).toHaveLength(1);
    });
});

describe("computeIntervalWindows — unknown interval", () => {
    test("returns [] for an unknown interval string (defensive)", () => {
        jest.setSystemTime(new Date("2026-04-15T12:00:00Z"));
        // Cast around the IntervalType union to exercise the fallthrough.
        const windows = computeIntervalWindows("Year" as never, 4, []);
        expect(windows).toEqual<IntervalWindow[]>([]);
    });
});
