/**
 * The pairs sleeve's artefact contract (integration plan §4): the read
 * side of the schemas the engine writes with pydantic. The two are
 * mirrored against one committed golden fixture: the engine's suite pins
 * its serialisation to the fixture's bytes, and this package parses the
 * same bytes, so schema drift on either side fails a test, never a
 * render. Regeneration lives with the engine (pairs_engine.golden).
 */
import { z } from 'zod';

const nonEmpty = z.string().min(1);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

/** Where a report's closes came from; the artefacts carry the stamp so a
 * research-phase scan can never masquerade as licensed-grade later. */
export const CLOSE_SOURCES = ['eodhd', 'yahoo', 'ib', 'synthetic'] as const;
const closesSource = z.enum(CLOSE_SOURCES).nullable().optional();

export const PAIR_SCAN_ARTEFACT_KIND = 'pairScanReport';
export const PAIR_SCAN_SCHEMA_VERSION = 1;

/** The engine's skip reasons; a new reason is a schema change on both sides. */
export const PAIR_SKIP_REASONS = ['insufficientSharedHistory', 'cointegrationTestFailed'] as const;

export const pairScanWindowSchema = z.object({
  start: isoDate,
  end: isoDate,
  splitDate: isoDate,
  trainFraction: z.number().positive(),
  minSharedTrainDays: z.number().int().positive()
});

export const pairScanCriteriaSchema = z.object({
  maxPValue: z.number().positive(),
  maxCandidateHalfLifeDays: z.number().positive(),
  halfLifeCeilingDays: z.number().positive(),
  minAbsRegressionR: z.number().positive(),
  requirePositiveBeta: z.boolean()
});

export const pairRowSchema = z.object({
  ticker1: nonEmpty,
  ticker2: nonEmpty,
  sharedTrainDays: z.number().int().nonnegative(),
  pValue: z.number(),
  beta: z.number(),
  intercept: z.number(),
  correlation: z.number(),
  halfLifeDays: z.number().nullable(),
  halfLifeValid: z.boolean(),
  candidate: z.boolean()
});

export const skippedPairSchema = z.object({
  ticker1: nonEmpty,
  ticker2: nonEmpty,
  sharedTrainDays: z.number().int().nonnegative(),
  reason: z.enum(PAIR_SKIP_REASONS)
});

export const pairCandidateSchema = z.object({
  ticker1: nonEmpty,
  ticker2: nonEmpty,
  beta: z.number(),
  pValue: z.number(),
  halfLifeDays: z.number(),
  correlation: z.number()
});

export const pairScanReportSchema = z.object({
  artefact: z.literal(PAIR_SCAN_ARTEFACT_KIND),
  schemaVersion: z.literal(PAIR_SCAN_SCHEMA_VERSION),
  engineVersion: nonEmpty,
  runDate: isoDate,
  generatedAt: isoDateTime,
  closesSource,
  universe: z.array(nonEmpty),
  window: pairScanWindowSchema,
  criteria: pairScanCriteriaSchema,
  pairsTested: z.number().int().nonnegative(),
  pairs: z.array(pairRowSchema),
  skipped: z.array(skippedPairSchema),
  candidates: z.array(pairCandidateSchema)
});

export const BACKTEST_ARTEFACT_KIND = 'backtestReport';
export const BACKTEST_SCHEMA_VERSION = 1;

/** The engine's exit reasons; a new reason is a schema change on both sides. */
export const BACKTEST_EXIT_REASONS = ['exitBand', 'zStop', 'timeStop', 'windowEnd'] as const;

export const backtestSeriesSchema = z
  .object({
    dates: z.array(isoDate),
    values: z.array(z.number())
  })
  .refine((series) => series.dates.length === series.values.length, {
    message: 'equity dates and values must align one to one'
  });

export const backtestTradeSchema = z.object({
  entryDate: isoDate,
  exitDate: isoDate.nullable(),
  direction: z.union([z.literal(1), z.literal(-1)]),
  daysHeld: z.number().int().nonnegative(),
  pnl: z.number(),
  exitReason: z.enum(BACKTEST_EXIT_REASONS)
});

export const backtestWindowResultSchema = z.object({
  start: isoDate,
  end: isoDate,
  totalReturnPct: z.number(),
  annualSharpe: z.number(),
  maxDrawdownPct: z.number(),
  winRatePct: z.number(),
  tradeCount: z.number().int().nonnegative(),
  profitFactor: z.number(),
  capitalPerUnit: z.number().positive(),
  equity: backtestSeriesSchema,
  trades: z.array(backtestTradeSchema)
});

