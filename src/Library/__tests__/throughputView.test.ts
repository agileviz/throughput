import {
    applyTypeFilter,
    computeMeanPerInterval,
    computeGlobalTypeOrder,
    buildTsv,
    countVisibleItems,
    TSV_HEADERS
} from "../throughputView";
import { ThroughputBucket, ThroughputResult, WorkItemRow } from "../throughputData";
import { IntervalWindow } from "../intervalWindows";

// Test fixture builder. Mirrors the shape produced by the bucketing pass
// in throughputData.ts. Tests stay readable by naming intent rather than
// hand-rolling object literals.
function bucket(label: string, byType: Array<[string, number]>, isPartial = false, items: Array<WorkItemRow> = []): ThroughputBucket {
    return {
        label,
        windowRangeLabel: label,
        total:            byType.reduce((s, [, c]) => s + c, 0),
        byType:           byType.map(([name, count]) => ({ name, count })),
        isPartial,
        items
    };
}

function row(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
    return {
        id:            1,
        title:         "Sample item",
        workItemType:  "Bug",
        state:         "Closed",
        createdDate:   "2026-04-01T10:00:00Z",
        activatedDate: "2026-04-02T11:00:00Z",
        closedDate:    "2026-04-10T15:00:00Z",
        assignedTo:    "Alice",
        tags:          "p1; backend",
        areaPath:      "Org\\Team",
        ...overrides
    };
}

function window(start: string, end: string, label: string): IntervalWindow {
    return {
        start: new Date(start),
        end:   new Date(end),
        label,
        timeZoneBasis: 'utc'
    };
}

function result(buckets: Array<ThroughputBucket>, windows: Array<IntervalWindow>, urlPrefix = "https://dev.azure.com/org/proj/_workitems/edit/"): ThroughputResult {
    return {
        buckets,
        totalItems: buckets.reduce((s, b) => s + b.items.length, 0),
        windows,
        typeColors: {},
        noCurrentSprint: false,
        urlPrefix
    };
}

describe("applyTypeFilter", () => {
    test("empty filter returns the same buckets unchanged", () => {
        const buckets = [
            bucket("Sprint 1", [["Bug", 3], ["PBI", 5]]),
            bucket("Sprint 2", [["Bug", 1], ["PBI", 2]])
        ];
        const result = applyTypeFilter(buckets, new Set());
        expect(result).toEqual(buckets);
    });

    test("hiding one type removes its byType entries and recomputes totals", () => {
        const buckets = [bucket("Sprint 1", [["Bug", 3], ["PBI", 5], ["Tech Chore", 2]])];
        const result = applyTypeFilter(buckets, new Set(["Bug"]));
        expect(result[0].byType).toEqual([
            { name: "PBI",        count: 5 },
            { name: "Tech Chore", count: 2 }
        ]);
        expect(result[0].total).toBe(7);
    });

    test("hiding all types yields empty byType and zero total", () => {
        // The widget's floor rule prevents a user from reaching this state via
        // the UI, but the math should still hold cleanly — no NaN, no negatives.
        const buckets = [bucket("Sprint 1", [["Bug", 3], ["PBI", 5]])];
        const result = applyTypeFilter(buckets, new Set(["Bug", "PBI"]));
        expect(result[0].byType).toEqual([]);
        expect(result[0].total).toBe(0);
    });

    test("preserves isPartial and label across the transform", () => {
        const buckets = [bucket("Sprint 7 (current)", [["Bug", 2]], true)];
        const result = applyTypeFilter(buckets, new Set());
        expect(result[0].isPartial).toBe(true);
        expect(result[0].label).toBe("Sprint 7 (current)");
    });
});

describe("computeMeanPerInterval", () => {
    test("averages over fully-elapsed non-empty buckets", () => {
        const buckets = [
            bucket("Sprint 1", [["Bug", 4]]),         // total 4
            bucket("Sprint 2", [["Bug", 6]]),         // total 6
            bucket("Sprint 3", [["Bug", 8]])          // total 8
        ];
        expect(computeMeanPerInterval(buckets)).toBe(6);
    });

    test("excludes empty buckets so pre-history zeros don't drag down the mean", () => {
        const buckets = [
            bucket("Sprint 1", []),                   // empty — excluded
            bucket("Sprint 2", [["Bug", 10]]),        // total 10
            bucket("Sprint 3", [["Bug", 14]])         // total 14
        ];
        expect(computeMeanPerInterval(buckets)).toBe(12);
    });

    test("excludes partial buckets when there's at least one full+non-empty bucket", () => {
        const buckets = [
            bucket("Sprint 1", [["Bug", 10]]),
            bucket("Sprint 2 (current)", [["Bug", 3]], true)   // partial — excluded
        ];
        expect(computeMeanPerInterval(buckets)).toBe(10);
    });

    test("falls back to non-empty buckets (including partial) when nothing else is available", () => {
        // Brand-new team: only the in-progress sprint has any data. The headline
        // would otherwise show 0, which is misleading.
        const buckets = [
            bucket("Sprint 1 (current)", [["Bug", 4]], true)
        ];
        expect(computeMeanPerInterval(buckets)).toBe(4);
    });

    test("returns 0 when every bucket is empty", () => {
        const buckets = [
            bucket("Sprint 1", []),
            bucket("Sprint 2", [])
        ];
        expect(computeMeanPerInterval(buckets)).toBe(0);
    });

    test("integrates with applyTypeFilter — filtering a type recomputes the mean", () => {
        // The whole point of the filter feature: hiding a type should change
        // the headline scalar to reflect the user's filtered view.
        const buckets = [
            bucket("Sprint 1", [["Bug", 4], ["PBI", 6]]),     // total 10 → 4 with PBI hidden
            bucket("Sprint 2", [["Bug", 8], ["PBI", 4]])      // total 12 → 8 with PBI hidden
        ];
        const filtered = applyTypeFilter(buckets, new Set(["PBI"]));
        expect(computeMeanPerInterval(filtered)).toBe(6);
    });
});

