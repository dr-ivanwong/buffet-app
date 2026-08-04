import { Tags, type App } from 'aws-cdk-lib';
import type { EnvConfig } from '../config/types';
import { ApiStack } from './stacks/api';
import { AuthStack } from './stacks/auth';
import { DataStack } from './stacks/data';
import { FoundationStack } from './stacks/foundation';
import { GithubOidcStack } from './stacks/github-oidc';
import { IngestionStack } from './stacks/ingestion';
import { StaticSiteStack } from './stacks/static-site';

export interface PlainsightStacks {
  foundation: FoundationStack;
  /** Absent on rehearsal copies: one-time scaffolding is never rehearsed (spec §3). */
  githubOidc: GithubOidcStack | undefined;
  staticSite: StaticSiteStack;
  /** Absent until a consumer of the table is switched on (spec §1.2 feature gating). */
  data: DataStack | undefined;
  /** Absent until features.ingestion flips (spec §1.2). */
  ingestion: IngestionStack | undefined;
  /** Absent until features.api flips (spec §1.2). */
  api: ApiStack | undefined;
  /** Absent until features.auth flips (spec §1.2); Phase 3. */
  auth: AuthStack | undefined;
}

/**
 * Instantiates every stack the given config asks for. This is the one place
 * that turns config into stacks; bin/app.ts and the test suite both call it,
 * so what CI asserts is exactly what deploys.
 *
 * Spec §4 requirements handled here: env is pinned on every stack (no
 * environment-agnostic stacks: deterministic `cdk diff` or nothing) and the
 * project/env/owner tags are applied once, at the root.
 */
export function buildApp(app: App, config: EnvConfig): PlainsightStacks {
  const env = { account: config.account, region: config.region };
  // A rehearsal copy is the same code with prefixed names (spec §2); the
  // difference is data derived from envName, not a separate branch of stacks.
  const prefix = config.envName === 'rehearsal' ? 'Rehearsal' : '';

  Tags.of(app).add('project', 'plainsight');
  Tags.of(app).add('env', config.envName);
  Tags.of(app).add('owner', 'ivan');

  const foundation = new FoundationStack(app, `${prefix}Foundation`, { env, config });
  const githubOidc =
    config.envName === 'prod' ? new GithubOidcStack(app, 'GithubOidc', { env, config }) : undefined;

  // Phase 2 (spec §3): the table is the shared dependency of Api and
  // Ingestion, so it exists exactly when a consumer of it does. A stack that
  // is off does not exist (spec §1.2).
  const data =
    config.features.api || config.features.ingestion
      ? new DataStack(app, `${prefix}Data`, { env, config })
      : undefined;

  const ingestion =
    config.features.ingestion && data !== undefined
      ? new IngestionStack(app, `${prefix}Ingestion`, {
          env,
          config,
          table: data.table,
          alertTopic: foundation.alertTopic,
          // The extraction worker reads uploaded filings when the Phase 3
          // surface is on (backend spec §6).
          ...(data.uploadsBucket === undefined ? {} : { uploadsBucket: data.uploadsBucket }),
        })
      : undefined;

  // Phase 3 (spec §3): the user pool precedes the Api in the dependency
  // graph; the authoriser attaches to routes when the sync slice flags them.
  const auth = config.features.auth
    ? new AuthStack(app, `${prefix}Auth`, { env, config })
    : undefined;

  const api =
    config.features.api && data !== undefined
      ? new ApiStack(app, `${prefix}Api`, {
          env,
          config,
          table: data.table,
          // The cold-ticker fire needs the ingest function; without the
          // ingestion feature the route still answers 202, it just never
          // warms (a coherent, deliberately reachable degraded state), and
          // search runs SEC-only without the index bucket.
          ...(ingestion === undefined
            ? {}
            : { ingestFunction: ingestion.ingestFunction, indexBucket: ingestion.indexBucket }),
          // The sync routes are Cognito-gated by contract; the Api stack
          // refuses features.sync without this wiring.
          ...(auth === undefined
            ? {}
            : { auth: { userPool: auth.userPool, webClient: auth.webClient } }),
          ...(data.uploadsBucket === undefined ? {} : { uploadsBucket: data.uploadsBucket }),
          ...(ingestion === undefined ? {} : { extractFunction: ingestion.extractFunction }),
          // A halted daily pairs artefact nudges the alert topic
          // (integration plan §10).
          alertTopic: foundation.alertTopic,
        })
      : undefined;

  // StaticSite builds last from Phase 2 on: the distribution fronts /v1/*
  // (cdk spec §3), so it references the Api stack's hostname when the
  // feature is on. Deploy order follows the references; Phase 0/1 configs
  // see the same bucket-and-CDN stack as always.
  const staticSite = new StaticSiteStack(app, `${prefix}StaticSite`, {
    env,
    config,
    // Prod gains the app pipeline's deploy role (a rehearsal copy has no
    // GithubOidc and no pipeline; it is deployed by hand and torn down).
    ...(githubOidc === undefined ? {} : { deployOidcProviderArn: githubOidc.providerArn }),
    ...(api === undefined ? {} : { apiDomainName: api.apiDomainName }),
  });

  return { foundation, githubOidc, staticSite, data, ingestion, api, auth };
}
