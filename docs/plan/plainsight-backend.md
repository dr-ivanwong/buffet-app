# Backend Implementation Plan: v1 Specification

**Companion to:** `plainsight.md` §6 (backend architecture, API surface, ingestion strategy) and `plainsight-cdk.md` (the stacks this runs in). **Status:** Reviewed and pinned; owner review pass completed 2026-07-12 · **Date:** 2026-07-12
**Purpose:** the build contract for everything server-side: the API contract and error envelope, DynamoDB key design and access patterns, the sync protocol, the ingestion pipeline, the extraction job lifecycle, the BYOK proxy, ticker search, external-client etiquette, and the Lambda inventory. Nothing here is load-bearing for the client: the app is fully functional with all of it switched off (main plan, binding constraint).

---

## 1. Scope and principles

1. **The API is a product for the client, not a mirror of storage.** Resource-oriented, standard methods, boring on purpose (main plan §6). Additive changes never bump the version; breaking changes get `/v2` with a parallel run.
2. **Everything is an optional enhancement.** Every endpoint's failure mode is "the client behaves as if offline", which is a fully specified, first-class state (frontend §2). There is no endpoint whose outage needs paging anyone. *(Amended 2026-07-18, main plan §12.9: the sync pair is no longer optional, it is the source-of-truth wire and a standing obligation. Its outage still pages no one, because the client's catch-up mode is that same first-class offline state: reads serve the last-synced copy and writes queue with backoff until the pair returns.)*
3. **Single user shapes the design.** Quotas are global-ish, abuse controls protect the wallet and the keys (cdk §8 threat model), and capacity maths is done against the provisioned 25 RCU/WCU free-tier ceiling.
4. **Uploads never touch the canonical store.** User-upload extraction results return to the requesting client and live in that device's library; only the EDGAR/MAP pipeline, behind validation gates and the review queue, writes canonical data (main plan §6, private-library isolation).

## 2. API contract

### Route table

This table drives the cdk §6 invariant: every route flagged auth here must have the Cognito authoriser attached in synth.

| Route | Auth | Phase | Purpose |
|---|---|---|---|
| `GET /v1/companies/{ticker}` | | 2 | Profile (name, exchange, sector, CIK) |
| `GET /v1/companies/{ticker}/financials?years=10&statements=…` | | 2 | Standardised annual statements + `gaps[]` |
| `GET /v1/search?q=…&pageToken=…` | | 2 | Ticker search (§8) |
| `GET /v1/companies/{ticker}/quote` | | deferred (3+) | Delayed price; v1 price entry is manual (main plan §12.1) |

**Ticker namespace (Phase 2.5):** `{t}` is the exchange-qualified symbol: bare for US listings (`AAPL`), suffixed `.AX` for ASX listings (`CSL.AX`), the convention delayed-quote services already use. US and ASX symbols collide (`CSL` is Carlisle on the SEC index and CSL Limited on the ASX), so the suffix is what keys the partition, routes ingest, and rides every path and cache entry; search results carry it, and clients display the bare code beside the exchange badge. Profile `cik` is optional accordingly (ASX companies carry none), and provenance widened additively with `source: asx_map`, `filing.system: ASX_MAP`, and the extraction reference `{provider, model, promptVersion, fields}` whose field-level confidence and printed pages power tap-to-source (amendment recorded 2026-07-16 with the Phase 2.5 routing slice).
| `POST /v1/sync/push` | ✓ | 3 | Client changes since checkpoint; Idempotency-Key required |
| `GET /v1/sync/pull?checkpoint=…` | ✓ | 3 | Server changes since checkpoint |
| `POST /v1/uploads` | ✓ | 3 | Presigned S3 PUT for a filing (PDF/XLSX/CSV) |
| `POST /v1/extractions` | ✓ | 3 | Start an extraction job; Idempotency-Key required |
| `GET /v1/extractions/{jobId}` | ✓ | 3 | Job status / result payload |
| `POST /v1/proxy/{providerId}` | ✓ | 3 | BYOK pass-through for non-CORS providers (§7) |
| `PUT /v1/pairs/artefacts/{kind}` | ✓ | pairs slice 2 | The engine publishes a validated artefact of the named kind, idempotent by run date (integration plan §4; added 2026-07-22, the kind segment added with slice 4: `pair-scan`, `backtest`, then `daily` and `weekly` with slice 5 (2026-07-30), a closed set that grows with its schemas, never new functions). A daily artefact carrying a halted reconciliation additionally nudges the account alert topic, best-effort (integration plan §10, added 2026-07-30) |
| `GET /v1/pairs/artefacts/{kind}` | ✓ | pairs slice 2 | The latest report of the named kind in full plus the run history, for the Pairs surfaces; unknown kinds are not found |