describe("computeGlobalTypeOrder", () => {
    test("sorts types by total count across all buckets, descending", () => {
        const buckets = [
            bucket("Sprint 1", [["Bug", 3], ["PBI", 5]]),
            bucket("Sprint 2", [["Bug", 4], ["PBI", 2], ["Tech Chore", 1]])
        ];
        // Totals: PBI=7, Bug=7, Tech Chore=1. Bug and PBI tie → name as tiebreaker.
        expect(computeGlobalTypeOrder(buckets)).toEqual(["Bug", "PBI", "Tech Chore"]);
    });

    test("uses name as a stable tiebreaker so the order is deterministic", () => {
        const buckets = [
            bucket("Sprint 1", [["Zebra", 2], ["Aardvark", 2]])
        ];
        expect(computeGlobalTypeOrder(buckets)).toEqual(["Aardvark", "Zebra"]);
    });

    test("returns empty array when no buckets have any types", () => {
        expect(computeGlobalTypeOrder([])).toEqual([]);
        expect(computeGlobalTypeOrder([bucket("Sprint 1", [])])).toEqual([]);
    });

    test("includes types that appear only in some buckets", () => {
        const buckets = [
            bucket("Sprint 1", [["Bug", 3]]),
            bucket("Sprint 2", [["PBI", 1]])
        ];
        expect(computeGlobalTypeOrder(buckets)).toEqual(["Bug", "PBI"]);
    });
});

