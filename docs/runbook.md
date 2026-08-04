# Runbook

Operational procedures for the deployed backend (backend spec §11 schedules this document with the first Phase 2 deploy; it is the risk register's bus-factor mitigation). One calming fact frames everything here: a backend outage never interrupts the owner's work. The backend is the source of truth (main plan §12.9), but the client works offline against its synchronised copy and retries every write until the server accepts it, so an outage costs catch-up time, not work; the procedures here matter, and almost none of them are urgent.

Written for the owner-operator. Commands assume the repository root, AWS credentials for the one account (ADR 0001), and the `ap-southeast-2` region. Angle-bracketed values come from stack outputs (`aws cloudformation describe-stacks --stack-name <stack> --query 'Stacks[0].Outputs'`).

## Phase 2 go-live (the first deploy)

The one-time sequence, which is also the first run of the rebuild drill below. The Phase 2 feature flags are already on in `infra/config/prod.ts` (flipped 2026-07-12); what is missing is the account.

1. **Set the real account id** in [infra/config/prod.ts](../infra/config/prod.ts) (the `000000000000` placeholder deploys nowhere). An account id is not a secret; commit it.
2. **Bootstrap** the account: `cd infra && npx cdk bootstrap aws://ACCOUNT_ID/ap-southeast-2`.
3. **Create the EDGAR contact parameter** (SEC fair-access; configuration that never lives in the repo): `aws ssm put-parameter --name /app/prod/edgar/contact --type String --value you@example.com`.
4. **Deploy in dependency order**, budgets before anything can spend:

   ```sh
   npx cdk deploy GithubOidc Foundation
   npx cdk deploy Data
   npx cdk deploy Ingestion Api StaticSite
   ```

5. **Set the GitHub repository variables** from the outputs so the pipelines activate (details in the [infra README](../infra/README.md)): `AWS_DEPLOY_ROLE_ARN`, `AWS_SITE_DEPLOY_ROLE_ARN`, `SITE_BUCKET`, `DISTRIBUTION_ID`, and optionally `SITE_ORIGIN`.
6. **Ship the app shell**: push to main (or re-run the app workflow); from here on, infra changes ride `infra.yml`. (The one-click gate on the stateful stacks was removed 2026-07-18 by owner decision; the structural protections carry the load, cdk spec §7 as amended.)
7. **Subscribe an email** to the `AlertTopicArn` output; the DLQ, sweep, budget, and anomaly alarms all land there.
8. **Activate the cost-allocation tag** once the first tagged spend appears in Billing (the key only becomes activatable after it first lands, and activation reaches filters within a day): `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=project,Status=Active`. The budget and the anomaly monitor are tag-scoped on the shared account (ADR 0001 amendment) and measure nothing until this runs.
9. **A day after activation, verify the scoping bites**, one call per key form. The two services disagree on tag-key shape (Budgets wants `user:project`, Cost Explorer expressions the bare `project`; both forms are pinned in code and test), and a wrong key fails silent by matching nothing, so trust neither until each has matched real spend:

   ```sh
   aws ce get-cost-and-usage --time-period Start=<first-of-month>,End=<tomorrow> \
     --granularity MONTHLY --metrics UnblendedCost \
     --filter '{"Tags":{"Key":"project","Values":["plainsight"],"MatchOptions":["EQUALS"]}}'
   aws budgets describe-budget --account-id <account-id> --budget-name plainsight-prod-monthly \
     --query 'Budget.CalculatedSpend.ActualSpend'
   ```

   Non-zero from the first proves the bare key matches in Cost Explorer, which is what the anomaly monitor filters by; non-zero from the second proves the prefixed key matches in Budgets. Zero from either means activation has not reached that filter yet (give it its day) or the key form regressed.
10. **Fire the kill chain once on purpose** (the drill in the kill-switch section below): every link downstream of Budgets runs for real, and the relay email arriving doubles as proof of the step 7 subscription.

### The exit-criteria smoke (main plan §8, Phase 2 row)

With `ORIGIN=https://<DistributionDomainName>`:

- `curl "$ORIGIN/v1/search?q=apple"` returns results including AAPL with its exchange.
- `curl -i "$ORIGIN/v1/companies/AAPL/financials"` answers `202` with the ingesting envelope; repeating it lands on `200` with ten fiscal years. Wall clock from first request to 200 sits inside ten seconds.
- In the app: Import → AAPL → the dashboard renders the ten-year model, and a metric detail sheet's provenance names the EDGAR filing.
- Run the sweep once by hand and watch it succeed: `aws stepfunctions start-execution --state-machine-arn <SweepStateMachineArn> --input '{"tickers":["AAPL"]}'`. An unchanged ticker reports `unchanged` and does no work.

## Phase 2.5 go-live (ASX extraction)

Everything deploys with the Phase 2 stacks (the ingestion flag covers the extraction function); what turns ASX ingestion on is the provider keys, and nothing spends until they exist.

1. **Run the bake-off locally first** (this is the pinned accuracy gate, main plan §8: proceed only at 99.5% post-validation field accuracy). From `packages/extraction-core`, with any subset of keys:

   ```sh
   corepack pnpm build
   EDGAR_CONTACT=you@example.com \
   ANTHROPIC_API_KEY=... GEMINI_API_KEY=... DEEPSEEK_API_KEY=... GROQ_API_KEY=... \
   node tools/bakeoff.mjs
   ```

   The scorecard (field accuracy against the hand-typed transcriptions, gate pass rate, latency, estimated cost per rung) lands in `bakeoff-results/`, gitignored. Corpus documents download once from the URLs the transcriptions record.
2. **Pin the ladder from the scorecard**: reorder the entries in `packages/extraction-core/src/registry.ts` to the measured order (accuracy first, then cost), commit the scorecard summary into this repository's docs beside the change, and re-run the bake-off whenever the registry changes.
3. **Create the provider key parameters** for the rungs the pinned ladder uses (SecureStrings, never in code or state; the registry names each parameter):

   ```sh
   aws ssm put-parameter --name /app/prod/extraction/anthropic-api-key --type SecureString --value ...
   aws ssm put-parameter --name /app/prod/extraction/gemini-api-key   --type SecureString --value ...
   aws ssm put-parameter --name /app/prod/extraction/deepseek-api-key --type SecureString --value ...
   aws ssm put-parameter --name /app/prod/extraction/groq-api-key     --type SecureString --value ...
   ```

   Any subset works: the ladder skips rungs whose parameter is absent, and with none at all the extraction function declines loudly and writes nothing.
4. **Set provider-side spend caps** on each key (the provider dashboards), the control that actually bounds a leak; the budget kill switch below is the backstop.

### The ASX exit smoke

With `ORIGIN=https://<DistributionDomainName>`:

- `curl "$ORIGIN/v1/search?q=COH"` returns COCHLEAR LIMITED as `COH.AX` with the ASX badge beside any US collision.
- `curl -i "$ORIGIN/v1/companies/COH.AX/financials"` answers `202`; the first pass reads three annual reports (a couple of minutes, not EDGAR's ten seconds), then `200` with six fiscal years whose provenance names the MAP document, the provider, the model, the prompt version, and per-field printed pages.
- Repeat the import for the same ticker: the `DOC#` cache answers and no model is called (`aws dynamodb query` on `TICKER#COH.AX` / `begins_with(SK, 'DOC#')` shows the cached extractions).
- In the app: Import → search `COH` → pick the ASX badge → the dashboard renders, a detail sheet's provenance names the annual report and its printed page, and the enter-price card states the statements' currency.
- Cross-check one company against its golden fixture: the served FY2025 values for COH.AX must equal `packages/calc-engine/fixtures/coh.json` (that equality is the whole point of the corpus).

### ASX quarantine notes

Two quarantine layers exist for ASX (both under the ticker partition, never served):

- **Document-level** (`DOC#` items with `status: quarantined`): preprocessing refused the document (a scan, no statements found) or every ladder rung failed. The cache is deliberately final; to re-try after a fix, delete the `DOC#` item and re-fire the ingest:

  ```sh
  aws dynamodb delete-item --table-name <TableName> \
    --key '{"PK":{"S":"TICKER#COH.AX"},"SK":{"S":"DOC#<idsId>"}}'
  aws lambda invoke --function-name <IngestFunctionName> \
    --cli-binary-format raw-in-base64-out \
    --payload '{"ticker":"COH.AX"}' /tmp/out.json
  ```

- **Year-level** (`QUAR#` items suffixed with the fiscal year): the conversion or the gates rejected a year (a failed print checksum names the three figures it pins). Same review posture as EDGAR quarantine above; a prompt or registry fix warrants the document-level re-run.

The extraction function's errors alarm on the Foundation topic is the symptom surface (its delegation is asynchronous, so the sweep DLQ never sees it fail); its log group carries the per-document trail.

## Phase 3 go-live (auth)

The user pool deployed with `features.auth` (flipped 2026-07-18) through the stateful-stack gate. What turns it into a working sign-in is the one account, created from the CLI so no signup surface ever exists. Values in angle brackets come from the Auth stack outputs.

1. ~~Protect the stateful environment~~ (done 2026-07-18, then removed the same day by owner decision: the approval gate is gone from the pipeline, cdk spec §7 as amended; the structural protections on Data and Auth remain).
2. **Create the owner account** (the pool enforces 12 characters minimum with all four character classes; a leading space keeps the second command out of zsh history):

   ```sh
   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
     --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
     --message-action SUPPRESS
    aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> \
     --username you@example.com --password '...' --permanent
   ```

3. **Sign-in lives at** `<HostedUiBaseUrl>`, and in the app at Settings → Sign in. The client wiring and the sync routes landed 2026-07-18, and the Cognito authoriser guards exactly the routes the backend spec §2 table flags.

## Pairs sleeve: the first scan

The engine is built and tested keyless (integration plan §7, slice 1); the first live run is an owner step because the data licence is bought, not built.

1. **Buy the EOD data plan** (EODHD or equivalent; ASX coverage needs a paid tier). Read the personal-use terms against the pairs trading plan's licensing section (Week 1) before paying, and line the first invoice up against that plan's monthly estimate; where they disagree, the estimate is what is wrong.
2. **Fetch the universe** (the key lives in the environment for this one command, never in a file; the leading space keeps it out of zsh history):

   ```sh
    EODHD_API_KEY=... uv run --directory quant/pairs-engine pairs-engine fetch
   ```

   The fetch aborts loudly listing every missing ticker. A failure here means the universe audit needs re-running (pairs trading plan, Week 1), not a retry loop: tickers rename and delist, and a downloader that skips failures quietly shrinks the universe.
3. **Run the scan and eyeball the artefact:**

   ```sh
   uv run --directory quant/pairs-engine pairs-engine scan
   ```

   The summary prints tested, skipped, significant and candidate counts, and the artefact lands in `quant/pairs-engine/artefacts/pair-scan-<runDate>.json`. Sanity marks: about twelve hundred pairs tested; dozens significant at the nominal threshold by chance alone (the plan's multiple-comparisons caution); the candidate list much shorter. The holdout begins after the printed split date and stays untouched until the backtest's validation step.
4. **Backtest the candidates** (integration plan §7, slice 4):

   ```sh
   uv run --directory quant/pairs-engine pairs-engine backtest
   ```

   Train window first, then the one-shot holdout, per candidate, net of the plan's costs; the artefact lands as `backtest-<runDate>.json` and the summary prints how many pairs the stated gates selected. The holdout is spent by this run: if its numbers send you back to change thresholds or swap pairs, iterate inside the training window only (pairs trading plan, Week 4).
5. **Publish the artefacts to the API** (integration plan §7, slices 2 and 4). Once, mint a refresh token with the IAM-gated admin flow (values in angle brackets from the Auth stack outputs; the leading space keeps the password out of zsh history):

   ```sh
    aws cognito-idp admin-initiate-auth --user-pool-id <UserPoolId> \
      --client-id <WebClientId> --auth-flow ADMIN_USER_PASSWORD_AUTH \
      --auth-parameters USERNAME=you@example.com,PASSWORD='...'
   ```

   `AuthenticationResult.RefreshToken` is the credential the engine keeps; it lives 30 days (the pool default, pinned by the auth invariants), and re-minting is this same command. Then, with the API base being the site origin (CloudFront fronts `/v1/*`) or the Api stack's ApiEndpoint output:

   ```sh
    PLAINSIGHT_API_URL=<ApiEndpoint> \
      PLAINSIGHT_COGNITO_CLIENT_ID=<WebClientId> \
      PLAINSIGHT_COGNITO_REFRESH_TOKEN=... \
      uv run --directory quant/pairs-engine pairs-engine publish
   ```

   The publish is idempotent by run date, and one kind rides per call: the command above publishes the scan; add `--kind backtest` (same environment) for the backtest artefact. The GET half of the route pair serves latest plus history to the Pairs surfaces: Research reads the scan, Backtest reads the backtest.

## Pairs sleeve: the paper cycle

The two live jobs run against the paper login first (pairs trading plan, Weeks 5 to 8); the code is identical for live, and only the TWS port and login select which. Everything below is operator-run on the operator's machine; the app renders artefacts and never trades.

1. **Once: the broker side.** Open the IB paper account, run TWS or IB Gateway with the paper login (port 7497), subscribe the ASX market data feed, and install the engine's broker client: `uv sync --extra live` from `quant/pairs-engine` (ib_async is never a CI dependency).
2. **Once: deploy the pairs.** `uv run pairs-engine init-live` scaffolds `live/config.json` from the newest backtest's selected pairs; size each pair's `capital` by hand (the plan's Week 9 allocation logic; zero refuses to compute). The `live/` directory is git-ignored operator state: the book, targets, fills, P&L and events.
3. **The daily cycle.** After the close (the plan runs 18:30 AEST): `uv run pairs-engine compute`, then publish the daily artefact (`--kind daily`). Next morning after the staggered open (10:15 AEST): `uv run pairs-engine execute`, which reconciles the book against the broker before any order and works the deltas as capped limit orders; it rewrites the daily artefact with the fresh reconciliation, so publish `--kind daily` again after it. Cron both once the manual cycle feels boring; the app's live surface says loudly when a nightly report goes stale.
4. **Weekly.** `uv run pairs-engine weekly` re-tests cointegration on the live pairs, measures beta drift, pair correlation and tracking error, and writes the weekly artefact; publish `--kind weekly`.
5. **The halt drill, once on purpose (integration plan §7, slice 5's exit criterion).** Perturb a position in the paper account by hand (buy one share of a deployed leg outside the system), run `execute`, and watch it halt with no orders; the daily artefact carries the halted reconciliation, `/pairs/live` renders it as an alert, and publishing that artefact nudges the account alert topic (integration plan §10, built 2026-07-30), so the drill also proves the email arrives; it lands only once the alert subscription is confirmed (step 8 of the go-live list). A standing halt re-alerts on every publish, deliberately. Resolve the paper position, `uv run pairs-engine clear-halt`, and the next execute run re-reconciles from scratch. A halt you have rehearsed is a control; one you meet first in anger is a surprise.

## Rebuild from zero (the drill)

Everything is IaC plus exactly two out-of-band artefacts: the CDK bootstrap and the contact parameter. From an empty account, run go-live steps 2 to 7. Canonical data needs no restore: any ticker re-ingests on demand and the weekly sweep refreshes the watched set. The owner's research lives on the owner's devices (and from Phase 3, the table's user partitions restore via point-in-time recovery). Exercise the drill on a rehearsal overlay when an infra change deserves it (`--context env=rehearsal`; see the infra README).

## Dead-letter queue drain

Signal: the sweep DLQ depth alarm. Each message carries the failing ticker and its error.

1. Read without deleting: `aws sqs receive-message --queue-url <queue url> --max-number-of-messages 10 --visibility-timeout 300`.
2. Re-run the ingest for each ticker by hand; the per-ticker lock makes repeats harmless:

   ```sh
   aws lambda invoke --function-name <IngestFunctionName> \
     --cli-binary-format raw-in-base64-out \
     --payload '{"ticker":"WES","mode":"sweep"}' /tmp/out.json && cat /tmp/out.json
   ```

3. On success, delete the message with its receipt handle. A ticker that keeps failing: read its function logs and X-Ray trace (the traced path); if the filing data itself fails the gates, the year is in quarantine (below) by design and the DLQ entry can be deleted.

## Quarantine review

Gate-failed years are held on the ticker's partition under quarantine sort keys, never served (backend spec §5). List a ticker's holdings:

```sh
aws dynamodb query --table-name <TableName> \
  --key-condition-expression 'PK = :p AND begins_with(SK, :q)' \
  --expression-attribute-values '{":p":{"S":"TICKER#WES"},":q":{"S":"QUAR#"}}'
```

Each item records the fiscal year, the failure reasons, and the rows as mapped. If the filing is genuinely inconsistent, leave it: the blast radius is that one year, and the served years name the gap. If the mapping misread the filing, fix the mapping in `apps/api` (golden tests first, bump the mapping version), re-ingest the ticker, and delete the quarantine item.

## Extraction quota reset

The 10-per-month upload-extraction quota refunds itself when an attempt dies before any provider is called (backend spec §6, amended 2026-07-20), so keyless or misconfigured tries do not eat the month. The manual reset exists for the pathological remainder: a crash losing a refund, or a month burnt by real provider failures that spent money but produced nothing worth keeping. Zero the month's counter (`<sub>` is the Cognito user id from the ID token; the month is `YYYY-MM`):

```sh
aws dynamodb update-item --table-name <TableName> \
  --key '{"PK":{"S":"USER#<sub>"},"SK":{"S":"QUOTA#<YYYY-MM>"}}' \
  --update-expression 'SET jobs = :zero' \
  --expression-attribute-values '{":zero":{"N":"0"}}'
```

The counter also resets itself by construction on the first of each month (the key carries the month), so doing nothing is always an option.

## Kill-chain drill (fire it once on purpose)

The protection chain (budget threshold → kill topic → flipper → SSM flag → extraction declining → relay email) has several links that fail silent, so it is not trusted until it has been watched firing. Delivery is the signal and the flipper parses nothing, so a hand-published message is indistinguishable from the real event and drills every link downstream of Budgets:

```sh
aws sns publish --topic-arn arn:aws:sns:ap-southeast-2:<account-id>:plainsight-prod-kill-switch \
  --message 'deliberate kill-chain drill (runbook)'
```

Within a minute, confirm all three effects: the flag flipped (`aws ssm get-parameter --name /app/prod/features/extraction --query Parameter.Value` reads `false`), the relay email from the alert topic arrived (which also proves the email subscription), and an extraction request answers with the feature-disabled envelope. Then reset per the section below. The one link the drill cannot exercise is Budgets itself publishing at threshold: that is AWS-managed delivery against real spend, and its side of the contract (the topic policy granting `budgets.amazonaws.com` publish) is pinned by the invariant suite.

## Kill-switch reset

At the budget's kill threshold, the flipper sets `/app/prod/features/extraction` to `false`; extraction-spending paths answer with the feature-disabled envelope the client renders as its known state. After understanding the spend (Cost Explorer; the budget emails):

```sh
aws ssm put-parameter --name /app/prod/features/extraction --value true --overwrite
```

Two notes: the flag gates extraction only (Phase 2.5's spender: the extraction function reads it within a minute of a flip and declines before touching a key); the read API and the sweep cannot spend meaningfully. And a CloudFormation redeploy of Foundation resets the runtime flags to their template defaults, so re-check the flag after Foundation deploys.

## Rollback

- **App**: re-run the app workflow from the previous commit; the shell redeploys in minutes.
- **Stateless stacks**: `cdk deploy` at the previous git ref.
- **Data**: structurally protected (RETAIN, deletion protection, point-in-time recovery); data-loss operations are blocked by construction.
- **Posture**: turning the feature flags off in `prod.ts` removes the Phase 2 stacks from synth entirely; that features-off posture stays under test (zero compute, the single-origin distribution) as the standing rollback target.
