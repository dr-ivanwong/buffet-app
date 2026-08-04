/**
 * The pairs transport handlers against an in-memory store: publish lands
 * a run per kind and is idempotent by run date; the read serves latest
 * plus history for that kind; an unknown kind is not found; and every
 * failure mode answers with the error envelope.
 */
import { readFileSync } from 'node:fs';
import {
  errorEnvelopeSchema,
  pairsArtefactCollectionSchema,
  pairsArtefactRunSchema,
  pairsBacktestCollectionSchema,
  type PairsArtefactRun
} from '@plainsight/api-contract';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { createGetPairsArtefactHandler } from '../src/handlers/getPairsArtefact.js';
import { createPutPairsArtefactHandler } from '../src/handlers/putPairsArtefact.js';
import type {
  PairsArtefactKind,
  PairsArtefactStore,
  PairsReportMeta
} from '../src/db/pairsStore.js';

const fixtureBody = (name: string): string =>
  readFileSync(new URL(`../../../packages/api-contract/fixtures/${name}`, import.meta.url), 'utf8');

const scanBody = fixtureBody('pair-scan.golden.json');
const backtestBody = fixtureBody('backtest.golden.json');

/** The golden daily fixture with its reconciliation flipped to halted. */
function haltedDailyBody(): string {
  const report = JSON.parse(fixtureBody('daily.golden.json')) as Record<string, unknown>;
  report['reconciliation'] = {
    status: 'halted',
    checkedAt: '2026-07-30T00:20:00Z',
    mismatches: [{ ticker: 'BBB', book: -10, broker: -7 }]
  };
  return JSON.stringify(report);
}

class FakeAlerter {
  readonly messages: { subject: string; message: string }[] = [];
  async publishHalt(subject: string, message: string): Promise<void> {
    this.messages.push({ subject, message });
  }
}

class FakePairsStore implements PairsArtefactStore {
  readonly reports = new Map<string, unknown>();
  readonly rows = new Map<string, PairsArtefactRun>();

  private key(kind: PairsArtefactKind, runDate: string): string {
    return `${kind}|${runDate}`;
  }

  async putRun(
    kind: PairsArtefactKind,
    report: PairsReportMeta,
    receivedAt: string
  ): Promise<PairsArtefactRun> {
    const row: PairsArtefactRun = {
      runDate: report.runDate,
      engineVersion: report.engineVersion,
      schemaVersion: report.schemaVersion,
      generatedAt: report.generatedAt,
      receivedAt,
      sizeBytes: Buffer.byteLength(JSON.stringify(report))
    };
    this.reports.set(this.key(kind, report.runDate), JSON.parse(JSON.stringify(report)) as unknown);
    this.rows.set(this.key(kind, report.runDate), row);
    return row;
  }