Route throttles: ~10 rps / 20 burst per route (cdk §8 not-list: throttles are the WAF and the scraper cost-cap). All routes sit behind CloudFront; `GET financials` carries the 6-hour edge cache with pipeline invalidation.

### Error envelope (part of the contract)

```json
{ "error": { "code": "resource_exhausted", "message": "Monthly extraction quota reached.",
             "details": [{ "reason": "quota", "limit": 10, "resetsAt": "2026-08-01" }],
             "requestId": "req_…" } }
```

| Code | HTTP | Used for |
|---|---|---|
| `invalid_request` | 400 | Malformed input, failed Zod parse |
| `unauthenticated` | 401 | Missing/expired Cognito token |
| `permission_denied` | 403 | Valid token, wrong user/resource |
| `not_found` | 404 | Unknown ticker, job, record |
| `resource_exhausted` | 429 | Route throttle or extraction quota |
| `feature_disabled` | 503 | Kill switch flipped (cdk §8); client renders the known "temporarily disabled" state |
| `ingesting` | 202 | Cold ticker; body carries `retryAfterSeconds` (§5) |
| `internal` | 500 | Everything else; requestId is the debugging handle |

**Idempotency** is mandatory on `POST /v1/sync/push` and `POST /v1/extractions`: `Idempotency-Key` header, 24-hour dedupe window, replay returns the originally stored response (mobile clients retry; a duplicated push must be a no-op, main plan §6). **Pagination** is opaque page tokens only, never offsets. **Partial data degrades, never 500s:** a ticker with 8 of 10 years serves 8 years plus `gaps: ['FY2017', 'FY2019']`.

## 3. DynamoDB key design and access patterns

One table (`Data` stack), provisioned 25/25 inside the always-free tier (cdk §8). Item types:

| PK | SK | Item | Notes |
|---|---|---|---|
| `TICKER#{t}` | `PROFILE` | name, exchange, sector, CIK, currency, `watchedSince?`, `lastFilingSeen`, `lastSweptAt` | `watchedSince` set on first successful ingest; that is the definition of a watched ticker |
| `TICKER#{t}` | `FY#{yyyy}#STMT#{type}` | canonical line items (minor units), endDate, provenance, mappingVersion | the serving read |
| `TICKER#{t}` | `DOC#{documentId}` | extraction provenance cache for MAP filings | filings are immutable; extract once, cache forever |
| `TICKER#{t}` | `QUAR#{documentId}` | gate-failed extraction awaiting human review | never served (main plan §6) |
| `USER#{u}` | `REC#{type}#{recordId}` | sync record envelope (§4) | TTL on tombstones only |
| `USER#{u}` | `THESISV#{companyId}#{lamport}` | append-only thesis versions | no TTL, no overwrites, ever |
| `USER#{u}` | `CKPT#{deviceId}` | last-pulled sequence number | |
| `USER#{u}` | `SEQ` | per-user monotonic sequence counter | transactional increment on accepted push |
| `USER#{u}` | `QUOTA#{yyyy-mm}` | extraction count for server-key jobs | atomic increment, limit 10/month |
| `JOB#{jobId}` | `STATE` | extraction job state machine (§6) | TTL 30 days |
| `IDEMP#{key}` | `RESP` | stored response for idempotent replay | TTL 24 hours |
| `PAIRS#{kind}` | `RUN#{yyyy-mm-dd}` | pairs artefact run: engine and schema versions, generatedAt, receivedAt, sizeBytes, object key | integration plan §4 (added 2026-07-22); ISO dates make the sort key chronological, so the latest run is the first row of a descending query; report bodies are durable objects under the uploads bucket's `pairs/` prefix, outside the seven-day `uploads/` lifecycle |

**GSI1 (sync feed):** on `REC#` items, `GSI1PK = USER#{u}`, `GSI1SK = SEQ#{seq, zero-padded}`. Pull is a single Query for `seq > checkpoint`.
**GSI2 (watched tickers, sparse):** on `PROFILE` items with `watchedSince`, `GSI2PK = 'WATCH'`, `GSI2SK = TICKER#{t}`. The weekly sweep is one Query.