export const backtestGatesSchema = z.object({
  significance: z.boolean(),
  trainSharpe: z.boolean(),
  trainDrawdown: z.boolean(),
  trainWinRate: z.boolean(),
  holdoutSharpe: z.boolean()
});

export const backtestPairSchema = z.object({
  ticker1: nonEmpty,
  ticker2: nonEmpty,
  beta: z.number(),
  scanPValue: z.number(),
  scanHalfLifeDays: z.number().nullable(),
  train: backtestWindowResultSchema,
  holdout: backtestWindowResultSchema,
  gates: backtestGatesSchema,
  selected: z.boolean()
});

export const backtestAssumptionsSchema = z.object({
  lookbackDays: z.number().int().positive(),
  entryZ: z.number().positive(),
  exitZ: z.number().positive(),
  stopZ: z.number().positive(),
  maxHoldDays: z.number().int().positive(),
  costBpsPerSide: z.number().nonnegative(),
  borrowBpsPerAnnum: z.number().nonnegative()
});

export const backtestCriteriaSchema = z.object({
  maxPreselectionPValue: z.number().positive(),
  trainMinSharpe: z.number(),
  trainMaxDrawdownPct: z.number(),
  trainMinWinRatePct: z.number(),
  holdoutMinSharpe: z.number()
});

export const backtestWindowSpecSchema = z.object({
  start: isoDate,
  end: isoDate,
  splitDate: isoDate,
  trainFraction: z.number().positive()
});

export const backtestReportSchema = z.object({
  artefact: z.literal(BACKTEST_ARTEFACT_KIND),
  schemaVersion: z.literal(BACKTEST_SCHEMA_VERSION),
  engineVersion: nonEmpty,
  runDate: isoDate,
  generatedAt: isoDateTime,
  closesSource,
  scanRunDate: isoDate,
  window: backtestWindowSpecSchema,
  assumptions: backtestAssumptionsSchema,
  criteria: backtestCriteriaSchema,
  pairs: z.array(backtestPairSchema)
});

export const DAILY_ARTEFACT_KIND = 'dailyPairsReport';
export const DAILY_SCHEMA_VERSION = 1;
export const WEEKLY_ARTEFACT_KIND = 'weeklyMonitoringReport';
export const WEEKLY_SCHEMA_VERSION = 1;

export const DAILY_RECONCILIATION_STATUSES = ['clean', 'halted', 'unchecked'] as const;

export const dailyLegSchema = z.object({
  ticker: nonEmpty,
  targetShares: z.number().int(),
  heldShares: z.number().int()
});

export const dailyPairSchema = z.object({
  ticker1: nonEmpty,
  ticker2: nonEmpty,
  beta: z.number(),
  capital: z.number().positive(),
  z: z.number(),
  spread: z.number(),
  spreadMean: z.number(),
  spreadStd: z.number(),
  stoodDown: z.boolean(),
  daysHeld: z.number().int().nonnegative(),
  heldUnits: z.number().int(),
  targetUnits: z.number().int(),
  unitGross: z.number().positive(),
  legs: z.array(dailyLegSchema),
  zSeries: backtestSeriesSchema
});

export const dailyMismatchSchema = z.object({
  ticker: nonEmpty,
  book: z.number().int(),
  broker: z.number().int()
});

export const dailyReconciliationSchema = z.object({
  status: z.enum(DAILY_RECONCILIATION_STATUSES),
  checkedAt: isoDateTime.nullable(),
  mismatches: z.array(dailyMismatchSchema)
});

export const dailyFillSchema = z.object({
  filledOn: isoDate,
  ticker: nonEmpty,
  shares: z.number().int(),
  price: z.number().positive(),
  referenceClose: z.number().positive(),
  slippageBps: z.number()
});

export const dailyPnlSchema = z
  .object({
    dates: z.array(isoDate),
    daily: z.array(z.number()),
    cumulative: z.array(z.number()),
    engineCumulative: z.array(z.number()),
    drawdownPct: z.number(),
    maxDrawdownPct: z.number(),
    declaredMaxDrawdownPct: z.number().positive(),
    grossExposure: z.number().nonnegative(),
    stopsFired: z.number().int().nonnegative(),
    roundTrips: z.number().int().nonnegative(),
    realisedCostBpsPerSide: z.number().nullable(),
    modelledCostBpsPerSide: z.number().positive()
  })
  .refine(
    (pnl) =>
      pnl.daily.length === pnl.dates.length &&
      pnl.cumulative.length === pnl.dates.length &&
      pnl.engineCumulative.length === pnl.dates.length,
    { message: 'the P&L series must align one to one' }
  );

