# CLAUDE.md — Throughput

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project overview

**Throughput** is an Azure DevOps dashboard widget that shows a team's completion trend — work items moved to Done per Sprint, Month, or Quarter. Items are grouped into buckets by **closed date** (not by iteration path), so the visual updates automatically as work completes — no need to set iteration paths or tags. Published to the Visual Studio Marketplace as **`AgileViz.Throughput`**.

Pure TypeScript + DOM — no React, no chart library. Stacked bars are HTML `<div>` flex containers with percentage widths. Tiny bundle, zero framework lock-in inside the ADO iframe.

## Commands

```bash
npm install                    # one-time dependency install
npm test                       # Jest with coverage
npm run test-watch             # Jest --watchAll with coverage
npm run lint                   # ESLint over src/**/*.{ts,tsx}
npm run serve                  # webpack-dev-server on https://localhost:3000 (install the dev VSIX in ADO to test)
npm run build                  # production webpack + tfx VSIX package
npm run build:dev              # dev VSIX (side-by-side install during development)
npm run publish-extension      # publish to ADO Marketplace (needs $ADO_PUBLISH_TOKEN)
npm run publish-extension-dev  # publish the private dev extension
```

`tfx --rev-version` bumps the version on each publish; `npm run sync-version` (called from `postbuild`) keeps `extension.json` and `package.json` in lockstep.

## Repository layout

```
src/
├── Contribs/
│   ├── Config/   # Widget configuration pane (Config.html / Config.tsx / Config.scss / Config.json)
│   └── Widget/   # Dashboard widget (Widget.html / Widget.tsx / Widget.scss / Widget.json)
├── ContribsDev/  # DEV-only contributions used by the dev extension
└── Library/      # adoLibrary, intervalWindows, throughputData, throughputView, widgetSettings
```

Each contribution is an AMD entry point; per-contribution `*.json` manifest fragments are glob-matched by `tfx extension create` against top-level `extension.json`.

## Architecture

Data flow: load settings → resolve project/team via SDK → compute interval windows (Sprint / Month / Quarter) → fetch closed work items in the windowed date range → bucket by `ClosedDate` → render stacked bars by work-item type.

Key files in `src/Library/`:

- **`adoLibrary.ts`** — thin wrappers over ADO REST clients. Each function self-seeds via `ensureProject()` — no implicit ordering contract that requires `queryWorkItemIds()` to run first.
- **`intervalWindows.ts`** — pure date math. Computes the bucket boundaries for Sprint (from team iterations, future-filtered, with the `finishDate + 1` half-open convention), Month, or Quarter. Year-boundary walkback handled. `numIntervals` clamped to `[NUM_INTERVALS_MIN, NUM_INTERVALS_MAX]`.
- **`throughputData.ts`** — `fetchThroughput` orchestrator: WIQL builder (with single-quote escaping in area paths / types / states), `bucketByInterval` boundary semantics, `assignTypeColors` (palette wraparound + determinism so the same type always gets the same color across renders).
- **`throughputView.ts`** — pure render helpers. `applyTypeFilter`, `computeMeanPerInterval`, `computeGlobalTypeOrder` are extracted here so they can be unit-tested without DOM. `buildTsv` has a top-of-function invariant assertion (`result.buckets.length === result.windows.length`) — silent in-loop sentinels caused trust-erosion failures in earlier shapes; loud throw is better.
- **`widgetSettings.ts`** — `sanitizeNumIntervals` + `NUM_INTERVALS_MIN/MAX = 3, 26`. Applied at THREE persistence boundaries: `Config.tsx` load, `Config.tsx` change listener, `Widget.tsx::processSettings`. Out-of-range values fall back to `DEFAULT_SETTINGS.numIntervals` (12) rather than clamping — a saved-100 is more likely a corrupted value than user intent.

Key files in `src/Contribs/`:

