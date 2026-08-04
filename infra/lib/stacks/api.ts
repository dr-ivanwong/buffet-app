import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../../config/types';
import { ASX_DIRECTORY_OBJECT_KEY, edgarContactParameterName, LOG_RETENTION, TICKER_INDEX_OBJECT_KEY } from '../constants';
import { acknowledgeNagFinding } from '../nag';
import { AppFunction, handlerEntry } from '../constructs/app-function';
import {
  pairsObjectsArn,
  pairsObjectsFindingArn,
  SYNC_FEED_INDEX,
  uploadsObjectsArn,
  uploadsObjectsFindingArn,
} from './data';

/** ~10 rps steady, 20 burst (backend spec §2): the throttles are the WAF and the scraper cost-cap (spec §8 not-list). */
export const ROUTE_RATE_LIMIT = 10;
export const ROUTE_BURST_LIMIT = 20;

export interface ApiStackProps extends StackProps {
  config: EnvConfig;
  table: dynamodb.ITable;
  /** Wired when the ingestion feature is on; without it, cold tickers answer 202 and never warm. */
  ingestFunction?: lambda.IFunction;
  /** The artefacts bucket holding the search index copy; without it, search runs SEC-only. */
  indexBucket?: s3.IBucket;
  /** The user pool behind the authenticated routes; required once features.sync is on. */
  auth?: { userPool: cognito.IUserPool; webClient: cognito.IUserPoolClient };
  /** The Data stack's uploads bucket; required once features.sync is on. */
  uploadsBucket?: s3.IBucket;
  /** The Ingestion stack's extraction worker; absent, jobs fail visibly at start. */
  extractFunction?: lambda.IFunction;
  /** The Foundation alert topic: a halted daily pairs artefact nudges it (integration plan §10). */
  alertTopic?: sns.ITopic;
}

/**
 * Api (spec §3, Phase 2): the HTTP API and the read Lambdas. Stateless by
 * construction: it can be torn down and redeployed without touching the Data
 * stack, which is the point of the decomposition (spec §1.1). Everything
 * here is an optional enhancement; its total failure leaves the client fully
 * functional offline (the binding constraint).
 */
