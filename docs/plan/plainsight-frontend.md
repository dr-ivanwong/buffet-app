# Frontend Specification: Routes, Screens, States & First-Run

**Companion to:** `plainsight.md` (design language, §4; frontend architecture, §5) and `plainsight-data-model.md` (every value rendered here). **Status:** Draft for owner review · **Date:** 2026-07-10
**Purpose:** the build contract for Phase 1–3 UI work. The main plan pins the design language (type scale, spacing, colour, motion); this document pins *what exists*: every route, every screen, every screen's empty/loading/error states, and the component and hook inventories. If a state can occur, its rendering is specified here; "we'll figure out the empty state later" is how craft dies.

---

## 1. Information architecture

### 1.1 Routes

| Route | Screen | Lazy chunk | Notes |
|---|---|---|---|
| `/` | S2 Library | shell | Root of the navigation stack; a true first launch lands on its true-empty state (S1 removed 2026-07-22, main plan §12 entry 18) |
| `/company/:id` | S3 Dashboard | dashboard (incl. Recharts) | `?metric=roe` opens S4 detail sheet; `?details=1` the company details sheet (2026-07-19, main plan §12 entry 16) |
| `/company/:id/entry` | S5 Data entry | entry | `?job=:jobId` renders S6 review mode |
| `/company/:id/thesis` | S8 Thesis | thesis | `?history=1` opens version list |
| `/compare?ids=a,b,c` | S7 Compare | compare | 2–4 comma-separated company ids |
| `/settings` | S9 Settings root | settings | |
| `/settings/providers` | S10 Providers (BYOK) | settings | |
| `/settings/data` | S11 Data & storage | settings | |
| `/pairs` | S13 Pairs research | pairs | `?pair=AAA-BBB` opens the pair sheet; `?view=` picks the matrix measure (added 2026-07-22, pairs research integration plan §4) |
| `/pairs/backtest` | S14 Pairs backtest | pairs | `?pair=AAA-BBB` focuses one backtested pair (added 2026-07-22, integration plan §4, slice 4) |
| `/pairs/live` | S15 Pairs live book | pairs | `?pair=AAA-BBB` focuses one deployed pair's spread panel (added 2026-07-30, integration plan §4, slice 5) |

**Router: TanStack Router.** Chosen for fully typed routes and, decisively, **typed search params**: since sheets and modals encode their state in query params (below), `?metric=roe` and `?job=:jobId` become typed contracts the compiler checks rather than strings the runtime parses.

**URL rules.** Everything needed to render a screen is recoverable from URL + IndexedDB: every route is bookmarkable and PWA-relaunch-safe. **Sheets and modals encode in query params** (`?metric=`, `?history=`, `?job=`) so the system back button/gesture closes them instead of exiting the screen; Android back-button correctness is a launch requirement, not a polish item.

### 1.2 Navigation model

