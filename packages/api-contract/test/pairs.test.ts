/**
 * The read side of the contract mirror. The fixture in fixtures/ is
 * written by the engine (pairs_engine.golden, byte-pinned over there);
 * parsing it here is what makes drift on either side a test failure.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKTEST_ARTEFACT_KIND,
  backtestReportSchema,
  dailyPairsReportSchema,
  PAIR_SCAN_ARTEFACT_KIND,
  pairsArtefactCollectionSchema,
  pairsArtefactRunSchema,
  pairsBacktestCollectionSchema,
  pairsDailyCollectionSchema,
  pairsWeeklyCollectionSchema,
  pairScanReportSchema,
  weeklyMonitoringReportSchema
} from '../src/index.js';

const fixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/pair-scan.golden.json', import.meta.url), 'utf8')
);

const backtestFixture: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/backtest.golden.json', import.meta.url), 'utf8')
);

const run = {
  runDate: '2024-01-26',
  engineVersion: '0.1.0',
  schemaVersion: 1,
  generatedAt: '2026-07-22T09:30:00Z',
  receivedAt: '2026-07-22T09:31:11Z',
  sizeBytes: 2048
};

describe('the pair scan report schema', () => {
  it('parses the engine-written golden fixture', () => {
    const report = pairScanReportSchema.parse(fixture);
    expect(report.artefact).toBe(PAIR_SCAN_ARTEFACT_KIND);
    // The provenance stamp: golden closes declare their synthetic
    // origin, and a foreign source name is rejected on both sides.
    expect(report.closesSource).toBe('synthetic');
    expect(
      pairScanReportSchema.safeParse({ ...report, closesSource: 'bloomberg' }).success
    ).toBe(false);
    expect(report.universe).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
    // Ten choose-two pairs, reconciled exactly: tested plus skipped.
    expect(report.pairsTested + report.skipped.length).toBe(10);
    expect(report.pairs).toHaveLength(report.pairsTested);
    for (const skipped of report.skipped) {
      expect([skipped.ticker1, skipped.ticker2]).toContain('EEE');
    }
    const planted = report.candidates.find(
      (candidate) => candidate.ticker1 === 'AAA' && candidate.ticker2 === 'BBB'
    );
    expect(planted).toBeDefined();
    expect(Math.abs((planted?.beta ?? 0) - 2.5)).toBeLessThan(0.05);
    // Every candidate also appears in the full pair table, flagged.
    for (const candidate of report.candidates) {
      const row = report.pairs.find(
        (pair) => pair.ticker1 === candidate.ticker1 && pair.ticker2 === candidate.ticker2
      );
      expect(row?.candidate).toBe(true);
    }
  });

  it('rejects a wrong artefact kind, schema version, or skip reason', () => {
    const report = pairScanReportSchema.parse(fixture);
    expect(pairScanReportSchema.safeParse({ ...report, artefact: 'somethingElse' }).success).toBe(false);
    expect(pairScanReportSchema.safeParse({ ...report, schemaVersion: 2 }).success).toBe(false);
    expect(
      pairScanReportSchema.safeParse({
        ...report,
        skipped: [{ ticker1: 'AAA', ticker2: 'EEE', sharedTrainDays: 3, reason: 'gutFeel' }]
      }).success
    ).toBe(false);
    expect(pairScanReportSchema.safeParse({ ...report, runDate: '26/01/2024' }).success).toBe(false);
  });
});

describe('the backtest report schema', () => {
  it('parses the engine-written backtest fixture with its windows separate', () => {
    const report = backtestReportSchema.parse(backtestFixture);
    expect(report.artefact).toBe(BACKTEST_ARTEFACT_KIND);
    expect(report.scanRunDate).toBe(report.runDate);
    const pair = report.pairs[0];
    expect(pair).toBeDefined();
    if (pair === undefined) throw new Error('fixture carries one pair');
    // Train ends at or before the split; the warm-started holdout scores
    // only days after it. The frozen holdout is visible in the data.
    expect(pair.train.end <= report.window.splitDate).toBe(true);
    expect(pair.holdout.start > report.window.splitDate).toBe(true);
    expect(pair.train.equity.dates).toHaveLength(pair.train.equity.values.length);
    expect(pair.train.trades.length).toBe(pair.train.tradeCount);
    // The fixture's planted pair honestly fails the net gates: the cost
    // model eats a half-sigma spread, which is the point of testing net.
    expect(pair.selected).toBe(false);
    expect(pair.gates.significance).toBe(true);
    expect(pair.gates.trainSharpe).toBe(false);
    // Round trips reconcile to the equity curve's total.
    const total = pair.train.trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const last = pair.train.equity.values.at(-1) ?? 0;
    expect(Math.abs(total - (last - pair.train.capitalPerUnit))).toBeLessThan(0.01);
  });

  it('rejects a misaligned equity series and a foreign exit reason', () => {
    const report = backtestReportSchema.parse(backtestFixture);
    const pair = report.pairs[0];
    if (pair === undefined) throw new Error('fixture carries one pair');
    expect(
      backtestReportSchema.safeParse({
        ...report,
        pairs: [
          {
            ...pair,
            train: { ...pair.train, equity: { dates: ['2021-01-04'], values: [1, 2] } }
          }
        ]
      }).success
    ).toBe(false);
    expect(
      backtestReportSchema.safeParse({
        ...report,
        pairs: [
          {
            ...pair,
            train: {
              ...pair.train,
              trades: [{ ...pair.train.trades[0], exitReason: 'vibes' }]
            }
          }
        ]
      }).success
    ).toBe(false);
  });

  it('collects like the scan kind: a nullable latest plus history', () => {
    expect(pairsBacktestCollectionSchema.parse({ latest: null, history: [] })).toEqual({
      latest: null,
      history: []
    });
    const populated = pairsBacktestCollectionSchema.parse({
      latest: backtestFixture,
      history: [run]
    });
    expect(populated.latest?.pairs).toHaveLength(1);
  });
});

describe('the daily and weekly report schemas', () => {
  const dailyFixture: unknown = JSON.parse(
    readFileSync(new URL('../fixtures/daily.golden.json', import.meta.url), 'utf8')
  );
  const weeklyFixture: unknown = JSON.parse(
    readFileSync(new URL('../fixtures/weekly.golden.json', import.meta.url), 'utf8')
  );

  it('parses the engine-written daily fixture with its panels aligned', () => {
    const report = dailyPairsReportSchema.parse(dailyFixture);
    expect(report.paper).toBe(true);
    expect(report.reconciliation.status).toBe('clean');
    const pair = report.pairs[0];
    if (pair === undefined) throw new Error('fixture carries one pair');
    expect(pair.zSeries.dates).toHaveLength(pair.zSeries.values.length);
    expect(pair.legs).toHaveLength(2);
    expect(report.fills.length).toBeGreaterThan(0);
    expect(report.pnl.dates).toHaveLength(report.pnl.cumulative.length);
    expect(report.pnl.declaredMaxDrawdownPct).toBe(12);
    const collection = pairsDailyCollectionSchema.parse({ latest: dailyFixture, history: [run] });
    expect(collection.latest?.artefact).toBe('dailyPairsReport');
  });

  it('rejects misaligned P&L series and a foreign reconciliation status', () => {
    const report = dailyPairsReportSchema.parse(dailyFixture);
    expect(
      dailyPairsReportSchema.safeParse({
        ...report,
        pnl: { ...report.pnl, daily: report.pnl.daily.slice(1) }
      }).success
    ).toBe(false);
    expect(
      dailyPairsReportSchema.safeParse({
        ...report,
        reconciliation: { ...report.reconciliation, status: 'vibes' }
      }).success
    ).toBe(false);
  });

  it('parses the engine-written weekly fixture', () => {
    const report = weeklyMonitoringReportSchema.parse(weeklyFixture);
    const row = report.pairs[0];
    if (row === undefined) throw new Error('fixture carries one pair');
    expect(row.pValueNow).toBeLessThan(0.05);
    expect(row.trackingErrorBps).not.toBeNull();
    const collection = pairsWeeklyCollectionSchema.parse({ latest: weeklyFixture, history: [run] });
    expect(collection.latest?.artefact).toBe('weeklyMonitoringReport');
    expect(pairsWeeklyCollectionSchema.parse({ latest: null, history: [] }).latest).toBeNull();
  });
});

describe('the run and collection schemas', () => {
  it('accepts a stored run and rejects a negative size', () => {
    expect(pairsArtefactRunSchema.parse(run)).toEqual(run);
    expect(pairsArtefactRunSchema.safeParse({ ...run, sizeBytes: -1 }).success).toBe(false);
  });

  it('accepts the empty collection and the populated one', () => {
    expect(pairsArtefactCollectionSchema.parse({ latest: null, history: [] })).toEqual({
      latest: null,
      history: []
    });
    const populated = pairsArtefactCollectionSchema.parse({
      latest: fixture,
      history: [run]
    });
    expect(populated.latest?.runDate).toBe('2024-01-26');
    expect(populated.history).toHaveLength(1);
  });
});
