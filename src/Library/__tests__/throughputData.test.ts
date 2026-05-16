import {
    buildThroughputWiql,
    bucketByInterval,
    assignTypeColors,
    TYPE_PALETTE,
    WorkItemRow,
    ThroughputBucket
} from "../throughputData";
import { IntervalWindow } from "../intervalWindows";
import { TeamAreaPathRef } from "../adoLibrary";

// Pure helpers in throughputData.ts — no SDK calls in these code paths, so
// no mocking required. The orchestrator fetchThroughput is intentionally
// not covered here; it's I/O-heavy and better exercised by smoke testing
// against a real ADO project.

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

function window(start: string, end: string, label = ""): IntervalWindow {
    return { start: new Date(start), end: new Date(end), label, timeZoneBasis: "utc" };
}

function bucket(byType: Array<[string, number]>): ThroughputBucket {
    return {
        label:            "B",
        windowRangeLabel: "B",
        total:            byType.reduce((s, [, c]) => s + c, 0),
        byType:           byType.map(([name, count]) => ({ name, count })),
        isPartial:        false,
        items:            []
    };
}

describe("buildThroughputWiql", () => {
    const baseParams = {
        areaPaths:     [{ path: "Org\\Team",     includeChildren: true  }] as Array<TeamAreaPathRef>,
        workItemTypes: ["Bug"],
        states:        ["Closed"],
        startDate:     new Date("2026-04-01T00:00:00Z"),
        endDate:       new Date("2026-05-01T00:00:00Z")
    };

    test("emits UNDER for area paths with includeChildren=true", () => {
        const wiql = buildThroughputWiql(baseParams);
        expect(wiql).toContain("[System.AreaPath] UNDER 'Org\\Team'");
        expect(wiql).not.toContain("[System.AreaPath] = 'Org\\Team'");
    });

    test("emits = for area paths with includeChildren=false", () => {
        const wiql = buildThroughputWiql({
            ...baseParams,
            areaPaths: [{ path: "Org\\Team", includeChildren: false }]
        });
        expect(wiql).toContain("[System.AreaPath] = 'Org\\Team'");
        expect(wiql).not.toContain("UNDER");
    });

    test("ORs together multiple area paths", () => {
        const wiql = buildThroughputWiql({
            ...baseParams,
            areaPaths: [
                { path: "Org\\TeamA", includeChildren: true  },
                { path: "Org\\TeamB", includeChildren: false }
            ]
        });
        expect(wiql).toContain("[System.AreaPath] UNDER 'Org\\TeamA' OR [System.AreaPath] = 'Org\\TeamB'");
    });

    test("returns the deterministic empty-result sentinel when workItemTypes is empty", () => {
        const wiql = buildThroughputWiql({ ...baseParams, workItemTypes: [] });
        expect(wiql).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0");
    });

    test("returns the deterministic empty-result sentinel when states is empty", () => {
        const wiql = buildThroughputWiql({ ...baseParams, states: [] });
        expect(wiql).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0");
    });

    test("constrains to a non-match when no team area paths are configured (avoids accidentally grabbing the whole project)", () => {
        const wiql = buildThroughputWiql({ ...baseParams, areaPaths: [] });
        expect(wiql).toContain("[System.Id] = 0");
        expect(wiql).not.toContain("UNDER");
        expect(wiql).not.toContain("[System.AreaPath]");
    });

    test("escapes single quotes in area paths to prevent WIQL injection", () => {
        // ADO's WIQL escaping convention is doubling the single quote, same
        // as SQL. A team named "O'Brien's Org" must not be able to break
        // out of the string literal.
        const wiql = buildThroughputWiql({
            ...baseParams,
            areaPaths: [{ path: "O'Brien's Org", includeChildren: true }]
        });
        expect(wiql).toContain("UNDER 'O''Brien''s Org'");
    });

    test("escapes single quotes in work-item type names", () => {
        const wiql = buildThroughputWiql({
            ...baseParams,
            workItemTypes: ["Dev's Item"]
        });
        expect(wiql).toContain("'Dev''s Item'");
    });

    test("escapes single quotes in state names", () => {
        const wiql = buildThroughputWiql({
            ...baseParams,
            states: ["Won't Fix"]
        });
        expect(wiql).toContain("'Won''t Fix'");
    });

    test("emits ISO timestamps for date filters with the >= start, < end half-open convention", () => {
        const wiql = buildThroughputWiql(baseParams);
        expect(wiql).toContain("[Microsoft.VSTS.Common.ClosedDate] >= '2026-04-01T00:00:00.000Z'");
        expect(wiql).toContain("[Microsoft.VSTS.Common.ClosedDate] < '2026-05-01T00:00:00.000Z'");
    });

    test("orders results by ClosedDate descending (newest first)", () => {
        const wiql = buildThroughputWiql(baseParams);
        expect(wiql).toMatch(/ORDER BY \[Microsoft\.VSTS\.Common\.ClosedDate\] DESC/);
    });
});