Stack-based, Library at root. Top bar per screen: back affordance, title, at most one contextual action. Compare and Settings are reached from the Library toolbar; **no persistent tab bar**, deliberately: two of the three top-level areas are visited occasionally, and a tab bar would spend ~49pt of every mobile screen on low-frequency destinations. Desktop uses the same single centred column (720px content width; 960px for S3 and S7) with no sidebar in v1. This is a focused instrument, not a dashboard sprawl. *(Amended 2026-07-18, twice, with the desktop rail slices, main plan §12.10 and §12.11: at ≥1200px a persistent 200px navigation rail sits left of the content column on every screen except the welcome flow. It carries the top-level destinations (Library; Compare once two companies exist, §3's progressive rule; Settings) and, inside a company, the company's name and its three sections: Dashboard, Data entry, Thesis, with the active item marked throughout. At that breakpoint the rail owns wayfinding and per-screen top-bar navigation duplicates recede; titles, actions, and the autosave status line stay put. Below the breakpoint the stack is untouched, and the mobile tab-bar refusal stands.)* *(Amended 2026-07-22, pairs research integration plan §4: Pairs joins the top-level destinations between Compare and Settings once this device has seen sleeve artefacts on the API, the same progressive spirit as Compare's rule; the memory is the `pairsSeen` flag in `meta`, kept current both ways by S13's reads, and the route stays reachable by URL regardless.)* *(Amended 2026-07-22 with slice 4: on the sleeve's own routes the rail lists a Pairs group with its sections, Research and Backtest, the company-group pattern; Live joined 2026-07-30 with slice 5.)* *(Amended 2026-07-22 with S1's removal, main plan §12 entry 18: the rail sits on every screen; the welcome-flow exception is retired.)*

## 2. Global chrome and cross-cutting states

- **Offline indicator:** a small "Offline" pill appears in the top bar *only* on screens where an online-only affordance was hidden (S2's ticker import, S5's file import, S10). Elsewhere, offline is silent: it's a normal operating mode, not an alarm.
- **Error boundaries** per feature region (per main plan §5): friendly message, retry, and an "Export my data" escape hatch. A crashed chart never takes down a grid holding unsaved keystrokes.
- **Quarantine surface:** records failing Zod-on-read appear as a badge + row in S11, never as a crash.
- **iOS install explainer:** on iOS Safari when not installed, a one-time dismissible card on S2 states the real reason plainly ("iOS deletes this app's data after 7 days of non-use unless it's added to your Home Screen"). Re-surfaceable from S11's storage status. Never modal, never nagging.
- **Autosave feedback:** no toasts. A quiet "Saved · just now" ticker in the S5/S8 header. Toast queues are where calm interfaces go to die.

## 3. Screen inventory

Format per screen: purpose → key elements → states. Design language per main plan §4 throughout.

### S1: First-run (removed)

*Removed 2026-07-22 (main plan §12 entry 18).* The three-pane welcome shipped with Phase 1 and carried a promise pane, a data-residency pane, and a choose-your-start pane; all three duties already lived elsewhere by the time it was retired. A true first launch lands on S2's true-empty state, which carries the same promise and the same starting actions; the data-residency claims are stated and pinned by test in S9's sync group; and importing a file is reached through the library's import affordances and S5's upload sheet. The code S1 stays reserved so the later screens keep their numbers.

### S2: Library

Purpose: calm home; one row per company (name, ticker/exchange badge, red-flag dot count, the watchlist figure (latest ROE with its coloured delta, added 2026-07-22), last-updated, 10-yr ROE microsparkline). 64px rows, separation by spacing.

| State | Rendering |
|---|---|
| True empty (first run) | Hero empty state: one-line promise + two buttons, "Add a company" (accented) and "See it with sample data" |
| Populated | Rows grouped under quiet sector section headers, last-updated within a section; "+ Add" in toolbar *(amended 2026-07-19, below; previously one flat last-updated list)* |
| Sample data present | Sample rows carry a quiet "Sample" chip; one-line dismissible banner links to S11 removal |
| >12 companies | A filter field appears (progressive: invisible until useful) |
| Loading | None in steady state (Dexie live queries are ~ms); skeleton rows only on cold service-worker start |
| Signed in, first catch-up in flight, empty cache | Placeholder rows (64px, quiet, motionless) with a screen-reader status line, never the true-empty hero: an empty cache on a device that has never synced is not yet an empty library. The hero returns when the first pull lands empty or fails (catch-up serves the cache). Amendment 2026-07-18 with the reads-behind-the-API slice (main plan §12.9) |
| Screener picked, ≥900px | The table replaces the sectioned rows (added 2026-07-22, finance-look gap plan §5): companies as rows; ticker, latest FY, ROE, net margin, debt-to-equity, flag count and the ROE microsparkline as columns; header buttons sort client-side (figures biggest-first on the first press, absent values last); degenerate cells speak short forms with full phrases as accessible names; the name cell opens the dashboard. The screen borrows the wide column while the screener is on (§7). The rows-or-table choice persists in `meta`; below 900px the rows always render, whatever it says |

**Sector sections (added 2026-07-19, main plan §12 entry 16).** Companies group under the pinned vocabulary's section labels (companion §12 D3) in vocabulary order, styled as the dashboard grid's quiet section labels (dashboard design plan §5.2); within a section, the last-updated sort stands. Unclassified companies gather under a closing "Unclassified" section whose header renders only when a classified section also renders: a library where nothing is classified reads exactly as before, one flat list, the same progressive spirit as the >12 filter. That filter matches rows across sections, a section with no matches dropping out, and the first-catch-up placeholder rows stay flat. Empty sections never render. The add sheet's sector field becomes a picker over the vocabulary with "None" as the default; free text retires, and legacy values normalise per the companion's mapping.

### S3: Company dashboard

Purpose: the heart; hero header (name, sector, latest FY, currency), key-stats header (dashboard design plan §5.3, added 2026-07-19), metric-card grid (12 cards grouped under five quiet section labels per the dashboard design plan §5.2; M10 and M13 render in their siblings' detail sheets per companion §12 D2) with a cards-or-table view toggle (dashboard design plan §5.4; choice persisted in `meta`), trends section between the grid and the flags (dashboard design plan §6), red-flag section, entry points to S4/S5/S8. *(Amended 2026-07-19, main plan §12 entry 16: the hero is a button opening the company details sheet at `?details=1` per §1.1's URL rules, `SheetShell`-owned. Name and sector are editable, sector through the vocabulary picker (companion §12 D3); ticker, exchange and currency display fixed, a wrong identity or money field being a re-create, not an edit.)*

| State | Rendering |
|---|---|
| Complete years | Cards: label (13px secondary), value (34px tabular), sparkline, 5-yr delta chip; from 2026-07-19 the chip, a 6px label dot and the sparkline wear the computed health signal (main plan §12 entry 13): a fired rule wins, then the delta against the pinned direction; current ratio and valuation stay neutral. From three labelled years each card face also carries its multi-year row (main plan §12 entry 14; dashboard design plan §4.6): the latest five years as bare-year labels over 11px tabular figures, short degenerate forms with full phrases as accessible names, wrapping naturally where figures outgrow the card |
| Any labelled year | Key-stats header between hero and controls (main plan §12 entry 14; dashboard design plan §5.3): ROE, net margin, debt-to-equity and free cash flow at 22px semibold tabular, each opening its detail sheet; a degenerate stat speaks its pinned phrase; renders in both views |
| Partial year(s) | Affected cards render `insufficient_data` as "Add the 2 missing numbers"; tappable, deep-links into S5 at those fields (companion §10) |
| No price entered | The two valuation cards (M12, M14) collapse into one "Enter today's price" card; on entry, they expand in place |
| Stale price | Valuation cards show "as of ⟨YYYY-MM-DD⟩" badge; amber past 90 days |
| Flags fired | Orange/red cards beneath the grid: what fired (with numbers), why it matters, what to check |
| Flags dismissed | Collapsed "1 dismissed" link; tap to review/undo |
| Single year only | Sparklines and delta chips hidden; gentle "Add more years to see trends" hint |
| 3+ labelled years | Trends section (added 2026-07-19, dashboard design plan §6): five-group segmented control, one small-multiple chart per metric (own y-axis, gaps where a year did not compute, a metric with under two computed years states its latest value in words), "Show table" fallback rendering the group's metrics by fiscal year; absent below three labelled years. Stored benchmarks (added 2026-07-22, data-model §9) draw as dashed lines behind the series with right-edge words (coverage speaks as the fragility rule's threshold while it sits at the rule's floor), the axis extending to keep the line visible and the unfavourable side tinted per the pinned health direction; a quiet per-metric editor beneath each chart sets, resets or removes the line (absent for money metrics in v1), carrying the Owner's-lens paragraph while the education layer is on |
| 6+ labelled years | Year-range control between hero and grid (added 2026-07-19, dashboard design plan §5.5): Last 5 years (default) / Last 10 years / All, scoping the trends section and the table view; cards and sparklines unaffected; not persisted |
| Table view picked | The practitioner table replaces the card grid (added 2026-07-19, dashboard design plan §5.4): metrics as rows under the five section bands, ranged fiscal years as columns, the 5-yr delta column (hidden single-year); cells speak "n/m" and "n/a" short with the full pinned phrase as the accessible name; the latest year's insufficient cell deep-links into S5; without a price the valuation rows collapse into the enter-price row; metric links open S4, wearing the row's health dot before the label (2026-07-19); arrows move between metric links |
| n/m values | Per companion P-5: "n/m: negative earnings" etc., never blank, never 0 |

### S4: Metric detail sheet (query-param addressable)

Slides up from the tapped card (spatial continuity); Escape/back closes. Contents, top to bottom: 10-yr chart; the pinned formula with **this year's actual inputs substituted**; denominator-basis badge (average/ending, P-4); plain-language explanation; Owner's-lens paragraph (hidden when education layer is off); per-input provenance chips (tap → source filing/page where available). Companion metrics per D2 render here as a secondary value row: M12's sheet carries M13 (earnings yield), M11's carries M10 (FCF margin), each with its own formula disclosure. States mirror S3's value states; an n/m year shows the reason inline with a one-sentence explainer.

### S5: Data entry

Purpose: the craft-critical screen. Segmented control (Income / Balance / Cash flow); fiscal years as columns; canonical line items as rows with the "find it as…" hints from companion §2.

Key behaviours: `MoneyField` formats thousands separators as-you-type; the FY header shows unit scale ("figures in millions, AUD") set once per year; negative entry allowed only on P-0 signed items; derived rows (gross profit, totals) compute live in grey; a completeness meter ("9 of 11 core items") sits in the header; per-statement provenance chip; **known-zero affordance**: each field's overflow menu offers "Not reported → 0", rendering a `∅0` chip (companion §8's null-vs-zero distinction, surfaced).