export const dailyPairsReportSchema = z.object({
  artefact: z.literal(DAILY_ARTEFACT_KIND),
  schemaVersion: z.literal(DAILY_SCHEMA_VERSION),
  engineVersion: nonEmpty,
  runDate: isoDate,
  generatedAt: isoDateTime,
  closesSource,
  paper: z.boolean(),
  reconciliation: dailyReconciliationSchema,
  assumptions: backtestAssumptionsSchema,
  limitCapBps: z.number().positive(),
  pairs: z.array(dailyPairSchema),
  fills: z.array(dailyFillSchema),
  pnl: dailyPnlSchema
});

export const weeklyPairRowSchema = z.object({
  ticker1: nonEmpty,
  ticker2: nonEmpty,
  deployedBeta: z.number(),
  pValueNow: z.number(),
  halfLifeDaysNow: z.number().nullable(),
  refitBeta: z.number(),
  betaDriftPct: z.number(),
  trackingErrorBps: z.number().nullable()
});

export const weeklyCorrelationSchema = z.object({
  pairA: nonEmpty,
  pairB: nonEmpty,
  correlation: z.number()
});

export const weeklyMonitoringReportSchema = z.object({
  artefact: z.literal(WEEKLY_ARTEFACT_KIND),
  schemaVersion: z.literal(WEEKLY_SCHEMA_VERSION),
  engineVersion: nonEmpty,
  runDate: isoDate,
  generatedAt: isoDateTime,
  closesSource,
  pairs: z.array(weeklyPairRowSchema),
  correlations: z.array(weeklyCorrelationSchema)
});

/** One stored run: the PUT response and the history rows of the GET. */
export const pairsArtefactRunSchema = z.object({
  runDate: isoDate,
  engineVersion: nonEmpty,
  schemaVersion: z.number().int().positive(),
  generatedAt: isoDateTime,
  receivedAt: isoDateTime,
  sizeBytes: z.number().int().nonnegative()
});

/** The GET response: the latest report in full plus the run history. */
export const pairsArtefactCollectionSchema = z.object({
  latest: pairScanReportSchema.nullable(),
  history: z.array(pairsArtefactRunSchema)
});

/** The backtest kind's GET response, same envelope shape. */
export const pairsBacktestCollectionSchema = z.object({
  latest: backtestReportSchema.nullable(),
  history: z.array(pairsArtefactRunSchema)
});

/** The daily kind's GET response, same envelope shape. */
export const pairsDailyCollectionSchema = z.object({
  latest: dailyPairsReportSchema.nullable(),
  history: z.array(pairsArtefactRunSchema)
});

/** The weekly kind's GET response, same envelope shape. */
export const pairsWeeklyCollectionSchema = z.object({
  latest: weeklyMonitoringReportSchema.nullable(),
  history: z.array(pairsArtefactRunSchema)
});

export type PairScanReport = z.infer<typeof pairScanReportSchema>;
export type PairRow = z.infer<typeof pairRowSchema>;
export type PairsArtefactRun = z.infer<typeof pairsArtefactRunSchema>;
export type PairsArtefactCollection = z.infer<typeof pairsArtefactCollectionSchema>;
export type BacktestReport = z.infer<typeof backtestReportSchema>;
export type BacktestPair = z.infer<typeof backtestPairSchema>;
export type BacktestWindowResult = z.infer<typeof backtestWindowResultSchema>;
export type BacktestTrade = z.infer<typeof backtestTradeSchema>;
export type PairsBacktestCollection = z.infer<typeof pairsBacktestCollectionSchema>;
export type DailyPairsReport = z.infer<typeof dailyPairsReportSchema>;
export type DailyPair = z.infer<typeof dailyPairSchema>;
export type DailyFill = z.infer<typeof dailyFillSchema>;
export type WeeklyMonitoringReport = z.infer<typeof weeklyMonitoringReportSchema>;
export type PairsDailyCollection = z.infer<typeof pairsDailyCollectionSchema>;
export type PairsWeeklyCollection = z.infer<typeof pairsWeeklyCollectionSchema>;