describe("bucketByInterval", () => {
    const RealDateNow = Date.now;
    afterEach(() => { Date.now = RealDateNow; });

    test("places items into the window whose half-open interval contains their closedDate", () => {
        Date.now = () => new Date("2026-05-01T00:00:00Z").getTime();
        const items = [
            row({ id: 1, closedDate: "2026-04-05T00:00:00Z" }),
            row({ id: 2, closedDate: "2026-04-25T00:00:00Z" }),
            row({ id: 3, closedDate: "2026-03-30T00:00:00Z" })
        ];
        const windows = [
            window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "Mar"),
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")
        ];
        const buckets = bucketByInterval(items, windows);
        expect(buckets[0].items.map(i => i.id)).toEqual([3]);
        expect(buckets[1].items.map(i => i.id)).toEqual([1, 2]);
    });

    test("an item closed exactly at window.start belongs to that window (start is inclusive)", () => {
        Date.now = () => new Date("2026-05-01T00:00:00Z").getTime();
        const items = [row({ id: 1, closedDate: "2026-04-01T00:00:00Z" })];
        const windows = [
            window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "Mar"),
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")
        ];
        const buckets = bucketByInterval(items, windows);
        expect(buckets[0].total).toBe(0);
        expect(buckets[1].total).toBe(1);
    });

    test("an item closed exactly at window.end falls OUT of that window (end is exclusive)", () => {
        Date.now = () => new Date("2026-05-15T00:00:00Z").getTime();
        const items = [row({ id: 1, closedDate: "2026-05-01T00:00:00Z" })];
        const windows = [
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")
        ];
        const buckets = bucketByInterval(items, windows);
        expect(buckets[0].total).toBe(0);
    });

    test("drops items whose closedDate falls outside every window", () => {
        Date.now = () => new Date("2026-05-01T00:00:00Z").getTime();
        const items = [
            row({ id: 1, closedDate: "2026-01-15T00:00:00Z" }),  // before any window
            row({ id: 2, closedDate: "2026-06-15T00:00:00Z" })   // after every window
        ];
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")];
        const buckets = bucketByInterval(items, windows);
        expect(buckets[0].total).toBe(0);
    });

    test("byType is sorted by count descending", () => {
        Date.now = () => new Date("2026-05-01T00:00:00Z").getTime();
        const items = [
            row({ id: 1, workItemType: "Bug" }),
            row({ id: 2, workItemType: "PBI" }),
            row({ id: 3, workItemType: "PBI" }),
            row({ id: 4, workItemType: "PBI" }),
            row({ id: 5, workItemType: "Bug" })
        ].map(r => ({ ...r, closedDate: "2026-04-15T00:00:00Z" }));
        const windows = [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")];
        const [b] = bucketByInterval(items, windows);
        expect(b.byType).toEqual([
            { name: "PBI", count: 3 },
            { name: "Bug", count: 2 }
        ]);
    });

    test("isPartial=true when the window's end is in the future relative to now", () => {
        Date.now = () => new Date("2026-04-15T00:00:00Z").getTime();
        const windows = [
            window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "Mar"),   // end < now → complete
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")    // end > now → partial
        ];
        const buckets = bucketByInterval([], windows);
        expect(buckets[0].isPartial).toBe(false);
        expect(buckets[1].isPartial).toBe(true);
    });

    test("preserves the full WorkItemRow on the bucket so the right-click TSV export can read it without a re-fetch", () => {
        Date.now = () => new Date("2026-05-01T00:00:00Z").getTime();
        const item = row({ id: 42, title: "Specific item", assignedTo: "Bob", tags: "p1" });
        const buckets = bucketByInterval([item], [window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")]);
        expect(buckets[0].items[0]).toEqual(item);
    });

    test("emits one bucket per window, in window order, even when several windows are empty", () => {
        Date.now = () => new Date("2026-05-01T00:00:00Z").getTime();
        const windows = [
            window("2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z", "Feb"),
            window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "Mar"),
            window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z", "Apr")
        ];
        const items = [row({ id: 1, closedDate: "2026-04-15T00:00:00Z" })];
        const buckets = bucketByInterval(items, windows);
        expect(buckets.map(b => b.label)).toEqual(["Feb", "Mar", "Apr"]);
        expect(buckets.map(b => b.total)).toEqual([0, 0, 1]);
    });
});