| State | Rendering |
|---|---|
| New year | Blank grid, first field focused, hint visible |
| Autosave | "Saved · just now" ticker; every blur commits a Dexie transaction |
| Storage quota low | Non-blocking banner with export prompt (main plan §14) |
| Review handoff | `?job=` present → S6 takes over this layout |

### S6: Extraction review mode (S5 variant, Phase 3)

Banner: "Extracted from *AR2024.pdf* via *DeepSeek*. Review before saving." Desktop: two columns, source page image left (PDF) or sheet snippet (XLSX), extracted grid right. Mobile: grid with a collapsible source peek per field.

Confidence rendering: fields ≥0.9 normal; 0.7–0.9 amber; <0.7 amber with **mandatory individual confirmation**. Actions: accept field, "Accept all ≥ 0.9", jump-to-source (page/cell ref from provenance). The live validation gates run continuously: a cross-foot failure marks the offending fields, not a modal. **Save stays disabled until every low-confidence field is confirmed**; Discard requires one confirm.

| State | Rendering |
|---|---|
| Job running | Progress with honest stage labels ("Reading pages… Mapping line items…") + live region announcement |
| Job failed | Provider error surfaced plainly; "Retry" offers the next ladder rung by name |
| Partial extraction | Found statements populate; missing ones fall back to blank manual columns |

