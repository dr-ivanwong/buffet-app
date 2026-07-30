# pairs-engine

The Plainsight pairs sleeve's quant engine. The build contract is [the pairs research integration plan](../../docs/plan/2026-07-22-pairs-research-integration.md); the language decision is [ADR 0005](../../docs/adr/0005-python-for-the-quant-engine.md). The division of labour is one sentence: this package computes and writes artefacts; the app renders them, never trades, and never writes sleeve data. Nothing here is imported by any serving path.

## What exists (slice 1)

- **Data module**: end-of-day adjusted closes for the audited fifty-ticker ASX universe (audited 2026-07-22 against the ASX listed-companies directory; re-run that audit after any gap), cached one CSV per ticker. The refresh rule is whole-window replacement, never append: adjustment factors move on every ex-dividend date, and an appended raw close silently mixes two series.
- **Research module**: the Engle-Granger scan over every pair, on the frozen training window only. The final fifth of the calendar is the holdout; it stays untouched until the backtest's validation step and is used exactly once. Hedge ratio by ordinary least squares on the same window; half-life from the lagged-spread regression with the pairs plan's validity band. The candidate gate is stricter than nominal significance: significance, a valid half-life inside the tradeable band, and a positive hedge ratio.
- **Signals module** (slice 4): the position rule as one code path, entry, exit band, z-stop, time stop and stand-down, consumed by the backtest over history and by the live jobs when their slice lands. Splitting that arithmetic is the live-trades-a-different-strategy risk the plan warns against.
- **Backtest module** (slice 4): the plan's Week 3 engine and Week 4 holdout, verbatim in accounting: dollar P&L per spread unit, costs per side on the gross notional of every entry and exit, borrow on the short leg, metrics off the dollar equity curve. The holdout warm-starts with the last lookback days of training, scores only true holdout days, and is spent once.
- **The artefacts**: versioned camelCase JSON, one report kind per file (`pair-scan-<runDate>.json`, `backtest-<runDate>.json`), mirrored by the Zod schemas in `packages/api-contract` and byte-pinned to the committed golden fixtures.

The live jobs are later slices of the contract's staging, deliberately absent here.

## Commands

From this directory, with [uv](https://docs.astral.sh/uv/):

```
uv sync
uv run pytest
```

The first live fetch and scan (the vendor key lives in the environment only, never in a file):

```
EODHD_API_KEY=... uv run pairs-engine fetch
uv run pairs-engine scan
uv run pairs-engine backtest
```

`fetch` refreshes the whole five-year window for all fifty tickers and aborts loudly, all failures listed, if any ticker is missing: a downloader that skips failures quietly shrinks the universe. `scan` reads the cache, freezes the split, runs the statistics, and writes `artefacts/pair-scan-<runDate>.json`. Both `data/` and `artefacts/` are operator-local working state, ignored by git.

Publishing to the app's API (slice 2) rides the same environment-only rule: `PLAINSIGHT_API_URL`, `PLAINSIGHT_COGNITO_CLIENT_ID` and `PLAINSIGHT_COGNITO_REFRESH_TOKEN`, then `uv run pairs-engine publish` (`--kind` picks among `pair-scan`, `backtest`, `daily` and `weekly`). The refresh token is minted once via the runbook's pairs publish step; the PUT is idempotent by run date, and artefacts travel in this direction only (the app renders and never writes sleeve data).

The live jobs (slice 5) run the paper cycle: `init-live` scaffolds the deployed-pairs config from the newest backtest, `compute` marks the book nightly and writes targets plus the daily artefact through the same stepped signal rule the backtest measured, `execute` reconciles against the broker first and halts with no orders on any mismatch (`clear-halt` is the human's reset), and `weekly` writes the monitoring artefact. The broker adapter needs `uv sync --extra live` (ib_async) and a running TWS or IB Gateway; the runbook's paper-cycle section carries the steps and the halt drill.

## Determinism and tests

Same cached closes, same statistics, byte for byte; `generatedAt` is the only field that moves between reruns over the same inputs. The suite plants what it asserts: a synthetic cointegrated pair with a known hedge ratio and mean-reversion speed that the scan must recover, independent walks that must never become candidates, a hand-computed least-squares fit, and an end-to-end scan whose tested-plus-skipped counts reconcile exactly. Seeded throughout; no network anywhere in the tests.

## Licensing

The EOD data plan is personal-use; its terms, the tripwires at any scale-up, and the vendor pricing live in the pairs trading plan (Week 1, data licensing). Nothing in this package redistributes vendor data: artefacts carry derived statistics, and the raw close cache never leaves the operator's machine in this slice.