Access patterns are exactly: profile by ticker (GetItem), all years for a ticker (Query `begins_with FY#`), changes since checkpoint (GSI1 Query), watched tickers (GSI2 Query), job by id (GetItem), and latest-plus-history for a pairs artefact kind (Query descending under `PAIRS#`, added 2026-07-22). Nothing relational exists in the serving path (main plan §6, Aurora rejection reaffirmed).

## 4. Sync protocol (pinned; cited by main plan §5 and §6)

Single user, multiple devices: last-write-wins per record using Lamport timestamps with a device-id tiebreak. Identical user-visible guarantees to vector clocks at a fraction of the machinery, because the only concurrent writers are the owner's own devices.

- **Record envelope:** `{ recordType: 'company' | 'statement' | 'price' | 'thesis' | 'flagDismissal', recordId, payload, schemaVersion, lamport, deviceId, deleted }`. `providerCredentials` is not a recordType; the server schema rejects it (keys never sync, by construction, data-model §5).
- **Clocks:** each device keeps a Lamport counter; every local write sets `lamport = max(deviceCounter, maxLamportSeen) + 1`.
- **Push:** batch of ≤ 100 envelopes + Idempotency-Key. Per record, a conditional transact-write accepts when `(lamport, deviceId)` exceeds the stored pair (lexicographic tiebreak on deviceId); each accepted record is assigned the next per-user `seq`. The response lists `accepted[]` and `superseded[]` (with current server copies); the client applies the winners locally. Rejected-and-retried pushes are no-ops twice over: the idempotency record and the conditional writes.
- **Pull:** Query GSI1 for `seq > checkpoint`, paginated; response ends with the new checkpoint, persisted per device (`CKPT#`). The client applies each record through the same LWW comparison (a local record with a higher `(lamport, deviceId)` survives).
- **Deletes are 90-day tombstones:** `deleted: true`, payload dropped, DynamoDB TTL 90 days. The server keeps a per-user `tombstonePurgeWatermark`; a pull whose checkpoint predates it gets `full_resync_required`, and the client re-pulls everything and reconciles by LWW. A device offline for less than 90 days never notices.
- **Theses are double-protected:** every accepted thesis write also appends a `THESISV#` item. Version history is append-only and exempt from LWW, so concurrent edits can never destroy writing (main plan §6); the client's own `thesisVersions` table syncs as ordinary insert-only records.

## 5. Ingestion pipeline (EDGAR + ASX MAP)

- **On-demand first (main plan §6):** `GET financials` on a cold ticker returns `202 ingesting` with `retryAfterSeconds: 5` and fires an async ingest (idempotent per ticker: a conditional lock attribute on `PROFILE` with a 10-minute lease). EDGAR `companyfacts` fetch → mapping table (versioned; the crown-jewel asset) → validation gates → write. Journey B's < 10 s budget holds because it is one HTTP fetch and one normalisation pass.
- **Weekly sweep:** EventBridge Scheduler → Step Functions map over GSI2 (concurrency 2, pacing writes under the 25 WCU ceiling, per-item catch) → only tickers whose `lastFilingSeen` changed do any work → SQS DLQ + depth alarm (cdk §3). A poisoned filing quarantines; blast radius is that one company.
- **Validation gates (both sources, pinned in data-model P-2):** balance sheet cross-foots within tolerance, subtotals recompute, YoY deltas sanity-checked, Zod schema pass. Failures write `QUAR#` items and alert; quarantined data is never served. ASX MAP extraction runs the §6 engine with the canonical pipeline's own SSM-held keys and the cheap-first ladder.
- **The ASX on-demand path (Phase 2.5):** the ingest function routes `.AX` tickers to `extractFiling` by asynchronous invoke (one front door for the financials route and the sweep; the extraction function owns the 300-second budget). It resolves the statutory lodgements from the last three announcement year pages, backfills the three most recent reports (six fiscal years, the data-model minimum depth), runs each document once through preprocess, ladder, and gates, and caches every outcome in `DOC#` forever, quarantines included. Extracted years merge newest-document-wins (the golden corpus's comparative-column sourcing rule), the printed-EPS checksum joins the gates where the face carried one, and a field the statements do not print stays absent on the wire: the pipeline never asserts the not-reported-zero state (data-model §8). The Lambda carries no rasteriser: a scanned document quarantines at preprocessing with its reason (ASX 200 statutory reports are born-digital; vision documents are the Journey E upload path's concern). With no provider key parameters configured the function declines loudly and writes nothing.
- **Cache invalidation:** every accepted FY write triggers a CloudFront invalidation for that ticker's `financials` path (6 h TTL otherwise).

