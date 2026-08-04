/**
 * PUT /v1/pairs/artefacts/{kind} (integration plan §4; backend spec §2
 * route table as amended 2026-07-22): the engine publishes a validated
 * artefact of the named kind, idempotent by run date (a re-publish of the
 * same run overwrites the same object and row). The Cognito authoriser
 * has already verified the token; the app itself never calls this route,
 * and an unknown kind is not found, never stored.
 */
import {
  backtestReportSchema,
  dailyPairsReportSchema,
  errorEnvelope,
  pairsArtefactRunSchema,
  pairScanReportSchema,
  weeklyMonitoringReportSchema,
  type DailyPairsReport
} from '@plainsight/api-contract';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2
} from 'aws-lambda';
import type { z } from 'zod';
import { SnsHaltAlerter, type HaltAlerter } from '../aws/haltAlert.js';
import {
  isPairsKind,
  TablePairsStore,
  type PairsArtefactKind,
  type PairsArtefactStore,
  type PairsReportMeta
} from '../db/pairsStore.js';
import { jsonResponse, logOutcome, requestIdOf } from '../http/respond.js';
import { userIdOf } from './syncPush.js';

export const REPORT_SCHEMAS: Record<PairsArtefactKind, z.ZodType<PairsReportMeta>> = {
  'pair-scan': pairScanReportSchema,
  backtest: backtestReportSchema,
  daily: dailyPairsReportSchema,
  weekly: weeklyMonitoringReportSchema
};

export function kindOf(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): PairsArtefactKind | undefined {
  const kind = event.pathParameters?.['kind'];
  return kind !== undefined && isPairsKind(kind) ? kind : undefined;
}

export function createPutPairsArtefactHandler(
  store: PairsArtefactStore,
  now: () => Date = () => new Date(),
  alerter?: HaltAlerter
) {
  return async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const requestId = requestIdOf(event);
    try {
      if (userIdOf(event) === undefined) {
        return jsonResponse(
          401,
          errorEnvelope('unauthenticated', 'A signed-in session is required to publish.', requestId)
        );
      }
      const kind = kindOf(event);
      if (kind === undefined) {
        return jsonResponse(
          404,
          errorEnvelope('not_found', 'Unknown artefact kind.', requestId)
        );
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(event.body ?? '');
      } catch {
        return jsonResponse(
          400,
          errorEnvelope('invalid_request', 'The artefact body must be JSON.', requestId)
        );
      }
      const report = REPORT_SCHEMAS[kind].safeParse(parsedBody);
      if (!report.success) {
        return jsonResponse(
          400,
          errorEnvelope('invalid_request', 'The artefact failed validation.', requestId, [
            { reason: 'schema', message: report.error.issues[0]?.message ?? 'invalid' }
          ])
        );
      }
      const row = await store.putRun(kind, report.data, now().toISOString());
      logOutcome({
        requestId,
        route: 'putPairsArtefact',
        outcome: 'stored',
        detail: `${kind} ${row.runDate}`
      });
      // The halt alert (integration plan §10): a daily artefact carrying
      // a halted reconciliation nudges the owner through the account's
      // alert topic. Best-effort: the store already succeeded, the app's
      // banner is the control, and an unsendable alert must not turn a
      // stored artefact into an error. A standing halt re-alerts on
      // every publish, deliberately: an unresolved break should nag.
      if (kind === 'daily' && alerter !== undefined) {
        const daily = report.data as DailyPairsReport;
        if (daily.reconciliation.status === 'halted') {
          const mismatches = daily.reconciliation.mismatches
            .map((entry) => `${entry.ticker} (book ${String(entry.book)}, broker ${String(entry.broker)})`)
            .join('; ');
          try {
            await alerter.publishHalt(
              'Plainsight pairs: the book is halted',
              `The ${daily.runDate} daily artefact carries a halted reconciliation` +
                (mismatches === '' ? '' : `: ${mismatches}`) +
                '. The engine refuses to trade until the book is resolved and clear-halt runs ' +
                '(runbook, the pairs paper-cycle section). The live surface shows the details.'
            );
            logOutcome({ requestId, route: 'putPairsArtefact', outcome: 'haltAlerted', detail: daily.runDate });
          } catch (alertError) {
            logOutcome({
              requestId,
              route: 'putPairsArtefact',
              outcome: 'haltAlertFailed',
              detail: alertError instanceof Error ? alertError.message : 'unknown'
            });
          }
        }
      }
      return jsonResponse(200, pairsArtefactRunSchema.parse(row));
    } catch (error) {
      logOutcome({
        requestId,
        route: 'putPairsArtefact',
        outcome: 'error',
        detail: error instanceof Error ? error.message : 'unknown'
      });
      return jsonResponse(
        500,
        errorEnvelope('internal', 'The artefact could not be stored.', requestId)
      );
    }
  };
}

let store: PairsArtefactStore | undefined;
let alerter: HaltAlerter | undefined;
let alerterResolved = false;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  store ??= TablePairsStore.fromEnv();
  if (!alerterResolved) {
    alerter = SnsHaltAlerter.fromEnv();
    alerterResolved = true;
  }
  return createPutPairsArtefactHandler(store, undefined, alerter)(event);
}