describe("buildTsv", () => {
    test("emits a header row with all 15 columns in the locked order", () => {
        const tsv = buildTsv(result([], []), new Set());
        const headers = tsv.split('\n')[0].split('\t');
        expect(headers).toEqual([...TSV_HEADERS]);
        expect(headers).toHaveLength(15);
    });

    test("emits one row per item, joined by newlines", () => {
        const items = [
            row({ id: 100, title: "Fix login redirect" }),
            row({ id: 101, title: "Add CSV export"     })
        ];
        const buckets = [bucket("Apr 2026", [["Bug", 2]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows), new Set());
        const lines = tsv.split('\n');
        expect(lines).toHaveLength(3);   // header + 2 rows
        expect(lines[1]).toContain("100");
        expect(lines[2]).toContain("101");
    });

    test("truncates ISO timestamps to YYYY-MM-DD in date columns", () => {
        const items = [row({
            createdDate:   "2026-04-01T10:00:00.123Z",
            activatedDate: "2026-04-02T11:00:00Z",
            closedDate:    "2026-04-10T15:00:00Z"
        })];
        const buckets = [bucket("Apr 2026", [["Bug", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows), new Set());
        const cells = tsv.split('\n')[1].split('\t');
        expect(cells[4]).toBe("2026-04-01");   // Created Date
        expect(cells[5]).toBe("2026-04-02");   // Activated Date
        expect(cells[6]).toBe("2026-04-10");   // Closed Date
    });

    test("Bucket End Date is the inclusive last day (window.end - 1ms)", () => {
        // Window end is exclusive ("2026-05-01"), so End Date column should
        // read "2026-04-30" — matching the chart's "Apr" labeling.
        const items = [row()];
        const buckets = [bucket("Apr 2026", [["Bug", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows), new Set());
        const cells = tsv.split('\n')[1].split('\t');
        expect(cells[8]).toBe("2026-04-01");   // Bucket Start Date
        expect(cells[9]).toBe("2026-04-30");   // Bucket End Date — inclusive
    });

    test("Bucket Status reads 'Complete' for full buckets and 'In progress' for partials", () => {
        const items = [row({ id: 1 }), row({ id: 2 })];
        const buckets = [
            bucket("Mar 2026", [["Bug", 1]], false, [items[0]]),
            bucket("Apr 2026", [["Bug", 1]], true,  [items[1]])
        ];
        const windows = [
            window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "Mar 2026"),
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")
        ];
        const tsv = buildTsv(result(buckets, windows), new Set());
        const lines = tsv.split('\n');
        expect(lines[1].split('\t')[10]).toBe("Complete");
        expect(lines[2].split('\t')[10]).toBe("In progress");
    });

    test("strips tabs/CR/LF from titles and tags so cells stay on one line", () => {
        // A title with embedded TAB or LF would otherwise break Excel's
        // column / row parsing for every row that follows.
        const items = [row({
            title: "Multi\nline\ttitle\rwith breaks",
            tags:  "p1\tbackend\nurgent"
        })];
        const buckets = [bucket("Apr 2026", [["Bug", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows), new Set());
        const cells = tsv.split('\n')[1].split('\t');
        expect(cells[1]).toBe("Multi line title with breaks");
        expect(cells[12]).toBe("p1 backend urgent");
        expect(tsv.split('\n')).toHaveLength(2);  // header + 1 row, no extra rows from breaks
    });

    test("respects the legend filter — hidden types are omitted from the output", () => {
        const items = [
            row({ id: 1, workItemType: "Bug" }),
            row({ id: 2, workItemType: "PBI" }),
            row({ id: 3, workItemType: "Bug" })
        ];
        const buckets = [bucket("Apr 2026", [["Bug", 2], ["PBI", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows), new Set(["Bug"]));
        const lines = tsv.split('\n');
        expect(lines).toHaveLength(2);   // header + 1 PBI row
        expect(lines[1].split('\t')[0]).toBe("2");
    });

    test("URL column appends the item ID to the prefix", () => {
        const items = [row({ id: 12345 })];
        const buckets = [bucket("Apr 2026", [["Bug", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows, "https://dev.azure.com/org/proj/_workitems/edit/"), new Set());
        const cells = tsv.split('\n')[1].split('\t');
        expect(cells[13]).toBe("https://dev.azure.com/org/proj/_workitems/edit/12345");
    });

    test("URL column degrades to bare ID when prefix is empty", () => {
        // Empty-result short-circuit paths in fetchThroughput don't carry a
        // URL prefix; the row should still export usefully.
        const items = [row({ id: 7 })];
        const buckets = [bucket("Apr 2026", [["Bug", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows, ""), new Set());
        const cells = tsv.split('\n')[1].split('\t');
        expect(cells[13]).toBe("7");
    });

    test("empty Activated Date stays empty (not 'undefined' or 'null')", () => {
        const items = [row({ activatedDate: "" })];
        const buckets = [bucket("Apr 2026", [["Bug", 1]], false, items)];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        const tsv = buildTsv(result(buckets, windows), new Set());
        const cells = tsv.split('\n')[1].split('\t');
        expect(cells[5]).toBe("");
    });

    test("throws loudly when buckets and windows are misaligned", () => {
        // The previous in-loop sentinel silently dropped misaligned rows from
        // the export — that's a trust-erosion failure mode. Asserting at the
        // top converts a would-be invisible data-loss bug into a loud failure
        // that the right-click handler in Widget.tsx surfaces as "Couldn't
        // copy". Mismatch shouldn't be possible from any fetchThroughput
        // return path (all four pair them) but is cheap to defend against.
        const buckets = [
            bucket("Apr 2026", [["Bug", 1]], false, [row()]),
            bucket("May 2026", [["Bug", 1]], false, [row()])
        ];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr 2026")];
        // Use the 2-bucket / 1-window pairing directly (the result helper
        // doesn't enforce alignment, so this is the test's vector).
        const misaligned = result(buckets, windows);
        expect(() => buildTsv(misaligned, new Set())).toThrow(/length mismatch/);
    });

    test("happy path proves the invariant assertion doesn't false-trigger on a balanced result", () => {
        // Sanity check on the assertion's pickiness — exact-match lengths
        // (including 0/0 from empty-result short-circuits) must pass.
        expect(() => buildTsv(result([], []), new Set())).not.toThrow();
        const buckets = [bucket("Apr", [["Bug", 1]], false, [row()])];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")];
        expect(() => buildTsv(result(buckets, windows), new Set())).not.toThrow();
    });
});

describe("countVisibleItems", () => {
    test("sums items across buckets, excluding hidden types", () => {
        const buckets = [
            bucket("Apr", [["Bug", 1], ["PBI", 1]], false, [
                row({ id: 1, workItemType: "Bug" }),
                row({ id: 2, workItemType: "PBI" })
            ]),
            bucket("May", [["Bug", 1]], false, [row({ id: 3, workItemType: "Bug" })])
        ];
        const r = result(buckets, [
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr"),
            window("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z", "May")
        ]);
        expect(countVisibleItems(r, new Set())).toBe(3);
        expect(countVisibleItems(r, new Set(["Bug"]))).toBe(1);
        expect(countVisibleItems(r, new Set(["Bug", "PBI"]))).toBe(0);
    });
});
