/**
 * GET /v1/pairs/artefacts/{kind} (integration plan §4; backend spec §2
 * route table as amended 2026-07-22): the latest report of the named
 * kind in full plus the run history, for the Pairs surfaces. Read-only
 * over what the engine published; an empty sleeve is a 200 with a null
 * latest, never an error, and an unknown kind is not found.
 */
import {
  errorEnvelope,
  pairsArtefactCollectionSchema,
  pairsBacktestCollectionSchema,
  pairsDailyCollectionSchema,
  pairsWeeklyCollectionSchema
} from '@plainsight/api-contract';
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2
} from 'aws-lambda';
import type { z } from 'zod';
import {
  TablePairsStore,
  type PairsArtefactKind,
  type PairsArtefactStore
} from '../db/pairsStore.js';
import { jsonResponse, logOutcome, requestIdOf } from '../http/respond.js';
import { kindOf, REPORT_SCHEMAS } from './putPairsArtefact.js';
import { userIdOf } from './syncPush.js';

const COLLECTION_SCHEMAS: Record<PairsArtefactKind, z.ZodType> = {
  'pair-scan': pairsArtefactCollectionSchema,
  backtest: pairsBacktestCollectionSchema,
  daily: pairsDailyCollectionSchema,
  weekly: pairsWeeklyCollectionSchema
};

export function createGetPairsArtefactHandler(store: PairsArtefactStore) {
  return async (
    event: APIGatewayProxyEventV2WithJWTAuthorizer
  ): Promise<APIGatewayProxyStructuredResultV2> => {
    const requestId = requestIdOf(event);
    try {
      if (userIdOf(event) === undefined) {
        return jsonResponse(
          401,
          errorEnvelope('unauthenticated', 'A signed-in session is required to read the sleeve.', requestId)
        );
      }
      const kind = kindOf(event);
      if (kind === undefined) {
        return jsonResponse(
          404,
          errorEnvelope('not_found', 'Unknown artefact kind.', requestId)
        );
      }
      const history = await store.listRuns(kind);
      const latestRun = history[0];
      let latest: unknown = null;
      if (latestRun !== undefined) {
        const raw = await store.getReport(kind, latestRun.runDate);
        const parsed = REPORT_SCHEMAS[kind].safeParse(raw);
        if (!parsed.success) {
          // A stored object that no longer parses is server state gone
          // wrong, not a client mistake: surface it as internal so the
          // operator re-publishes rather than the app rendering a hole.
          logOutcome({
            requestId,
            route: 'getPairsArtefact',
            outcome: 'corrupt',
            detail: `${kind} ${latestRun.runDate}`
          });
          return jsonResponse(
            500,
            errorEnvelope('internal', 'The stored artefact failed validation; re-publish the run.', requestId)
          );
        }
        latest = parsed.data;
      }
      logOutcome({
        requestId,
        route: 'getPairsArtefact',
        outcome: 'served',
        detail: `${kind} ${latestRun?.runDate ?? 'empty'}`
      });
      return jsonResponse(200, COLLECTION_SCHEMAS[kind].parse({ latest, history }));
    } catch (error) {
      logOutcome({
        requestId,
        route: 'getPairsArtefact',
        outcome: 'error',
        detail: error instanceof Error ? error.message : 'unknown'
      });
      return jsonResponse(
        500,
        errorEnvelope('internal', 'The sleeve could not be read.', requestId)
      );
    }
  };
}

let store: PairsArtefactStore | undefined;

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyStructuredResultV2> {
  store ??= TablePairsStore.fromEnv();
  return createGetPairsArtefactHandler(store)(event);
}
