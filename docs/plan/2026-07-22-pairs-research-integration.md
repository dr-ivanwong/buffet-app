# Pairs research integration: the analyser gains the quant sleeve

**Date:** 2026-07-22
**Status:** pinned 2026-07-22 as the pairs sleeve's build contract (owner decision of the same day, main plan §12 entry 17; this document joins the authority set in CLAUDE.md's plan table). Companion to the pairs trading plan (2026-07-22), which keeps governing the strategy itself (universe, capital, stops, criteria, the go/no-go gate), and the hedge fund gap plan (2026-07-18), which stays outside the authority set. Slice 0 landed with the pinning: the charter entry, the two non-goal amendments, ADR 0005, and the CLAUDE.md pass; §6 records how each pinned decision bends or stands. Of §10's questions, the rail name ships as drafted (Pairs) and the pinning question is answered by this status line; halt alerting stays open ahead of live capital, and the backtest-surface split stands as drafted.

**The questions it answers.** The owner asked three things on 2026-07-22: what must be built for Plainsight to serve as the research component of the pairs trading system; whether Plainsight's scope should expand to hold both disciplines, so the same person learns fundamentals research and proceeds from there to the pairs programme; and whether the plan's Python scripts should convert to something else. §1 answers all three in brief; the rest is the reasoning, the architecture, and the staging.

## 1. The three answers

**Expand the scope: yes as surfaces, no as signals.** One product, one operator, two disciplines. Plainsight gains a Pairs area (three routes: research, backtest, live) rendered in the same design language, reading the same backend, holding the same audit posture: every number reproducible by hand, provenance one tap away. What it does not gain is any blending of the disciplines' logic: the fundamentals engine never emits trading signals, and the pairs engine never touches the metric dictionary. The bridge between them is §2's join: fundamentals qualify pairs, statistics select them. The expansion needs a charter entry in the main plan's decision log and two non-goal amendments (§6); until those are pinned, nothing lands.

