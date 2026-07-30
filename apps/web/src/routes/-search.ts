/**
 * Typed search-param contracts (frontend spec §1.1). Sheets and modals encode
 * their state in query params, validated here so `?metric=roe` is a contract
 * the compiler checks rather than a string the runtime parses. Unrecognised
 * values drop to undefined instead of throwing: a stale bookmark or a mangled
 * link degrades to the plain screen, never to an error boundary.
 */
import {
  isFyLabel,
  LINE_ITEM_IDS,
  METRIC_IDS,
  STATEMENT_KINDS,
  type FyLabel,
  type MetricId,
  type StatementKind
} from '@plainsight/calc-engine';
import { z } from 'zod';

// Built from the engine's own constants and guards, never from the storage
// layer: route definitions load with the shell, and dragging Dexie into that
// chunk would weigh the first paint down for nothing.
const metricParam = z.enum(METRIC_IDS as readonly [MetricId, ...MetricId[]]);
const statementParam = z.enum(STATEMENT_KINDS as readonly [StatementKind, ...StatementKind[]]);
const lineItemParam = z.enum(LINE_ITEM_IDS);
const fyParam = z.custom<FyLabel>((value) => typeof value === 'string' && isFyLabel(value));

/**
 * The dashboard's sheet state: `?metric=roe` opens that metric's detail
 * sheet, `?details=1` the company details sheet (frontend spec §3), each
 * addressable and closed by the system back gesture.
 */
export const dashboardSearchSchema = z.object({
  metric: metricParam.optional().catch(undefined),
  details: z.literal(1).optional().catch(undefined)
});

export type DashboardSearch = z.infer<typeof dashboardSearchSchema>;

/**
 * The entry screen's deep-link params, pinned by data-model spec §10:
 * `?stmt=<statement>&fy=<label>&focus=<lineItemId>` lands on the first
 * missing item behind an insufficient-data card.
 */
export const entrySearchSchema = z.object({
  stmt: statementParam.optional().catch(undefined),
  fy: fyParam.optional().catch(undefined),
  focus: lineItemParam.optional().catch(undefined),
  /** An in-page extraction job (frontend spec §3): review mode takes the entry layout over while it exists. */
  job: z.string().optional().catch(undefined),
  /** The file-upload sheet (frontend spec §1.1 URL rules): open while present, so the back gesture closes it. */
  upload: z.literal(1).optional().catch(undefined)
});

export type EntrySearch = z.infer<typeof entrySearchSchema>;

/** The thesis editor's history sheet encodes in `?history=1` (frontend spec §1.1). */
export const thesisSearchSchema = z.object({
  history: z.literal(1).optional().catch(undefined)
});

export type ThesisSearch = z.infer<typeof thesisSearchSchema>;

/**
 * The compare screen's selection: `?ids=a,b,c`, comma-separated company ids
 * (frontend spec §1.1), plus the trend chart's `?metric=`. The shape is all
 * the schema can know; which ids exist is the library's business, so unknown
 * ones drop at render time and a stale bookmark degrades to the picker
 * instead of an error. A metric the trend cannot show (hidden money row in a
 * mixed-currency comparison) degrades to the default at render time the same
 * way.
 */
export const compareSearchSchema = z.object({
  ids: z.string().optional().catch(undefined),
  metric: metricParam.optional().catch(undefined)
});

export type CompareSearch = z.infer<typeof compareSearchSchema>;

/**
 * The pairs research screen (integration plan §4): `?pair=AAA-BBB` opens
 * that pair's detail sheet (closed by the system back gesture, the house
 * rule), and `?view=` picks the matrix's measure. Unknown values degrade
 * to the plain screen, like every other search contract here.
 */
export const pairsSearchSchema = z.object({
  pair: z.string().optional().catch(undefined),
  view: z
    .enum(['correlation', 'cointegration'])
    .optional()
    .catch(undefined)
});

export type PairsSearch = z.infer<typeof pairsSearchSchema>;

/**
 * The backtest surface (integration plan §4, slice 4): `?pair=AAA-BBB`
 * focuses one backtested pair; absent, the first pair renders.
 */
export const backtestSearchSchema = z.object({
  pair: z.string().optional().catch(undefined)
});

export type BacktestSearch = z.infer<typeof backtestSearchSchema>;

/**
 * The live surface (integration plan §4, slice 5): `?pair=AAA-BBB`
 * focuses one deployed pair's spread panel; absent, the first renders.
 */
export const liveSearchSchema = z.object({
  pair: z.string().optional().catch(undefined)
});

export type LiveSearch = z.infer<typeof liveSearchSchema>;
