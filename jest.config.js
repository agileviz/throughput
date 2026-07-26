module.exports = {
    "roots": [
        "<rootDir>/src"
    ],
    "testMatch": [
        "**/__tests__/**/*.+(ts|tsx|js)",
        "**/?(*.)+(spec|test).+(ts|tsx|js)"
    ],
    "transform": {
        "^.+\\.(ts|tsx)$": "ts-jest"
    },
    // The published azure-devops-extension-sdk and azure-devops-extension-api
    // modules are AMD-only — they call `define(...)` at top level, which throws
    // ReferenceError under Jest's Node runtime. Pure helpers in src/Library/
    // never invoke the SDK at module load time, so an empty stub keeps the
    // import chain quiet without forcing each test file to mock individually.
    "moduleNameMapper": {
        "^azure-devops-extension-sdk$":      "<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts",
        "^azure-devops-extension-api/(.*)$": "<rootDir>/src/Library/__mocks__/ado-sdk-stub.ts"
    },
    // Coverage targets the pure helpers that have unit tests. The Widget /
    // Config DOM code is intentionally excluded — it's covered by the
    // marketplace smoke test, not Jest.
    "collectCoverageFrom": [
        "src/Library/throughputView.ts",
        "src/Library/intervalWindows.ts",
        "src/Library/throughputData.ts",
        "src/Library/widgetSettings.ts"
    ],
    "coveragePathIgnorePatterns": [
        "/node_modules/",
        "/__mocks__/"
    ],
    // Thresholds lock in the gains from launch-prep tests so future PRs
    // can't silently regress them.
    "coverageThreshold": {
        // throughputData.ts mixes pure helpers (well-covered) with the
        // I/O-bound fetchThroughput orchestrator (intentionally exempt
        // from unit testing — covered by the marketplace smoke test).
        // Thresholds sit just under current actual so they lock in
        // launch-prep coverage without false-failing on incidental moves.
        "src/Library/throughputData.ts": {
            "statements": 54,
            // Branches floor re-baselined 30 -> 28 on the 2026-07-25 Jest 29 -> 30
            // upgrade. NOT a coverage regression: babel-plugin-istanbul 7
            // instruments more branches, so the denominator grew 51 -> 58 while
            // covered branches rose 16 -> 17 — the new branches land in the
            // fetchThroughput orchestrator that is exempt from unit testing per
            // the note above, so they arrive uncovered by design. Same tests,
            // stricter counting. The other three files moved the other way under
            // Jest 30 (intervalWindows 87.5 -> 90.9, throughputView 95.45 -> 96.42)
            // and keep their original floors.
            "branches":   28,
            "functions":  65,
            "lines":      51
        },
        "src/Library/intervalWindows.ts": {
            "statements": 90,
            "branches":   85,
            "functions":  100,
            "lines":      90
        },
        "src/Library/throughputView.ts": {
            "statements": 95,
            "branches":   90,
            "functions":  100,
            "lines":      95
        },
        "src/Library/widgetSettings.ts": {
            "statements": 100,
            "branches":   85,
            "functions":  100,
            "lines":      100
        }
    }
};