- **`Widget/Widget.tsx`** — render loop with a `fetchSeq` monotonic token guarding against rapid config flips (team A → B → C) letting a slow fetch resolve last and clobber the user's current selection with stale data.
- **`Config/Config.tsx`** — config pane. Sprint eligibility uses a no-count-floor rule (new teams with 1 current sprint must be allowed). Iterations cached on the instance for fast re-evaluation when numIntervals/interval changes.

## Testing — AMD stub pattern (important)

`azure-devops-extension-sdk` and `azure-devops-extension-api/*` are AMD-only and crash under Jest's Node runtime. Workaround is an empty stub mapped in via `jest.config.js`:

```js
moduleNameMapper: {
  '^azure-devops-extension-sdk$': '<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts',
  '^azure-devops-extension-api(/.*)?$': '<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts',
}
```

Per-file coverage thresholds live in `jest.config.js` (e.g. `intervalWindows.ts` 100/87.5/100/100, `throughputData.ts` 54/30/65/51 with the `fetchThroughput` orchestrator intentionally exempt and smoke-tested instead, `widgetSettings.ts` 100/100/100/100). When you add tests, raise the floor; don't lower it.

## ADO platform quirks that affect this plugin

- **Native config translation.** Honor ADO-native widget config: area paths with `includeChildren`, iteration paths, work-item types, backlog levels — not parallel invented config knobs. Custom process templates (custom work-item types like Production Issue, Tech Chore) should "just work" because the plugin reads the team's WIT list at runtime.
- **AMD modules everywhere.** See AMD-stub pattern above.
- **Dev-server PNA header.** Chrome blocks loopback iframes loaded into ADO unless the dev server sets `Access-Control-Allow-Private-Network: true`. Already wired in `webpack.config.js` — don't strip it.
- **Contribution IDs use dots, not slashes.** Slash form silently fails to register.
- **Manifest visibility has two axes.** `galleryFlags` controls maturity, top-level `"public": true` controls discoverability in marketplace search. Both need to be right at publish time.
- **`SDK.resize()` behaves differently per host.** Combine with a `ResizeObserver` on the widget root for reliable iframe-height sync.
- **Native `<select>` ignores CSS borders without `appearance: none` + a custom SVG chevron.** Config pane uses this pattern.
- **`IExtensionDataManager.getValue()` is cached** and `deleteDocument()` does NOT bust the cache. To reset, write `DEFAULT` via `setValue` then `deleteDocument`.

## Defensive coding rules

- **Don't embed HTTP response body text into `throw new Error()`.** SonarCloud S5696 (stored XSS via DOM render path) flags it. Also don't fall back to `console.error(body)` — S5145 (log injection) flags that too. Drop the body; status code is sufficient.
- **`buildTsv` invariant**: assert `buckets.length === windows.length` at function entry. Silent in-loop "skip misaligned row" sentinels are a trust-erosion failure mode for data-export features.
- **Race-guard async render paths** with a monotonic seq token captured before the `await`.

## Quality Gate workflow

SonarCloud at `sonarcloud.io/project/overview?id=agileviz_throughput`. Quality Gate badge in `README.md` reflects current `main` scan.

When publishing a new version:

1. Land change on `main`, wait for SonarCloud rescan, verify all four ratings stay A and Quality Gate is **Passed**.
2. Only then `npm run publish-extension`. 10-minute wait beats 30-minute re-publish cycle.
3. SonarCloud's **first scan on a fresh repo or first scan after a long quiet period** can show "Quality Gate Not computed" because there's no baseline delta. A second small commit triggers the computation.

## Product stance

This plugin has **no roadmap**. It does one thing well: completion trend by Sprint / Month / Quarter, with closed-date bucketing. Feature requests get honest pushback if they expand scope.

For bugs or feature requests, open a [GitHub issue](https://github.com/agileviz/throughput/issues) using the appropriate template. Security issues: see `SECURITY.md`.