export class ApiStack extends Stack {
  readonly httpApi: apigwv2.HttpApi;
  /** The execute-api hostname, for the CloudFront origin (cdk spec §3: the same distribution fronts /v1/*). */
  readonly apiDomainName: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const {
      config,
      table,
      ingestFunction,
      indexBucket,
      auth,
      uploadsBucket,
      extractFunction,
      alertTopic,
    } = props;

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `plainsight-${config.envName}-api`,
      description: 'The Plainsight read API (backend spec §2 route table).',
      createDefaultStage: false,
    });
    this.apiDomainName = `${this.httpApi.apiId}.execute-api.${this.region}.${this.urlSuffix}`;

    // Access logs on, structured, with the redaction rule built into the
    // format: request id, route, status, latency; never payloads, tokens, or
    // headers (backend spec §11).
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new apigwv2.HttpStage(this, 'DefaultStage', {
      httpApi: this.httpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: ROUTE_RATE_LIMIT, burstLimit: ROUTE_BURST_LIMIT },
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        format: apigateway.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            routeKey: '$context.routeKey',
            status: '$context.status',
            latencyMs: '$context.responseLatency',
            error: '$context.error.messageString',
          }),
        ),
      },
    });

    const environment = { TABLE_NAME: table.tableName };

    const profile = new AppFunction(this, 'GetProfile', {
      entry: handlerEntry('getProfile'),
      description: 'GET /v1/companies/{ticker}: the company profile (backend spec §2).',
      timeout: Duration.seconds(10),
      environment,
    });
    const financials = new AppFunction(this, 'GetFinancials', {
      entry: handlerEntry('getFinancials'),
      description:
        'GET /v1/companies/{ticker}/financials: standardised annual statements plus gaps; 202 ingesting on cold tickers (backend spec §2, §5).',
      timeout: Duration.seconds(10),
      environment: {
        ...environment,
        ...(ingestFunction === undefined
          ? {}
          : { INGEST_FUNCTION_NAME: ingestFunction.functionName }),
      },
    });
    // The cold-ticker path fires the ingest asynchronously (backend spec §5);
    // the invoke grant is the financials function's only permission beyond
    // its ticker-partition reads. Granted by explicit statement on the one
    // unqualified function ARN (grantInvoke would add a version wildcard the
    // async invoke never uses).
    if (ingestFunction !== undefined) {
      financials.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'FireIngest',
          actions: ['lambda:InvokeFunction'],
          resources: [ingestFunction.functionArn],
        }),
      );
    }

    // The read path reads; the ingestion path owns every write. Scoped by
    // hand rather than grantReadData: these handlers only ever GetItem and
    // Query the table itself (no index, no Scan), and the key-prefix
    // condition pins them to ticker partitions (spec §6: single-table access
    // scoped by key-prefix conditions where sensible). The invariant suite
    // asserts no write action can slip in.
    const readTickerPartitions = new iam.PolicyStatement({
      sid: 'ReadTickerPartitions',
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [table.tableArn],
      conditions: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TICKER#*'] },
      },
    });
    profile.fn.addToRolePolicy(readTickerPartitions);
    financials.fn.addToRolePolicy(readTickerPartitions);

    // Ticker search (backend spec §8): no table access at all; the index
    // copy in the artefacts bucket, with a direct SEC fetch as bootstrap and
    // fallback (which is why it carries the contact parameter too).
    const contactParameter = edgarContactParameterName(config.envName);
    const search = new AppFunction(this, 'SearchTickers', {
      entry: handlerEntry('searchTickers'),
      description:
        'GET /v1/search: in-memory ticker search over the EDGAR index (backend spec §8).',
      timeout: Duration.seconds(10),
      environment: {
        EDGAR_CONTACT_PARAMETER: contactParameter,
        ...(indexBucket === undefined
          ? {}
          : {
              INDEX_BUCKET: indexBucket.bucketName,
              INDEX_KEY: TICKER_INDEX_OBJECT_KEY,
              ASX_INDEX_KEY: ASX_DIRECTORY_OBJECT_KEY,
            }),
      },
    });
    if (indexBucket !== undefined) {
      // Exactly the one object, read and (bootstrap) write; no wildcard.
      search.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ReadWriteTickerIndexObject',
          actions: ['s3:GetObject', 's3:PutObject'],
          resources: [
            indexBucket.arnForObjects(TICKER_INDEX_OBJECT_KEY),
            indexBucket.arnForObjects(ASX_DIRECTORY_OBJECT_KEY),
          ],
        }),
      );
    }
    search.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadEdgarContactParameter',
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: `parameter${contactParameter}` })],
      }),
    );

    this.httpApi.addRoutes({
      path: '/v1/companies/{ticker}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('ProfileIntegration', profile.fn),
    });
    this.httpApi.addRoutes({
      path: '/v1/companies/{ticker}/financials',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('FinancialsIntegration', financials.fn),
    });
    this.httpApi.addRoutes({
      path: '/v1/search',
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration('SearchIntegration', search.fn),
    });

    // The sync routes (backend spec §2 route table, §4 protocol): the only
    // authenticated surface, JWT-checked at the gateway against the single
    // user pool. Their Lambdas read and write user partitions only, the same
    // key-prefix discipline as every other principal on the table (spec §6).
    if (config.features.sync) {
      if (auth === undefined) {
        throw new Error('features.sync requires features.auth: the sync routes are Cognito-gated');
      }
      const authorizer = new HttpUserPoolAuthorizer('CognitoAuthorizer', auth.userPool, {
        userPoolClients: [auth.webClient],
      });

      const syncPush = new AppFunction(this, 'SyncPush', {
        entry: handlerEntry('syncPush'),
        description:
          'POST /v1/sync/push: last-write-wins record batches under an idempotency key (backend spec §4).',
        timeout: Duration.seconds(15),
        environment,
      });
      const syncPull = new AppFunction(this, 'SyncPull', {
        entry: handlerEntry('syncPull'),
        description:
          'GET /v1/sync/pull: the per-user feed above a checkpoint, one page at a time (backend spec §4).',
        timeout: Duration.seconds(15),
        environment,
      });

      const userPartitions = new iam.PolicyStatement({
        sid: 'ReadWriteUserPartitions',
        actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn, `${table.tableArn}/index/${SYNC_FEED_INDEX}`],
        conditions: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'IDEMP#*'] },
        },
      });
      syncPush.fn.addToRolePolicy(userPartitions);
      syncPull.fn.addToRolePolicy(userPartitions);

      this.httpApi.addRoutes({
        path: '/v1/sync/push',
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration('SyncPushIntegration', syncPush.fn),
        authorizer,
      });
      this.httpApi.addRoutes({
        path: '/v1/sync/pull',
        methods: [apigwv2.HttpMethod.GET],
        integration: new HttpLambdaIntegration('SyncPullIntegration', syncPull.fn),
        authorizer,
      });

      // The upload and extraction-job routes (backend spec §6). The presign
      // function can only place objects under uploads/; the job starter reads
      // upload heads and magic bytes, owns the JOB#, USER# quota, and IDEMP#
      // writes, honours the kill-switch flag, and fires the Ingestion
      // worker; the status route only ever reads jobs.
      if (uploadsBucket === undefined) {
        throw new Error('features.sync requires the uploads bucket: the Data stack builds it');
      }
      const createUpload = new AppFunction(this, 'CreateUpload', {
        entry: handlerEntry('createUpload'),
        description:
          'POST /v1/uploads: a presigned fifteen-minute PUT for one filing (backend spec §6).',
        timeout: Duration.seconds(10),
        environment: { UPLOADS_BUCKET: uploadsBucket.bucketName },
      });
      createUpload.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'SignUploadPuts',
          actions: ['s3:PutObject'],
          resources: [uploadsObjectsArn(config)],
        }),
      );
      acknowledgeNagFinding(
        createUpload,
        `AwsSolutions-IAM5[Resource::${uploadsObjectsFindingArn(config)}]`,
        'The presigner mints keys server-side under uploads/ with the caller prefix; the ' +
          'wildcard is the transient uploads keyspace, expiring in seven days.',
      );

      const extractionFlagParameter = `/app/${config.envName}/features/extraction`;
      const createExtraction = new AppFunction(this, 'CreateExtraction', {
        entry: handlerEntry('createExtraction'),
        description:
          'POST /v1/extractions: validates the upload, spends quota, lands the queued job, fires the worker (backend spec §6).',
        timeout: Duration.seconds(10),
        environment: {
          ...environment,
          UPLOADS_BUCKET: uploadsBucket.bucketName,
          EXTRACTION_FLAG_PARAMETER: extractionFlagParameter,
          ...(extractFunction === undefined
            ? {}
            : { EXTRACT_FUNCTION_NAME: extractFunction.functionName }),
        },
      });
      createExtraction.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ReadUploadHeads',
          actions: ['s3:GetObject'],
          resources: [uploadsObjectsArn(config)],
        }),
      );
      acknowledgeNagFinding(
        createExtraction,
        `AwsSolutions-IAM5[Resource::${uploadsObjectsFindingArn(config)}]`,
        'Head and magic-byte reads over the transient uploads keyspace only; keys are minted ' +
          'server-side under uploads/ with the caller prefix.',
      );
      createExtraction.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'WriteJobsQuotaAndReplays',
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
          resources: [table.tableArn],
          conditions: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['JOB#*', 'USER#*', 'IDEMP#*'] },
          },
        }),
      );
      createExtraction.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ReadExtractionFlag',
          actions: ['ssm:GetParameter'],
          resources: [
            this.formatArn({ service: 'ssm', resource: `parameter${extractionFlagParameter}` }),
          ],
        }),
      );
      if (extractFunction !== undefined) {
        createExtraction.fn.addToRolePolicy(
          new iam.PolicyStatement({
            sid: 'FireExtractionWorker',
            actions: ['lambda:InvokeFunction'],
            resources: [extractFunction.functionArn],
          }),
        );
      }

      const getExtraction = new AppFunction(this, 'GetExtraction', {
        entry: handlerEntry('getExtraction'),
        description:
          'GET /v1/extractions/{jobId}: the job as it stands, in the review screen shape (backend spec §6).',
        timeout: Duration.seconds(10),
        environment,
      });
      getExtraction.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ReadJobs',
          actions: ['dynamodb:GetItem'],
          resources: [table.tableArn],
          conditions: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['JOB#*'] },
          },
        }),
      );

      this.httpApi.addRoutes({
        path: '/v1/uploads',
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration('CreateUploadIntegration', createUpload.fn),
        authorizer,
      });
      this.httpApi.addRoutes({
        path: '/v1/extractions',
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration('CreateExtractionIntegration', createExtraction.fn),
        authorizer,
      });
      this.httpApi.addRoutes({
        path: '/v1/extractions/{jobId}',
        methods: [apigwv2.HttpMethod.GET],
        integration: new HttpLambdaIntegration('GetExtractionIntegration', getExtraction.fn),
        authorizer,
      });

      // The pairs sleeve transport (integration plan §4; backend spec §2
      // route table as amended 2026-07-22): the engine's authenticated
      // PUT per artefact kind, idempotent by run date, and the app's read
      // of latest plus history. The kind segment routes inside two
      // Lambdas over a closed set (pair-scan, backtest; later kinds land
      // with their schemas, not new functions). Artefacts are durable
      // objects under pairs/{kind}/ (outside the uploads/ seven-day
      // lifecycle); the run rows live under the PAIRS#{kind} partition.
      // The app never trades and never writes sleeve data: the only
      // writer is the engine's publish through this route.
      const putPairsArtefact = new AppFunction(this, 'PutPairsArtefact', {
        entry: handlerEntry('putPairsArtefact'),
        description:
          'PUT /v1/pairs/artefacts/{kind}: the engine publishes a validated artefact of the named kind (integration plan §4).',
        timeout: Duration.seconds(10),
        environment: {
          ...environment,
          UPLOADS_BUCKET: uploadsBucket.bucketName,
          // A halted daily artefact nudges the account alert topic, the
          // budget kill-chain's channel (integration plan §10, built
          // 2026-07-30); best-effort in the handler, never load-bearing.
          ...(alertTopic === undefined ? {} : { ALERT_TOPIC_ARN: alertTopic.topicArn }),
        },
      });
      if (alertTopic !== undefined) {
        putPairsArtefact.fn.addToRolePolicy(
          new iam.PolicyStatement({
            sid: 'PublishHaltAlert',
            actions: ['sns:Publish'],
            resources: [alertTopic.topicArn],
          }),
        );
      }
      putPairsArtefact.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'WritePairsArtefactObjects',
          actions: ['s3:PutObject'],
          resources: [pairsObjectsArn(config)],
        }),
      );
      putPairsArtefact.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'WritePairsRuns',
          actions: ['dynamodb:PutItem'],
          resources: [table.tableArn],
          conditions: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAIRS#*'] },
          },
        }),
      );
      acknowledgeNagFinding(
        putPairsArtefact,
        `AwsSolutions-IAM5[Resource::${pairsObjectsFindingArn(config)}]`,
        'Artefact keys are minted server-side under pairs/ from the validated run date; the ' +
          'wildcard is the sleeve keyspace, one object per run.',
      );

      const getPairsArtefact = new AppFunction(this, 'GetPairsArtefact', {
        entry: handlerEntry('getPairsArtefact'),
        description:
          'GET /v1/pairs/artefacts/{kind}: the latest report of the named kind plus run history for the Pairs surfaces (integration plan §4).',
        timeout: Duration.seconds(10),
        environment: { ...environment, UPLOADS_BUCKET: uploadsBucket.bucketName },
      });
      getPairsArtefact.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ReadPairsArtefactObjects',
          actions: ['s3:GetObject'],
          resources: [pairsObjectsArn(config)],
        }),
      );
      getPairsArtefact.fn.addToRolePolicy(
        new iam.PolicyStatement({
          sid: 'ReadPairsRuns',
          actions: ['dynamodb:Query'],
          resources: [table.tableArn],
          conditions: {
            'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PAIRS#*'] },
          },
        }),
      );
      acknowledgeNagFinding(
        getPairsArtefact,
        `AwsSolutions-IAM5[Resource::${pairsObjectsFindingArn(config)}]`,
        'Reads over the sleeve keyspace only, one durable object per published run.',
      );

      this.httpApi.addRoutes({
        path: '/v1/pairs/artefacts/{kind}',
        methods: [apigwv2.HttpMethod.PUT],
        integration: new HttpLambdaIntegration('PutPairsArtefactIntegration', putPairsArtefact.fn),
        authorizer,
      });
      this.httpApi.addRoutes({
        path: '/v1/pairs/artefacts/{kind}',
        methods: [apigwv2.HttpMethod.GET],
        integration: new HttpLambdaIntegration('GetPairsArtefactIntegration', getPairsArtefact.fn),
        authorizer,
      });

      // The BYOK proxy (backend spec §7) arrives with the other Phase 3
      // authenticated routes (spec §3 Api row bundles them). Deliberately
      // grantless beyond its logs: the key is the caller's, the destination
      // is the registry's, and nothing touches the table or SSM.
      const byokProxy = new AppFunction(this, 'ByokProxy', {
        entry: handlerEntry('byokProxy'),
        description:
          'POST /v1/proxy/{providerId}: BYOK pass-through for providers without browser CORS (backend spec §7).',
        timeout: Duration.seconds(25),
      });
      this.httpApi.addRoutes({
        path: '/v1/proxy/{providerId}',
        methods: [apigwv2.HttpMethod.POST],
        integration: new HttpLambdaIntegration('ByokProxyIntegration', byokProxy.fn),
        authorizer,
      });
    }

    // The Phase 2 read routes are deliberately unauthenticated: they serve
    // public filings data, throttled, behind the edge cache; the routes the
    // backend spec flags auth carry the Cognito authoriser above (pinned by
    // the route invariant).
    acknowledgeNagFinding(
      this.httpApi,
      'AwsSolutions-APIG4',
      'Read routes serve public EDGAR-derived data by design (backend spec §2 route table: no ' +
        'auth flag on the read path); abuse is bounded by the stage throttles and the budget ' +
        'kill switch (cdk spec §8). The routes the spec flags auth carry the Cognito authoriser.',
    );

    new CfnOutput(this, 'ApiEndpoint', {
      value: this.httpApi.apiEndpoint,
      description: 'Invoke URL of the read API; CloudFront fronts it from the edge-cache slice on.',
    });
  }
}
