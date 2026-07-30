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
  weeklyMonitoringReportSchema
} from '@plainsight/api-contract';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2
} from 'aws-lambda';
import type { z } from 'zod';
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
  now: () => Date = () => new Date()
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

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  store ??= TablePairsStore.fromEnv();
  return createPutPairsArtefactHandler(store)(event);
}