## 6. Extraction job lifecycle (uploads, Phase 3)

1. `POST /v1/uploads` → presigned S3 PUT (15-minute expiry; content type pinned by the signature) into the uploads bucket (7-day lifecycle, cdk §3). *(Amended 2026-07-20: the original wording claimed the ≤ 50 MB ceiling rode the presigned PUT as a condition, which S3 cannot bind on a PUT. The declared size is validated at presign time, and the object's true size is re-checked with a head read before any job or quota unit exists, so an oversize object costs only its own seven-day deletion.)*
2. `POST /v1/extractions { objectKey, confidential? }` → magic-byte and size validation → `JOB#` item `queued` → async worker.
3. Worker stages, mirrored verbatim by S6's honest stage labels: `preprocessing` (PDF → page images + text layer; XLSX/CSV → parsed sheets via SheetJS, values copied never retyped) → `extracting` (registry ladder, cheap-first; `confidential: true` filters the ladder to paid, no-training endpoints, main plan §6 sensitivity routing) → `validating` (the same gates as §5) → terminal. *(Amended 2026-07-20: shipped PDF-first. The wire accepts `application/pdf` alone and the worker magic-checks it; the XLSX/CSV SheetJS stage stays pinned as roadmap, and the upload content-type set widens when the sheet parser lands on both sides.)*
4. Terminal states: `review_required` (the success: statements + per-field confidence + page/cell refs, handed to S6; the user is the reviewer and nothing saves without confirmation) or `failed` (provider error surfaced plainly + the next ladder rung by name, per S6). Where the validating stage's gates flag years, the review payload carries `gateFindings` (per year, every reason): uploads have no quarantine because nothing is served unreviewed, so the verdicts travel to the reviewer instead of a `QUAR#` row (recorded 2026-07-19 with the stage's implementation). Every attempt appends `{provider, model, promptVersion, outcome}` to the job for provenance.
5. **The server never writes upload results to the canonical store.** The confirmed data lands in the client's own library with `source: user_upload` provenance.
6. Controls: Cognito, per-user quota (`QUOTA#`, 10/month on server-key jobs), and the SSM kill-switch flag read per invocation with a 60 s cache (`feature_disabled` when off). *(Amended 2026-07-20: the "keep source document" toggle is removed from the design rather than deferred, by owner decision. The verification moment it served, checking a figure against the printed page, happens during review from the job's retained bytes (the source peek); after a save, provenance keeps the file name and page number, which name the reviewer's own copy of the document, and the owner keeps the PDF itself, a re-downloadable public filing. A durable server-side copy, meaning a lifecycle carve-out, a copy on confirm, and a signed read route, was priced against that and declined at one seat.)* *(Amended 2026-07-20: the quota counts spend, not tries. A unit is consumed at job creation, where the 429 answer lives, and returns when the attempt dies before any provider is called: the worker not starting, the kill switch flipping between request and worker, an expired or unreadable upload, a preprocess refusal, or a fully keyless ladder. Once a provider has run, the unit stays consumed whatever the outcome. The refund is a conditional decrement floored at zero, keyed to the month the creation was billed to; the runbook carries the manual reset for pathological cases.)*

BYOK **client-direct** jobs never touch this path at all: preprocessing and adapters run in-browser from `extraction-core`, and the document goes device → provider (main plan §6).

## 7. BYOK proxy pass-through (Phase 3)

For registry providers without browser CORS. Narrow by construction:

- **Target allowlist:** `POST /v1/proxy/{providerId}` resolves the upstream base URL and endpoint path from the server-side registry entry; nothing about the destination comes from the request. Unknown `providerId` → `not_found`. The registry is config (main plan §6); adding a provider updates it and the CSP allowlist together.
- **Key handling:** the user's key arrives in an `X-Provider-Key` header, is injected upstream as the provider's auth header, and is never stored and never logged. The access-log format excludes headers; a unit test asserts the proxy's log lines cannot contain the key.
- **Sizing:** requests must fit API Gateway's 30 s integration ceiling, so `extraction-core` chunks proxy-mode work per statement rather than per document; the Lambda timeout is 25 s with buffered pass-through. *(Amended 2026-07-20: the original wording promised streaming pass-through where the provider streams; the proxy buffers. An HTTP API Lambda integration cannot stream a response (that needs Function URLs), and statement-level chunking is the control that actually fits the ceiling, so buffering is the design, not a gap.)*
- **Controls:** Cognito (an unauthenticated key relay is an abuse magnet, cdk §8), route throttle, no quota (the user's own key and spend; the kill switch guards only the canonical pipeline's keys).