  async listRuns(kind: PairsArtefactKind): Promise<PairsArtefactRun[]> {
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${kind}|`))
      .map(([, row]) => row)
      .sort((a, b) => b.runDate.localeCompare(a.runDate));
  }

  async getReport(kind: PairsArtefactKind, runDate: string): Promise<unknown> {
    const report = this.reports.get(this.key(kind, runDate));
    if (report === undefined) throw new Error(`no ${kind} report for ${runDate}`);
    return report;
  }
}

function authedEvent(kind: string, body?: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body,
    pathParameters: { kind },
    requestContext: {
      requestId: 'req_test',
      authorizer: { jwt: { claims: { sub: 'owner-1' } } }
    }
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function anonymousEvent(kind: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { kind },
    requestContext: { requestId: 'req_test' }
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const bodyOf = (result: { body?: string | undefined }): unknown => JSON.parse(result.body ?? '');

describe('PUT /v1/pairs/artefacts/{kind}', () => {
  it('stores a valid scan artefact and answers with the run row', async () => {
    const store = new FakePairsStore();
    const put = createPutPairsArtefactHandler(store, () => new Date('2026-07-22T10:00:00Z'));
    const result = await put(authedEvent('pair-scan', scanBody));
    expect(result.statusCode).toBe(200);
    const row = pairsArtefactRunSchema.parse(bodyOf(result));
    expect(row.runDate).toBe('2024-01-26');
    expect(row.receivedAt).toBe('2026-07-22T10:00:00.000Z');
    expect(store.rows.size).toBe(1);
  });

  it('stores every kind beside the others, separately', async () => {
    const store = new FakePairsStore();
    const put = createPutPairsArtefactHandler(store);
    await put(authedEvent('pair-scan', scanBody));
    await put(authedEvent('backtest', backtestBody));
    const daily = await put(authedEvent('daily', fixtureBody('daily.golden.json')));
    const weekly = await put(authedEvent('weekly', fixtureBody('weekly.golden.json')));
    expect(daily.statusCode).toBe(200);
    expect(weekly.statusCode).toBe(200);
    expect(store.rows.size).toBe(4);
    expect(await store.listRuns('daily')).toHaveLength(1);
    expect(await store.listRuns('weekly')).toHaveLength(1);
  });

  it('is idempotent by run date within a kind', async () => {
    const store = new FakePairsStore();
    const put = createPutPairsArtefactHandler(store);
    await put(authedEvent('pair-scan', scanBody));
    await put(authedEvent('pair-scan', scanBody));
    expect(store.rows.size).toBe(1);
  });

  it('answers not found for an unknown kind, storing nothing', async () => {
    const store = new FakePairsStore();
    const result = await createPutPairsArtefactHandler(store)(authedEvent('hourly', scanBody));
    expect(result.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(bodyOf(result)).error.code).toBe('not_found');
    expect(store.rows.size).toBe(0);
  });

  it('refuses a kind-body mismatch as a schema failure', async () => {
    const result = await createPutPairsArtefactHandler(new FakePairsStore())(
      authedEvent('backtest', scanBody)
    );
    expect(result.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(bodyOf(result)).error.code).toBe('invalid_request');
  });

  it('refuses an unauthenticated call, the belt to the authoriser braces', async () => {
    const result = await createPutPairsArtefactHandler(new FakePairsStore())(
      anonymousEvent('pair-scan')
    );
    expect(result.statusCode).toBe(401);
  });

  it('refuses a body that is not JSON', async () => {
    const result = await createPutPairsArtefactHandler(new FakePairsStore())(
      authedEvent('pair-scan', 'not json')
    );
    expect(result.statusCode).toBe(400);
  });

  it('answers internal when the store fails', async () => {
    const store = new FakePairsStore();
    store.putRun = async () => {
      throw new Error('table unavailable');
    };
    const result = await createPutPairsArtefactHandler(store)(authedEvent('pair-scan', scanBody));
    expect(result.statusCode).toBe(500);
  });

  it('nudges the alert topic when a daily artefact carries a halt', async () => {
    const alerter = new FakeAlerter();
    const put = createPutPairsArtefactHandler(new FakePairsStore(), undefined, alerter);
    const result = await put(authedEvent('daily', haltedDailyBody()));
    expect(result.statusCode).toBe(200);
    expect(alerter.messages).toHaveLength(1);
    const alert = alerter.messages[0];
    expect(alert?.subject).toBe('Plainsight pairs: the book is halted');
    expect(alert?.message).toContain('BBB (book -10, broker -7)');
    expect(alert?.message).toContain('clear-halt');
  });

  it('stays quiet for a clean daily artefact', async () => {
    const alerter = new FakeAlerter();
    const put = createPutPairsArtefactHandler(new FakePairsStore(), undefined, alerter);
    await put(authedEvent('daily', fixtureBody('daily.golden.json')));
    expect(alerter.messages).toHaveLength(0);
  });

  it('stores the halted artefact even when the alert cannot send', async () => {
    const store = new FakePairsStore();
    const failing = {
      publishHalt: async () => {
        throw new Error('sns unavailable');
      }
    };
    const result = await createPutPairsArtefactHandler(store, undefined, failing)(
      authedEvent('daily', haltedDailyBody())
    );
    expect(result.statusCode).toBe(200);
    expect(store.rows.size).toBe(1);
  });
});

describe('GET /v1/pairs/artefacts/{kind}', () => {
  it('serves the empty sleeve as a 200 with a null latest', async () => {
    const result = await createGetPairsArtefactHandler(new FakePairsStore())(
      authedEvent('pair-scan')
    );
    expect(result.statusCode).toBe(200);
    expect(pairsArtefactCollectionSchema.parse(bodyOf(result))).toEqual({
      latest: null,
      history: []
    });
  });

  it('serves each kind its own latest and history', async () => {
    const store = new FakePairsStore();
    const put = createPutPairsArtefactHandler(store);
    await put(authedEvent('pair-scan', scanBody));
    await put(authedEvent('backtest', backtestBody));

    const scan = await createGetPairsArtefactHandler(store)(authedEvent('pair-scan'));
    const scanCollection = pairsArtefactCollectionSchema.parse(bodyOf(scan));
    expect(scanCollection.latest?.artefact).toBe('pairScanReport');

    const backtest = await createGetPairsArtefactHandler(store)(authedEvent('backtest'));
    const backtestCollection = pairsBacktestCollectionSchema.parse(bodyOf(backtest));
    expect(backtestCollection.latest?.artefact).toBe('backtestReport');
    expect(backtestCollection.latest?.pairs).toHaveLength(1);
    expect(backtestCollection.history).toHaveLength(1);
  });

  it('answers not found for an unknown kind', async () => {
    const result = await createGetPairsArtefactHandler(new FakePairsStore())(
      authedEvent('hourly')
    );
    expect(result.statusCode).toBe(404);
  });

  it('refuses an unauthenticated read', async () => {
    const result = await createGetPairsArtefactHandler(new FakePairsStore())(
      anonymousEvent('pair-scan')
    );
    expect(result.statusCode).toBe(401);
  });

  it('surfaces a stored artefact that no longer parses as internal', async () => {
    const store = new FakePairsStore();
    await createPutPairsArtefactHandler(store)(authedEvent('pair-scan', scanBody));
    store.reports.set('pair-scan|2024-01-26', { artefact: 'corrupted' });
    const result = await createGetPairsArtefactHandler(store)(authedEvent('pair-scan'));
    expect(result.statusCode).toBe(500);
  });

  it('answers internal when the store fails', async () => {
    const store = new FakePairsStore();
    store.listRuns = async () => {
      throw new Error('table unavailable');
    };
    const result = await createGetPairsArtefactHandler(store)(authedEvent('pair-scan'));
    expect(result.statusCode).toBe(500);
  });
});
