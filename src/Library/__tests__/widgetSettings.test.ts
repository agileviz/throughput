import {
    sanitizeNumIntervals,
    DEFAULT_SETTINGS,
    NUM_INTERVALS_MIN,
    NUM_INTERVALS_MAX
} from "../widgetSettings";

// Persistence-boundary sanitizer for numIntervals. Applied at every spot
// where a saved value enters the runtime (Config.load, Config.change,
// Widget.processSettings) so a corrupted dashboard JSON can't reach the
// runtime clamp in computeIntervalWindows.

describe("sanitizeNumIntervals", () => {
    test("accepts integers within the [3, 26] UI range", () => {
        expect(sanitizeNumIntervals(3)).toBe(3);
        expect(sanitizeNumIntervals(12)).toBe(12);
        expect(sanitizeNumIntervals(26)).toBe(26);
    });

    test("snaps fractional inputs to the truncated integer when in range", () => {
        // A non-integer would be unusual but possible if a future schema
        // change inadvertently let a float through. Truncation is the
        // safer choice over rejecting outright — the user's intent is
        // closer to floor(n) than to the default.
        expect(sanitizeNumIntervals(12.7)).toBe(12);
        expect(sanitizeNumIntervals(3.1)).toBe(3);
    });

    test("falls back to the default when the value is below the minimum", () => {
        expect(sanitizeNumIntervals(0)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(2)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(-5)).toBe(DEFAULT_SETTINGS.numIntervals);
    });

    test("falls back to the default when the value is above the maximum", () => {
        // Choice point: clamp to MAX vs fall back to default. Default is
        // safer because a saved 100 is more likely a corrupt value than a
        // user's deliberate "I want 100 intervals" intent — and falling
        // back gives a stable, recognizable view.
        expect(sanitizeNumIntervals(27)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(100)).toBe(DEFAULT_SETTINGS.numIntervals);
    });

    test("rejects NaN, Infinity, and -Infinity", () => {
        expect(sanitizeNumIntervals(NaN)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(Infinity)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(-Infinity)).toBe(DEFAULT_SETTINGS.numIntervals);
    });

    test("rejects non-number types (string, null, undefined, object)", () => {
        // The 'unknown' parameter type is intentional — the function exists
        // because corrupted saved JSON can put anything into the field.
        expect(sanitizeNumIntervals("12")).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals("abc")).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(null)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(undefined)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals({})).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals([])).toBe(DEFAULT_SETTINGS.numIntervals);
    });

    test("the exported MIN/MAX constants stay in sync with the sanitizer's behavior", () => {
        // Belt-and-suspenders: if a future contributor changes MIN/MAX, this
        // test guarantees the sanitizer's thresholds move in lockstep, since
        // both are read from the same exported constants.
        expect(sanitizeNumIntervals(NUM_INTERVALS_MIN)).toBe(NUM_INTERVALS_MIN);
        expect(sanitizeNumIntervals(NUM_INTERVALS_MAX)).toBe(NUM_INTERVALS_MAX);
        expect(sanitizeNumIntervals(NUM_INTERVALS_MIN - 1)).toBe(DEFAULT_SETTINGS.numIntervals);
        expect(sanitizeNumIntervals(NUM_INTERVALS_MAX + 1)).toBe(DEFAULT_SETTINGS.numIntervals);
    });
});