## 8. Ticker search

In-memory, deliberately: EDGAR's `company_tickers.json` (~10k rows) plus the ASX listed-companies file (~2k rows) total ~1.5 MB. The weekly sweep refreshes both into S3; the search Lambda loads them into module scope on cold start (re-checked daily) and serves exact-ticker boost + prefix match on ticker + substring match on name, with exchange badges, paginated by opaque token. No search infrastructure, single-digit-millisecond queries, $0.

## 9. External-client etiquette

- **EDGAR:** declared `User-Agent` with a contact address, sourced from config, never hardcoded in the repo (SEC fair-access requirement); ≤ 2 requests/second (well under SEC's published ceiling); conditional GETs; exponential backoff + jitter + retry budget on 429/403; one `companyfacts` call per on-demand ingest, no crawling.
- **ASX MAP:** on-demand fetches of specific announcement PDFs only, never bulk crawling; honest User-Agent; each immutable filing extracted once and cached forever (`DOC#`). Redistribution posture: extracted figures serve the single owner; the main plan §15 tripwire (publishing datasets) triggers a licensing review before that ever changes.
- **Quote providers:** deferred with the endpoint (main plan §12.1).

## 10. Lambda inventory

All `NodejsFunction`, Node 22, ARM64, explicit timeout, `logRetention: 30 days` (cdk §5). API functions 256 MB.

| Function | Stack | Trigger | Timeout | Notes |
|---|---|---|---|---|
| `getProfile`, `getFinancials`, `searchTickers` | Api | API GW | 10 s | read path; `getFinancials` emits `202 ingesting` on cold tickers |
| `syncPush`, `syncPull` | Api | API GW | 15 s | §4; transact-writes |
| `createUpload`, `createExtraction`, `getExtraction` | Api | API GW | 10 s | §6 |
| `byokProxy` | Api | API GW | 25 s | §7; streaming pass-through |
| `putPairsArtefact`, `getPairsArtefact` | Api | API GW | 10 s | pairs transport (integration plan §4, added 2026-07-22; kind-routed from slice 4): artefact objects under `pairs/{kind}/`, run rows under `PAIRS#{kind}` |
| `ingestTicker` | Ingestion | async invoke + SFN task | 120 s / 512 MB | fetch + normalise + gates |
| `extractFiling` | Ingestion | SFN task | 300 s / 1536 MB | rasterising + ladder (cdk §5 sizing) |
| `sweepDispatcher` | Ingestion | EventBridge weekly | 60 s | starts the SFN map |
| `killSwitchFlipper` | Foundation | Budgets SNS | 30 s / 128 MB | flips the SSM feature flag (cdk §8) |

X-Ray on the ingestion path only (main plan §6).

## 11. Observability and operations

- **Structured JSON logs** `{ requestId, route, latencyMs, outcome }`, requestId propagated edge → Lambda → error envelope. Payloads, tokens, and headers are never logged (the §7 redaction test is the enforcement).
- **Alarms are symptom-based only** (main plan §6): 5xx rate, p99 > 400 ms, DLQ depth > 0, sweep failure, budget thresholds. SLOs: 99.9% availability on reads; p50 < 100 ms, p99 < 400 ms on `GET financials`.
- **Runbook:** `docs/runbook.md` lands with the first Phase 2 deploy (it is the risk-register mitigation for the bus factor; scheduling it here stops it being unowned). Contents: rebuild-from-zero drill (bootstrap → deploy → golden smoke), DLQ drain procedure, quarantine review procedure, kill-switch reset.

---

*The owner review pass completed 2026-07-12, confirming all four footer items as drafted: the §4 conflict semantics (LWW per record; the full-resync rule after 90-day tombstone purge), the §2 error envelope as a frozen contract, the §6 quota at 10 extractions/month on server-key jobs, and the §7 proxy sizing (statement-level chunking to fit API Gateway's 30 s ceiling). The §3 key design stands as the mechanical consequence of access patterns already fixed in the main plan. This document is now pinned; changing a pinned item means updating this document in the same change, with the regression discipline the data-model spec §1 sets.*