### S7: Compare

Picker state first (chips, pick 2–4). Then: metric rows × company columns, best-in-row subtly ticked; below, one overlaid trend chart with a metric segmented control.

| State | Rendering |
|---|---|
| <2 companies in library | Empty prompt linking back to S2 |
| Mixed currencies | Absolute rows (revenue, FCF, market cap) auto-hidden + one-line note (P-7); ratios compare freely |
| 4 columns on mobile | Horizontal scroll with a sticky metric-label column |

### S8: Thesis editor

Four structured sections (business / moat / valuation / what kills it), distraction-free, optional serif body. Version history via `?history=1`: list of snapshots (date, word-count delta), read-only view of any version, "financials snapshot attached" indicator. Save offers the snapshot toggle. Empty sections show their prompt question as placeholder, not lorem.

### S9: Settings root

Groups: **Appearance** (theme auto/light/dark; education layer on/off, the Practitioner switch), **Providers →**, **Data & storage →**, **Sync** (signed out: a sign-in row stating plainly that the app works on the device copy while the durable copy needs sign-in, online-only (amended 2026-07-20, main plan §12.9; previously "nothing needs it", the local-first wording); signed in: the email, a sign-out, and the quiet sync line: the last-synced time, or the live count of changes waiting to sync while local writes await the server (main plan §12.9: pending is surfaced, never silently equal); the hosted UI does the password handling, and the session lives in device-local meta outside the export allowlist. Amendments 2026-07-18 with the Phase 3 sign-in slice and the server-wins reconciliation slice), **About** (version, licences; the replay row retired 2026-07-22 with S1's removal, main plan §12 entry 18).

### S10: Settings → Providers (BYOK)

One row per registry provider: name; data-policy label in plain words ("may train on inputs; public documents only" / "no-training endpoint"); key state (none / `••••` with reveal); **Test** button whose result chip is the runtime CORS probe: "Direct", "Via proxy", or "Failed"; delete. Ladder order displayed read-only (set from the bake-off scorecard; reordering UI deferred). Footer: the key-hygiene copy (dedicated key, provider-side spend cap, rotate on device loss).

### S11: Settings → Data & storage

Export (with last-export date; feeds the 30-day nudge; placement recorded 2026-07-20 with the build: a quiet line beside this screen's export action and a caption on S9's Data & storage row, both only while the library is non-empty, so a fresh install is never nagged); Import (file → **dry-run summary sheet**: "3 companies, 28 fiscal years, 2 theses: Merge / Replace / Cancel", schema version checked per companion §5); storage status (persisted ✓/✗, usage vs quota bar, iOS install nudge when applicable); remove sample data; quarantined records list (export-raw / discard per record); danger zone: wipe everything, type-the-app-name to confirm.

### S12: Import pickers (sheets, not routes)

**Ticker search** (Phase 2): debounced search sheet, results with exchange badges, hidden offline with the standard hint. **File upload** (Phase 3): drop/browse; type/size validation messages inline; provider select showing data-policy labels; a **"This document is confidential" toggle that filters the provider list to paid, no-training endpoints** (main plan §6 sensitivity routing, made tactile); kickoff → S6.

### S13: Pairs research (added 2026-07-22, pairs research integration plan §4)

Purpose: the sleeve's research surface, desktop-first by the operator's workflow. The latest published pair scan rendered whole: a provenance line (run date, engine version, fetch time), the candidate table (statistics beside the fundamentals join: each leg's sector, active-flag state and dashboard link, and a Compare link when both legs live in the library), and the correlation-and-cointegration matrix over the scanned universe, its measure a segmented control. The matrix is a visual summary and deliberately `aria-hidden`; a visually-hidden note points at the candidate table and the pair sheet, which carry the same statistics accessibly. The pair sheet (`?pair=`) is the derivation surface: each statistic beside its meaning and inputs, the window and criteria it was computed under, the gate-by-gate candidate verdict, and both legs' library state. Education framing throughout; the surface describes what the engine measured and never advises.

| State | Rendering |
|---|---|
| Signed out | "Sign in to read the sleeve" with a Settings link; the API is never called |
| Loading | A quiet one-line "Loading the latest scan…" |
| Fetch failed | The error placeholder carrying the envelope's message, with a Retry |
| Empty sleeve | "No scan published yet" with the publish hint; the rail memory clears |
| Ready | The three blocks above; offline appends "offline, showing the last fetch" to the provenance line. The query cache is in-session: a reload while offline lands on the fetch-failed state, honestly, rather than a stale render posing as fresh |

### S14: Pairs backtest (added 2026-07-22, pairs research integration plan §4, slice 4)

Purpose: the validation surface; the engine's train and holdout results for every candidate pair, the windows visibly separate and the holdout's once-spent status spoken plainly. Top to bottom: the provenance line (backtest run, the scan it read, engine, fetch time); the assumptions in one sentence (costs per side, borrow, entry, exit and stop thresholds, the rolling window); the stated criteria as text, never buttons; the pair picker (train Sharpe, train drawdown, win rate, holdout Sharpe, verdict), each row focusing its pair (`?pair=`); the focused pair's equity chart (each window normalised to its own start, the holdout region shaded, animation off, `aria-hidden` with the stats table carrying the numbers as text); the training-versus-holdout stats table; the gate-by-gate verdict in the sheet's met and not-met grammar; the legs' library links where the join finds them; and the round-trip list (window, entry, exit, side, days held, net P&L, close reason in words), scrolling inside its own container. States mirror S13's exactly (signed out, loading, fetch failed, empty sleeve, ready with the offline note); an artefact whose scan carried no candidates renders its own honest empty state.

### S15: Pairs live book (added 2026-07-30, pairs research integration plan §4, slice 5)

Purpose: the nightly report's three panels, the app observing the engine's book and never trading; every figure is the engine's own target, position or limit, advising no one. Top to bottom: the provenance line (report date, paper or live login, engine, fetch time); the **spread and z-score panel** for the focused pair (chips pick among deployed pairs, `?pair=`): the current z-score large, the stood-down or holding state, the spread's derivation (value, rolling mean, deviation), and the trailing z chart with the rule's bands drawn at entry, exit and stop; the **leg execution and imbalance tracker**: target versus held shares per leg with any nonzero imbalance in the investigate tone, the recent fills (price, reference close, slippage in basis points), and realised cost per side against the modelled figure; and the **risk and P&L summary**: cumulative live P&L charted against the engine's replay on the same closes, the stat tiles (cumulative, latest day, drawdown against the declared limit, worst drawdown, gross exposure, stops fired, round trips), and the weekly monitor's strip (cointegration p now, beta drift, tracking error per pair, pair-to-pair correlation) from the weekly kind, quiet when none is published.

Two loud states beyond S13's set, both pinned by test: a **halted reconciliation** renders as an alert before anything else (the mismatches itemised, the engine's refusal to trade stated plainly), and a **stale report** (older than four days) says the compute job may not have run before anything below is read as current.

## 4. Sample data: decision pinned

**One-tap sample load, not silent preload.** The empty Library offers "See it with sample data"; tapping it loads the **ASX golden five**: CSL (the ten-year showcase, an ASX listing reporting in USD), Wesfarmers, Woolworths, JB Hi-Fi, and Cochlear, as `sample: true` records (schema flag per companion §9), each badged, all removable with one action in S11. *(Amended twice on 2026-07-18 with the ASX-first steer: first the original US trio, Apple, Coca-Cola, and Costco, retired per companion §12 D1's amendment, leaving CSL alone; then the owner amended the companion's depth rule the same day so the four six-year ASX fixtures join, their sparklines showing the six years each fixture carries while CSL keeps ten. Compare is reachable from a fresh sample library again.)* *(2026-07-19: samples load pre-classified per companion §12 D3's mapping: CSL and Cochlear under Healthcare; Wesfarmers, Woolworths and JB Hi-Fi under Retail.)*

Rationale: a library that starts full lies about whose research it is: ownership of the analysis *is* the product's psychology, and an auto-populated home undermines it. The one-tap path preserves the five-second "living dashboard" wow while keeping the default state honest. Mechanics: fixtures are a lazy ~30KB JSON chunk generated from the Phase 0 golden files, meaning the demo data is *real, hand-verified* data, and the sample dashboard doubles as an acceptance test of the whole render path. Sample records sync and export like any data; they're just flagged.

## 5. Component inventory (presentational; props are contracts)

| Component | Responsibility | Key props (sketch) |
|---|---|---|
| `MetricCard` | One metric tile | `label, value: MetricValue, spark?: Series, delta?: Delta, health?, healthDirection?, history?, onOpen` (health props and the multi-year `history` row added 2026-07-19) |
| `StatusValue` | Renders the `MetricValue` union (the no-NaN rule lives here) | `value, formatKind` |
| `Sparkline` / `TrendChart` | 10-yr micro / full chart | `series, currency?, emphasisYear?`; Sparkline adds `health?` (2026-07-19), wearing the card's signal as its colour |
| `TrendSection` | S3 trends: group picker, small multiples, table fallback (added 2026-07-19) | `metrics: CompanyMetrics, fyLabels` |
| `TrendMiniChart` | One metric's small-multiple chart for `TrendSection` | `points: TrendPoint[], kind, currency, benchmark?, benchmarkLabel?, healthDirection?` (benchmark props added 2026-07-22) |
| `BenchmarkEditor` | S3 trends: one metric's reference-line editor (added 2026-07-22) | `metricId, kind, currency, value?, educationOff` |
| `MetricTable` | S3 practitioner table view (added 2026-07-19) | `metrics: CompanyMetrics, fyLabels, activeRuleIds` |
| `KeyStats` | S3 headline figures (added 2026-07-19) | `metrics: CompanyMetrics` |
| `DeltaChip` | 5-yr direction | `direction, magnitudeLabel, healthDirection?` (2026-07-19: colours by the pinned own-trend direction, data-model §6 N6; neutral without one; supersedes the always-neutral contract, main plan §12 entry 13) |
| `RedFlagBanner` | One fired rule | `rule, firedWith, onDismiss, onExplain` |
| `StatementGrid` | S5/S6 table shell | `rows, years, mode: 'entry'\|'review', onCommit` |
| `MoneyField` | Numeric input: separators, sign rules, known-zero menu | `value: MonetaryInt\|null\|'zero', signed, onChange` |
| `ConfidenceBadge` | Review-mode field state | `confidence, confirmed, onConfirm` |
| `SourcePeek` | Page image / sheet-cell snippet | `provenance` |
| `CompanyRow` | Library row | `company, flagsCount, roeSpark, roeLatest?, roeDelta?` (watchlist figure added 2026-07-22) |
| `LibraryTable` | S2 screener view (added 2026-07-22) | `companies` (reports assemble in `useLibraryReports`, one live pass for the sortable columns) |
| `AppRail` | ≥1200px persistent navigation rail (§1.2 amendment) | `showCompare, showPairs, companyId?, companyName?` (`showPairs` added 2026-07-22, §1.2's sleeve rule) |
| `PairCandidates` | S13 candidate table with the fundamentals join (added 2026-07-22) | `report, legs, onOpenPair` |
| `PairsMatrix` | S13 shaded universe grid, correlation or cointegration (added 2026-07-22) | `report, view, onOpenPair` |
| `PairSheet` | S13 pair derivation sheet (added 2026-07-22) | `report, pairKey, legs, onClose` |
| `BacktestScreen` | S14, the validation surface whole (added 2026-07-22, slice 4) | `status, collection, legs, focusPair, onFocusPair, …` (state props as S13's screen) |
| `EquityChart` | S14 per-pair equity, train and holdout separate (added 2026-07-22) | `pair` (Recharts; normalised per window, holdout shaded, animation off) |
| `LiveScreen` | S15, the live book whole (added 2026-07-30, slice 5) | `status, collection, weekly, staleDays, focusPair, onFocusPair, …` (state props as S13's screen) |
| `ZChart` / `PnlChart` | S15 charts: trailing z with the rule's bands; live versus engine cumulative (added 2026-07-30) | `pair, assumptions` / `pnl` (Recharts, animation off, `aria-hidden` beside textual stats) |
| `ComparisonTable` | S7 grid | `companies, metrics, hideAbsolutes` |
| `ProviderRow` | S10 row | `provider, keyState, probeResult, onTest, onDelete` |
| `EmptyState` | All empties, one component | `title, body, primary, secondary?` |
| `InstallExplainer` | iOS card | `onDismiss` |
| `SheetShell` | Query-param-bound sheet with focus trap | `paramKey, children` |

Any component crossing ~8 props triggers the design review per main plan §5.

## 6. Container hooks and data flow

| Hook | Feeds | Source |
|---|---|---|
| `useCompanies()` / `useCompany(id)` | S2 / S3–S8 headers | Dexie live query |
| `useMetrics(companyId)` | S3, S4, S7 | calc-engine, memoised per `(companyId, dataVersion)` |
| `useRedFlags(companyId)` | S3 | calc-engine rules + `flagDismissals` |
| `useThesis(companyId)` | S8 | Dexie live query + version writes |
| `useComparison(ids)` | S7 | `useMetrics` fan-out + P-7 currency check |
| `useExtractionJob(jobId)` | S6 | client-direct: in-page job runner; proxy: polling `GET /v1/extractions/:id` (server-ready; the client proxy path is pending, recorded 2026-07-20) |
| `useProviderKeys()` | S10, S12 | `providerCredentials` table (never leaves device) |
| `useStorageStatus()` | S11, quota banner | `navigator.storage` persist/estimate |
| `useOnlineStatus()` | offline pill, feature-hiding | `navigator.onLine` + listener |
| `useSyncRunner()` / `useSyncStatus()` | app shell / S2 first catch-up | the sync scheduler (main plan §12.9): revalidates on launch, reconnect, focus and sign-in, drains pending writes with backoff; the status snapshot gates the first read. Amendment 2026-07-18 with the reads-behind-the-API slice |
| `usePairsCollection()` | S13, and the rail's gate through `meta` | TanStack Query over the sleeve's authenticated GET (integration plan §4, added 2026-07-22): cached-last within the session, staleness stamped from the query's fetch time; the sleeve deliberately skips Dexie because this client authors nothing |
| `usePairsBacktest()` | S14 | The backtest kind through the same shared read path (`pairsRead`, added 2026-07-22 with slice 4): its own cache key, the same token dance and envelope handling |
| `usePairsDaily()` / `usePairsWeekly()` | S15 | The daily and weekly kinds through the same shared read path (added 2026-07-30 with slice 5) |

Keystrokes never cross feature boundaries: `MoneyField` holds local state, commits on blur; the S3 dashboard cannot re-render from S5 typing (state colocation, main plan §5).

## 7. Responsive rules

Breakpoints: <600 (single column; sheets full-screen; entry grid shows 2 year-columns with horizontal scroll and a sticky label column), 600–899 (sheets become centred 560px panels; metric grid auto-fits `minmax(160px, 1fr)`), ≥900 (720px column; 960px for S3/S7, for S2 while its screener view is on, whose eight columns need the dashboard's width (amendment 2026-07-22 with the finance-look gap plan §5), and for S13, S14 and S15, whose matrix, equity and panel layouts earn the same width (2026-07-22; S15 added 2026-07-30)), ≥1200 (the navigation rail joins at left on every screen: 200px plus a 24px gutter, so the main column widens by exactly 224px and the content cell keeps the route's designed width; amendments 2026-07-18, main plan §12.10 and §12.11; the welcome-flow exception retired 2026-07-22 with S1's removal, main plan §12 entry 18). Metric grid at ≥900: `repeat(4, 1fr)`, four deterministic columns per the dashboard design plan §5.1. Touch targets ≥44pt everywhere including grid cells. No layout reads differently enough to need separate designs: one design, fluid.

## 8. Accessibility per screen (deltas beyond the global WCAG AA baseline)

S2: rows are single buttons with composite labels ("Apple, 2 flags, updated yesterday"); sector section headers are group headings announced before their rows (2026-07-19). S3: the hero button's accessible name is "Edit company details" (2026-07-19). S3/S4/S7: every chart has the table-fallback toggle; values announced via `StatusValue`'s text form ("not meaningful: negative equity"), never symbol-only. S4/S12/S8-history: focus moves into the sheet on open, returns to trigger on close (`SheetShell` owns this). S5/S6: full arrow-key spreadsheet navigation, Enter commits-and-moves-down, live region announces autosave and extraction-job stages. S1/iOS card: dismissible, non-modal, focus-order-neutral. `prefers-reduced-motion`: all sheet/stagger animation becomes ≤150ms fades (main plan §4).

## 9. Frontend folder structure

```
apps/web/src/
  routes/            # one file per route above, lazy boundaries here
  features/
    library/  dashboard/  entry/  review/  compare/  thesis/  settings/  pairs/
  components/        # §5 inventory: presentational only
  hooks/             # §6 inventory: containers
  db/                # Dexie schema, migrations, export/import (allowlist!)
  styles/tokens.css.ts   # Vanilla Extract: main plan §4 scales as typed tokens
packages/
  calc-engine/       # schema + metrics + rules (companion spec)
  extraction-core/   # isomorphic adapters, prompts, gates (main plan §6)
infra/               # CDK
```

## 10. Explicitly deferred

Desktop side-panel metric detail (sheet everywhere in v1); command palette; drag-to-reorder provider ladder; thesis print styles (rides Markdown export); search across theses; i18n beyond en-AU; any theming beyond light/dark.

---

*Review focus for the owner: the no-tab-bar navigation call (§1.2), the one-tap sample-data decision (§4), the confidence thresholds and save-gating in review mode (S6), and the iOS install-explainer wording (§2); these four carry the most opinion.*