**What must be built: four things.** The engine package (the pairs plan's Python, hardened from scripts into a tested package under `quant/`); the artefact contract (versioned JSON reports the engine writes and the app reads, schema-validated on both sides); a thin transport (two API routes on the existing stacks, artefacts into the existing uploads bucket and table); and the surfaces (the rail gains one top-level Pairs item; three routes; the four panels the owner expects, mapped in §4). The staging in §7 orders these so the pairs plan's Weeks 1–2 research can start immediately and every panel is proven against paper-trading artefacts before real capital arrives.

**The Python question: keep Python, contain it.** The statistical core (cointegration testing, half-life estimation, backtesting) and the broker loop stay Python: statsmodels and the Interactive Brokers client libraries have no TypeScript peers, and the pairs plan's own warning binds here: live signals must come from the same code path the backtest measured, or the live system trades a different strategy from the tested one. Splitting that path across two languages manufactures exactly that risk. What changes is the container, not the language: a real package with pinned dependencies, deterministic seeded tests, golden fixtures in calc-engine's spirit, and CI. Everything the owner sees stays TypeScript. The repository's one-language stance (main plan §5, cdk spec §9) is real, so the deviation is recorded as an ADR, not slipped in. Full reasoning in §5.

## 2. Two disciplines, one honest bridge

Value investing from statements and statistical arbitrage from price series are different epistemologies, and this plan does not pretend otherwise. Cointegration is a property of prices; no margin trend or return on capital enters the spread. The integration is honest because the join runs the other way:

- **Fundamentals qualify, statistics select.** A pair enters the tradeable set on statistical evidence (cointegration p-value, half-life, backtest survival). Fundamentals act as a veto and a lens: both legs sit in the library, so the research surface can show each candidate's sector identity (the pinned vocabulary), its fired red flags, and its dashboard one tap away. A spread between two businesses the owner would not individually own on statement quality is a spread worth declining; a cointegration break often has a fundamental story, and the library is where that story already lives.
- **The learning path the owner described is the product's shape.** The analyser teaches reading statements; the Owner's lens extends to the sleeve's concepts (what cointegration means, why spreads revert, what a z-score is, why costs decide marginal strategies), in the same education framing, never advising. The user who has learned to read two balance sheets is exactly the user who should be qualifying pairs of them.
- **The data spine is shared with the fund direction.** The hedge fund gap plan's first stage takes a licence for single-exchange EOD data behind the adapter interface the manual-price decision reserved (main plan §12 entry 1). The pairs sleeve needs the same feed years earlier and two names at a time. The licence bought for the sleeve is the first tranche of that stage, not a second subscription.

## 3. The boundary that makes it safe: the engine acts, the app observes

One invariant does most of the safety work: **the app never trades and never writes sleeve data.** All sleeve writes originate in the engine; the app renders artefacts. Concretely:

- Order placement, position keeping, and the reconcile-before-trade halt live in the engine and the broker, exactly as the pairs plan specifies. The kill switch is the engine's scheduler and the TWS session, not a button in a web UI. A browser tab can go stale, be duplicated, or be left open on another machine; none of those states can move money.
- The live panel renders the reconciliation outcome loudly (clean, or halted with the mismatch itemised), and the absence of a fresh daily report is itself a surfaced state, never silent. The sync-staleness grammar the app already speaks covers this.
- The whole sleeve is end-of-day by construction. Signals compute from stored daily closes (the pairs plan forbids live quotes against close-based statistics), so the app renders EOD artefacts and the not-real-time posture survives: no streaming, no intraday freshness, no market-terminal content.

## 4. Architecture: engine, artefacts, surfaces

### The engine package

`quant/pairs-engine`, a uv-managed Python package beside the pnpm workspace (not inside it). Contents are the pairs plan's phases, restructured: a data module (EOD download, dividend-adjusted closes, the full-window refresh rule), a research module (cointegration scan over the training window, half-life, the frozen-holdout protocol), a backtest module (costs, stops, stand-down, the training and holdout runs), and the two live jobs (nightly compute, morning execute with reconcile-first). Test regime mirrors calc-engine's discipline scaled to purpose: seeded determinism everywhere, golden fixtures (a synthetic cointegrated series with hand-computable spread, z-score, and stop transitions; a known divergent series that must never signal), a regression test per bug found, and a CI job running the suite. The engine holds its secrets (data key, broker session, Cognito refresh token) in local configuration on the operator's machine, the same trust domain that already holds the IB login; nothing enters the client bundle or the repo.

### The artefact contract

Four artefact kinds, versioned and stamped with the engine version and run date, defined twice and tested against each other: pydantic models where they are written, Zod schemas in `packages/api-contract` where they are read (the repository rule: Zod validates every boundary).

| Artefact | Written by | Carries |
|---|---|---|
| Pair scan report | research module, weekly or on demand | universe, every tested pair's p-value, half-life, correlation; the candidate set with hedge ratios |
| Backtest report | backtest module, per candidate set | per-pair equity series, trade list, cost assumptions, training and holdout results kept separate |
| Daily pairs report | nightly compute job | per deployed pair: trailing spread window, z-score, bands, target and held units, stand-down state; book-versus-broker reconciliation outcome; daily and cumulative P&L, drawdown, realised costs |
| Weekly monitoring report | weekly job | re-run cointegration tests on live pairs, rolling statistics, pair-to-pair correlation, tracking error of live P&L against the engine replayed on the same closes |

The daily report embeds the trailing spread window (roughly the lookback plus context, per pair), so the app never needs raw vendor data and the licence stays a single-machine, personal-use question. Scan and backtest reports land as objects in the existing uploads bucket (under a durable `pairs/` prefix, outside the seven-day uploads lifecycle) with a run row per run date in the table; ISO dates sort, so the latest is the first row of a descending query. The daily and weekly reports are small enough to live as table items directly.

### Transport

Two routes on the existing API stack, behind the existing Cognito authoriser: an authenticated PUT per artefact kind (engine, idempotent by run date) and a GET for latest-plus-history (app). No new stacks, no new AWS services, nothing on the not-list touched. The app reads through TanStack Query with cached-last rendering and a staleness stamp; offline shows the last-fetched artefacts marked stale. The sleeve deliberately skips Dexie: the analyser's offline write-queue exists because the owner authors data there; the sleeve's client authors nothing, so a query cache is the whole requirement. That narrow deviation from the Dexie-binds-UI convention is called out here so it is a decision, not drift.

### The surfaces

The rail gains one top-level item, Pairs, between Compare and Settings, gated the way Compare already is: it appears once sleeve artefacts exist. Mobile keeps the stack; the sleeve is desktop-first by the operator's own workflow, and a Library entry point can follow later. Routes and panels:

| Route | Screen | Panels (the owner's expected four, placed) |
|---|---|---|
| `/pairs` | Research | Correlation and cointegration matrix over the scanned universe; candidate table with hedge ratio, half-life, p-value; per-candidate fundamentals join: sector identity, both legs' red-flag state, links to each company dashboard and to Compare |
| `/pairs/backtest` | Backtest | per-pair equity curve with training and holdout visually separated; trade list; cost and stop assumptions beside outcomes; the selection filters as stated criteria, not buttons |
| `/pairs/live` | Live book | Spread and z-score panel per deployed pair (bands at entry, exit, and stop; stand-down flagged); leg execution and imbalance tracker (target versus held units per leg, fills, realised slippage against the modelled cost, reconciliation outcome with halt banner); risk and P&L summary (daily and cumulative P&L against the engine's tracking, drawdown against the declared limit, gross exposure by leg, stops fired, costs realised versus modelled) |

Everything renders with the components and conventions already in the house: tabular numerals, the trend chart and sparkline family, delta chips, status values for not-meaningful states, sheets addressed by query params so system back closes them, semantic colour reserved for meaning (a breached band or a halted reconciliation is what red is for). Each panel keeps the tap-to-derivation discipline: a z-score opens its window, mean, deviation, and closes; a P&L figure opens its legs and fills. Route chunks stay lazy, so the analyser's bundle pays nothing.

## 5. The language question in full

**What Python is load-bearing for.** Engle-Granger and the unit-root tests (statsmodels is the reference implementation; a TypeScript rewrite would be a numerical-correctness project with no user-visible payoff and real silent-wrongness risk), the research loops (pandas), and the broker session (the maintained IB client libraries are Python; the TypeScript alternatives are thin and less proven). The decisive argument is the one-code-path rule: backtest and live must share the signal arithmetic, and that code sits next to the statistics that fit it.

**What TypeScript keeps.** Every surface, the artefact schemas on the read side, the API routes, and any display-side arithmetic, under the existing rules (typed not-meaningful states, no NaN reaching the UI, formatting as a final step).

**What is deliberately not built.** A TypeScript statistics library, a Node broker integration, and any second implementation of the signal rule in any language. If a display needs a number the engine knows, the engine puts it in an artefact.

**The record.** A short ADR (Python for the quant engine) records the deviation from the plans' one-language stance, states the boundary (Python ends where artefacts are written; artefact schemas are the contract; no Python in any serving path), and notes the containment (uv-pinned dependencies, seeded tests, CI). The ADR habit exists precisely so this is a priced decision, not an accretion.

## 6. Decision impact register

| Decision | Disposition under this proposal |
|---|---|
| Non-goal: not a brokerage or trading tool | Splits. "No order execution" survives absolutely (the §3 invariant: the app never trades). "No portfolio P&L tracking against live prices" bends to EOD P&L rendering of the owner's own systematic book, from artefacts, never live quotes. Amended wording lands with the charter entry |
| Non-goal: not real-time | Stands untouched. The sleeve is close-to-close by design; sub-day freshness is still never needed |
| Main plan §12 entry 1 (manual price entry) | Stands for the analyser. The sleeve's closes live engine-side behind its own data module, which becomes the first tranche of the adapter interface entry 1 reserved; no company price record changes meaning |
| Main plan §12 entry 5 (single-user personal tool) | Stands. Same seat, same pool, same quotas |
| Main plan §12 entry 12 (instrument panel, not market terminal) | Stands and is served: the sleeve is dense figures and EOD charts, no quotes, news, or movers |
| Never buy/sell copy rule (main plan non-goals; §9 risk table) | Scoped as the hedge fund gap plan's register proposed: research and education surfaces keep the rule as house style; the sleeve's live surfaces describe the system's own targets, positions, and limits, advising no one. Disclaimer copy extends to the sleeve |
| 12-card dashboard budget (data-model §12) | Stands. The sleeve adds surfaces, not cards; the company dashboard is untouched |
| Backend as source of truth (main plan §12 entry 9) | Stands and is extended: artefacts are server-truth, the client renders a synchronised read-only copy |
| Nothing in the client serving path calls a model | Stands. The engine is deterministic statistics, runs offline on the operator's machine, and no sleeve request touches any model |
| Dexie live queries bind UI to IndexedDB | Narrow recorded deviation for the sleeve only (§4 transport): read-only artefacts ride the query cache; the analyser's data layer is untouched |
| cdk not-list, zero VPC, SSM-only secrets (ADRs 0001–0004) | Untouched. No new services, no VPC, engine secrets stay on the operator's machine |
| Item codes stay in their documents (main plan §12 entry 8) | Stands; this document cites by section and writes meanings |

## 7. Staging

Slices in the house increment style: each lands alone, shows something, and is checked in before the next.

| Slice | Contents | Exit criteria |
|---|---|---|
| 0. The record | Charter entry in the main plan's decision log; the two non-goal amendments; the Python ADR; this document pinned or superseded | The decisions §6 lists as bending are bent on paper, nowhere else |
| 1. The engine stands up | `quant/pairs-engine` package; data and research modules; the scan runs on the licensed feed and writes pair scan artefacts locally; CI runs the Python suite. *(Landed 2026-07-22: the package, the frozen-holdout scan, the artefact writer, a seeded offline suite, and the quant CI job; the first live fetch and scan await the owner's data key, the runbook's pairs first-scan section.)* | The pairs plan's Weeks 1–2 outputs exist as versioned artefacts from a tested package, reproducible from a clean checkout |
| 2. The contract and the pipe | Artefact schemas in `packages/api-contract` (Zod) mirrored against pydantic; the two API routes; artefacts land in the bucket and table. *(Landed 2026-07-22: the Zod mirror pinned to an engine-written golden fixture byte for byte, the two authenticated routes with prefix-scoped grants, the durable `pairs/` keyspace, and the engine's publish command; the live read-back awaits the owner's refresh token, the runbook's pairs publish step.)* | A scan run on the operator's machine is readable from the API seconds later; schema drift fails a test, not a render |
| 3. The research surface | Pairs rail item and `/pairs`; the matrix and candidate table; the fundamentals join (sector, red flags, dashboard and Compare links). *(Landed 2026-07-22: the rail item behind the device's pairs-seen memory in `meta`, the candidate table with the join, the matrix with both measures, the pair sheet as the derivation surface, and the query-cache read with its staleness stamped; verified in the browser against a stubbed API and by the suite. Frontend spec §1.1, §1.2, §3, §5 to §7 and §9 amended the same day.)* | The owner qualifies or declines a candidate pair without leaving the app, and every statistic on screen opens its derivation |
| 4. The backtest surface | Backtest module artefacts; `/pairs/backtest`; equity curves with training and holdout separated. *(Landed 2026-07-22: the engine's backtest module on the shared signal rule (signals.py, the one code path slice 5's live jobs reuse), the backtest artefact kind through the pipe (the transport's routes generalised to a kind segment, both golden fixtures byte-pinned), and the surface: picker, assumptions and stated criteria, the per-window equity chart with the holdout shaded, the gate-by-gate verdict, and the round-trip list. The rail's Pairs group gains its sections. Verified in the browser against a stubbed API and by every suite.)* | A pair's go or no-go reads from the screen the way the pairs plan's criteria state it, and the holdout is visibly untouched by selection |
| 5. The live surface, on paper | The two live jobs against the paper login (pairs plan Weeks 5–8); `/pairs/live` with all three live panels. *(Landed 2026-07-30: the shared signal rule refactored to a stepped state machine both backtest and live consume; the compute job marking the book and writing targets plus the daily artefact; the execute job behind a broker protocol, reconcile-first with the halt written into the book and the artefact (the ib_async adapter is the optional live extra); the weekly monitor; the daily and weekly kinds through the pipe with byte-pinned fixtures from a forty-day scripted paper run; and `/pairs/live` with the three panels, the halt alert, and the staleness warning, verified in the browser and by suite. The engine-side scripted run stands in for the four paper weeks until the owner's IB paper login exists; the halt drill is the runbook's step 5.)* | Four weeks of paper artefacts render cleanly; a forced book-versus-broker mismatch halts the engine and the halt renders loudly; staleness states proven |
| 6. Live proof of concept | Real capital per the pairs plan's Week 9 gate; no new UI, real artefacts through proven panels | The pairs plan's own weekly criteria, read off the live surface |

The ordering is deliberate: the panels are debugged against paper-trading artefacts in slice 5, so by the time money moves, the only new thing is the money.

## 8. Costs

The engine's data plan is already priced in the pairs plan (AUD 50–100 a month, plus the broker's market-data feed, confirmed in its Week 1). The infrastructure delta rounds to zero: existing bucket, existing table, existing API and authoriser, two routes and some read units inside the free-tier headroom the account already watches with tag-scoped budgets. No LLM spend exists anywhere in the sleeve. The real cost is operator time, and slice 0 through slice 3 is deliberately the smallest stretch that makes the research phase usable in the app.

## 9. What this does not commit

The hedge fund gap plan's stages (universe-wide extraction, factor store, the portfolio and risk domains) stay separately gated; this sleeve shares their data licence direction and nothing else of their scope. No server-side scheduling of the engine's jobs (local cron is the POC posture; an EventBridge-driven compute job is a later slice with its own costing). No signal automation in the app, ever, under §3's invariant. No universe beyond the pairs plan's ASX set. Nothing about outside capital: that gate, its licensing terms, and its structure remain the pairs plan's own sections.

## 10. Open questions for the owner

1. **The rail name.** "Pairs" is precise and modest; "Trading" claims more than the surfaces do. Proposed: Pairs. *(Standing as drafted at pinning, 2026-07-22; recorded in the charter entry.)*
2. **Backtest surface timing.** Slice 4 could compress into slice 5 if the owner is content reading backtest CSVs during validation; the split above assumes the screen earns its keep during pair selection.
3. **Halt alerting.** The halt renders in-app and staleness is loud, but no push channel exists. Wiring the engine to the existing alert topic (an SNS publish on halt) is a small later slice; is it wanted before live capital, or is the daily panel check the pairs plan already prescribes sufficient for the POC?
4. **Pinning.** If this direction is right, the next artefact is the slice 0 record: the charter entry, the non-goal amendments, and the Python ADR, at which point CLAUDE.md's current-state paragraph learns about the sleeve in the same change. *(Done 2026-07-22: main plan §12 entry 17, ADR 0005, and the CLAUDE.md pass landed together as slice 0.)*