describe("assignTypeColors", () => {
    test("assigns slot 0 to the primary type, alphabetical for the rest", () => {
        const buckets = [bucket([["Bug", 5], ["Aardvark", 1], ["PBI", 3]])];
        const colors = assignTypeColors(buckets, "PBI");
        expect(colors).toEqual({
            PBI:        TYPE_PALETTE[0],
            Aardvark:   TYPE_PALETTE[1],
            Bug:        TYPE_PALETTE[2]
        });
    });

    test("falls back to pure alphabetical when no primary type is provided", () => {
        const buckets = [bucket([["Zebra", 1], ["Aardvark", 1], ["Mongoose", 1]])];
        const colors = assignTypeColors(buckets);
        expect(colors).toEqual({
            Aardvark:  TYPE_PALETTE[0],
            Mongoose:  TYPE_PALETTE[1],
            Zebra:     TYPE_PALETTE[2]
        });
    });

    test("falls back to pure alphabetical when the primary type is not present in the data", () => {
        // The configured primary might have been deleted from the process
        // template — should degrade gracefully, not corrupt the assignment.
        const buckets = [bucket([["Bug", 1], ["Aardvark", 1]])];
        const colors = assignTypeColors(buckets, "Ghost");
        expect(colors).toEqual({
            Aardvark:  TYPE_PALETTE[0],
            Bug:       TYPE_PALETTE[1]
        });
    });

    test("wraps around the palette when more than 7 types appear", () => {
        // 8 types — slot 7 wraps to slot 0. Confirms modulo behavior so a
        // future palette extension (or pathological process template) doesn't
        // crash.
        const types: Array<[string, number]> = ["a", "b", "c", "d", "e", "f", "g", "h"]
            .map((n, i) => [n, i + 1] as [string, number]);
        const colors = assignTypeColors([bucket(types)]);
        expect(colors["a"]).toBe(TYPE_PALETTE[0]);
        expect(colors["g"]).toBe(TYPE_PALETTE[6]);
        expect(colors["h"]).toBe(TYPE_PALETTE[0]);   // wraps
    });

    test("produces deterministic output across runs (no Set iteration order leakage)", () => {
        const buckets = [bucket([["Bug", 1], ["PBI", 1], ["Tech Chore", 1]])];
        const a = assignTypeColors(buckets, "PBI");
        const b = assignTypeColors(buckets, "PBI");
        expect(a).toEqual(b);
    });

    test("returns an empty record when buckets carry no types", () => {
        expect(assignTypeColors([])).toEqual({});
        expect(assignTypeColors([bucket([])])).toEqual({});
    });
});
