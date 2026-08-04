// Assertion tests pinning the spec §6 invariants. These must survive any
// refactor; loosening one is a spec change, not a test fix.
import { createHash } from 'node:crypto';

import { featuresOff, testApp } from './util';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { prod, rehearsalFrom } from '../config/prod';
import type { EnvConfig } from '../config/types';
import { buildApp } from '../lib/app';
import { SYNC_FEED_INDEX, WATCHED_TICKERS_INDEX } from '../lib/stacks/data';
import { AUD_TO_USD_BUDGET_RATE, FEATURE_FLAGS } from '../lib/stacks/foundation';

// The tests construct the app directly from the typed prod config (account
// placeholder included): no credentials, no lookups, no CLI. What CI asserts
// here is exactly what `cdk synth` produces, because both call buildApp.
// Prod carries the Phase 2 flags since go-live (2026-07-12) and the auth
// flag since the Phase 3 arrival (2026-07-18), so the real prod build is the
// seven stacks.
const app = testApp();
const stacks = buildApp(app, prod);
if (!stacks.githubOidc) throw new Error('prod must synthesise the GithubOidc stack');
if (!stacks.data || !stacks.ingestion || !stacks.api) {
  throw new Error('prod must synthesise the Phase 2 stacks: the flags flipped at go-live');
}
if (!stacks.auth) {
  throw new Error('prod must synthesise the Auth stack: the flag flipped with Phase 3');
}
const templates: Record<string, Template> = {
  Foundation: Template.fromStack(stacks.foundation),
  GithubOidc: Template.fromStack(stacks.githubOidc),
  StaticSite: Template.fromStack(stacks.staticSite),
  Data: Template.fromStack(stacks.data),
  Ingestion: Template.fromStack(stacks.ingestion),
  Api: Template.fromStack(stacks.api),
  Auth: Template.fromStack(stacks.auth),
};
const foundation = templates['Foundation'] as Template;
const githubOidc = templates['GithubOidc'] as Template;
const staticSite = templates['StaticSite'] as Template;
const data = templates['Data'] as Template;
const ingestion = templates['Ingestion'] as Template;
const api = templates['Api'] as Template;
const auth = templates['Auth'] as Template;

// The Phase 0/1 posture (every feature off) stays under test: it is the
// rollback target, and the zero-compute promise belongs to it.
const featuresOffConfig: EnvConfig = featuresOff(prod);
const offStacks = buildApp(testApp(), featuresOffConfig);
if (!offStacks.githubOidc) throw new Error('the features-off build must synthesise GithubOidc');
const foundationOff = Template.fromStack(offStacks.foundation);
const staticSiteOff = Template.fromStack(offStacks.staticSite);
const featuresOffTemplates: Record<string, Template> = {
  Foundation: foundationOff,
  GithubOidc: Template.fromStack(offStacks.githubOidc),
  StaticSite: staticSiteOff,
};

/**
 * The one resource of its kind. Throws a plain Error (not an expect) because
 * some callers run at describe scope, during collection.
 */
function only<T>(record: Record<string, T>): T {
  const values = Object.values(record);
  if (values.length !== 1) {
    throw new Error(`expected exactly one matching resource, found ${values.length}`);
  }
  return values[0] as T;
}

describe('S3 buckets (spec §6: BLOCK_ALL + encryption + versioning)', () => {
  it('every bucket in every stack blocks public access, encrypts, and versions', () => {
    const bucketsPerStack: Record<string, number> = {};
    for (const [stackName, template] of Object.entries(templates)) {
      for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
        bucketsPerStack[stackName] = (bucketsPerStack[stackName] ?? 0) + 1;
        const props = bucket['Properties'];
        expect(props.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
        expect(props.BucketEncryption.ServerSideEncryptionConfiguration).toBeDefined();
        expect(props.VersioningConfiguration).toEqual({ Status: 'Enabled' });
      }
    }
    // Exactly three buckets exist anywhere: the site bucket, the ingestion
    // artefacts bucket, and the transient uploads bucket.
    expect(bucketsPerStack).toEqual({ StaticSite: 1, Ingestion: 1, Data: 1 });
  });

  it('the site bucket expires noncurrent versions after 30 days and is retained in prod', () => {
    staticSite.hasResourceProperties(
      'AWS::S3::Bucket',
      Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Status: 'Enabled',
              NoncurrentVersionExpiration: Match.objectLike({ NoncurrentDays: 30 }),
            }),
          ]),
        },
      }),
    );
    staticSite.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  });
});

describe('Lambda functions (spec §6 universals: timeout, ARM64, retained logs)', () => {
  it('every function in every stack declares its timeout, runtime, ARM64, and 30-day log group', () => {
    const functionsPerStack: Record<string, number> = {};
    for (const [stackName, template] of Object.entries(templates)) {
      const resources: Record<string, { Type: string; Properties?: any }> =
        template.toJSON().Resources ?? {};
      for (const [logicalId, resource] of Object.entries(resources)) {
        if (resource.Type !== 'AWS::Lambda::Function') continue;
        functionsPerStack[stackName] = (functionsPerStack[stackName] ?? 0) + 1;
        const where = `${stackName}/${logicalId}`;
        const props = resource.Properties ?? {};
        // A template only carries Timeout when it was set explicitly, so
        // presence is the proof the 3-second default was never relied on.
        expect(props.Timeout, `${where} must declare its timeout`).toEqual(expect.any(Number));
        expect(props.Architectures, `${where} must run on ARM64`).toEqual(['arm64']);
        expect(props.Runtime, `${where} must run the pinned runtime`).toBe('nodejs22.x');
        // The function must name its own log group, in this template, kept
        // 30 days: a raw function left on default infinite retention (or on
        // the legacy custom-resource retention) fails right here.
        const reference = props.LoggingConfig?.LogGroup?.Ref;
        expect(reference, `${where} must name its own log group`).toBeDefined();
        const logGroup = resources[reference];
        expect(logGroup?.Type, `${where} log group`).toBe('AWS::Logs::LogGroup');
        expect(logGroup?.Properties?.RetentionInDays, `${where} log retention`).toBe(30);
      }
    }
    // The whole fleet, closed: a function appearing in any other stack, or a
    // stack growing one, is a deliberate decision, exactly like the buckets.
    expect(functionsPerStack).toEqual({ Foundation: 1, Ingestion: 3, Api: 11 });
  });
});

describe('zero compute with every feature off (the Phase 0/1 posture, spec §1.2)', () => {
  it.each(Object.keys(featuresOffTemplates))('%s contains no Lambda functions', (name) => {
    const template = featuresOffTemplates[name] as Template;
    expect(Object.keys(template.findResources('AWS::Lambda::Function'))).toEqual([]);
  });

  it.each(Object.keys(featuresOffTemplates))('%s contains no custom resources', (name) => {
    // A custom resource means a hidden Lambda: BucketDeployment and the L2
    // iam.OpenIdConnectProvider are the classic ways one sneaks in.
    const template = featuresOffTemplates[name] as Template;
    const resources: Record<string, { Type: string }> = template.toJSON().Resources ?? {};
    const customTypes = Object.values(resources)
      .map((resource) => resource.Type)
      .filter((type) => type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource');
    expect(customTypes).toEqual([]);
  });

  it('the prod stacks carry no custom resources either, only declared functions', () => {
    for (const template of Object.values(templates)) {
      const resources: Record<string, { Type: string }> = template.toJSON().Resources ?? {};
      const customTypes = Object.values(resources)
        .map((resource) => resource.Type)
        .filter(
          (type) => type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource',
        );
      expect(customTypes).toEqual([]);
    }
  });
});

describe('IAM wildcards (spec §6: no Action or Resource of literal *)', () => {
  // If a CDK-managed exception ever genuinely appears, allowlist it here as
  // '<StackName>/<LogicalId>' with a comment justifying it. Expect none in
  // these stacks.
  const WILDCARD_ALLOWLIST: ReadonlySet<string> = new Set([]);

  /**
   * The one documented CDK-managed exception (spec §6): active tracing adds
   * X-Ray daemon statements on Resource '*', because those actions support
   * no resource-level scoping. Recognised as a non-empty subset of the
   * closed X-Ray action set (Lambda tracing grants the two writes; Step
   * Functions tracing adds the two sampling reads), so nothing else can
   * shelter under it.
   */
  const XRAY_ACTIONS = new Set([
    'xray:PutTraceSegments',
    'xray:PutTelemetryRecords',
    'xray:GetSamplingRules',
    'xray:GetSamplingTargets',
  ]);
  const isXrayDaemonStatement = (statement: { Action?: unknown }): boolean => {
    const actions = [statement.Action].flat();
    return actions.length > 0 && actions.every((action) => XRAY_ACTIONS.has(action as string));
  };

  /**
   * The other documented exception: Step Functions logging works through the
   * CloudWatch Logs log-delivery APIs, which support no resource scoping
   * (the log group is chosen by the delivery configuration, not the policy).
   */
  const LOG_DELIVERY_ACTIONS = new Set([
    'logs:CreateLogDelivery',
    'logs:GetLogDelivery',
    'logs:UpdateLogDelivery',
    'logs:DeleteLogDelivery',
    'logs:ListLogDeliveries',
    'logs:PutResourcePolicy',
    'logs:DescribeResourcePolicies',
    'logs:DescribeLogGroups',
  ]);
  const isLogDeliveryStatement = (statement: { Action?: unknown }): boolean => {
    const actions = [statement.Action].flat();
    return (
      actions.length > 0 && actions.every((action) => LOG_DELIVERY_ACTIONS.has(action as string))
    );
  };

  it('no policy statement anywhere carries Action: * or Resource: *', () => {
    const violations: string[] = [];
    for (const [stackName, template] of Object.entries(templates)) {
      const resources: Record<string, { Type: string; Properties?: any }> =
        template.toJSON().Resources ?? {};
      for (const [logicalId, resource] of Object.entries(resources)) {
        const props = resource.Properties ?? {};
        const documents: unknown[] = [];
        if (resource.Type === 'AWS::IAM::Role') {
          documents.push(props.AssumeRolePolicyDocument);
          for (const inline of props.Policies ?? []) documents.push(inline.PolicyDocument);
        }
        if (
          resource.Type === 'AWS::IAM::Policy' ||
          resource.Type === 'AWS::IAM::ManagedPolicy' ||
          resource.Type === 'AWS::S3::BucketPolicy' ||
          resource.Type === 'AWS::SNS::TopicPolicy'
        ) {
          documents.push(props.PolicyDocument);
        }
        for (const document of documents) {
          const statements: any[] = (document as any)?.Statement ?? [];
          for (const statement of statements) {
            for (const field of ['Action', 'Resource'] as const) {
              const values: unknown[] = [statement[field]].flat();
              if (!values.includes('*')) continue;
              if (
                field === 'Resource' &&
                (isXrayDaemonStatement(statement) || isLogDeliveryStatement(statement))
              ) {
                continue;
              }
              if (!WILDCARD_ALLOWLIST.has(`${stackName}/${logicalId}`)) {
                violations.push(`${stackName}/${logicalId}: ${field} contains '*'`);
              }
            }
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('CSP (spec §6: the BYOK allowlist can never silently widen)', () => {
  const policy: any = only(staticSite.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
  const csp: string =
    policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
      .ContentSecurityPolicy;

  // Pinned as a literal, not recomputed through the helper under test: this
  // exact string is the origin the web client's PKCE token exchange calls
  // (apps/web/src/auth/session.ts pins the same value), so a drift in the
  // derivation fails here instead of in a browser console.
  const prodHostedUiOrigin =
    'https://plainsight-prod-679345828813.auth.ap-southeast-2.amazoncognito.com';

  it("connect-src equals exactly 'self', the hosted-UI origin (features.auth on), then config.csp.providerOrigins, in order", () => {
    const directives = new Map<string, string[]>(
      csp.split('; ').map((directive): [string, string[]] => {
        const [name, ...values] = directive.split(' ');
        return [name ?? '', values];
      }),
    );
    expect(directives.get('connect-src')).toEqual([
      "'self'",
      prodHostedUiOrigin,
      ...prod.csp.providerOrigins,
    ]);
  });

  it('the full policy matches the pinned directive set', () => {
    const expected = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src ${["'self'", prodHostedUiOrigin, ...prod.csp.providerOrigins].join(' ')}`,
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    expect(csp).toBe(expected);
  });

  it('the features-off posture names no hosted-UI origin (no pool exists to call)', () => {
    const offPolicy: any = only(staticSiteOff.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    const offCsp: string =
      offPolicy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
        .ContentSecurityPolicy;
    expect(offCsp).toContain("connect-src 'self'; ");
    expect(offCsp).not.toContain('amazoncognito.com');
  });

  it('the remaining security headers are present', () => {
    staticSite.hasResourceProperties(
      'AWS::CloudFront::ResponseHeadersPolicy',
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.objectLike({
              AccessControlMaxAgeSec: 31536000,
              IncludeSubdomains: true,
              Override: true,
            }),
            ContentTypeOptions: Match.objectLike({ Override: true }),
            ReferrerPolicy: Match.objectLike({ ReferrerPolicy: 'strict-origin-when-cross-origin' }),
            FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
          }),
        }),
      }),
    );
  });
});

describe('OIDC pipeline roles (spec §2: one assume grant each, nothing else)', () => {
  const repo = `${prod.github.owner}/${prod.github.repo}`;
  const cdkBootstrapRoles = `arn:aws:iam::${prod.account}:role/cdk-*`;
  const cdkLookupRole = `arn:aws:iam::${prod.account}:role/cdk-hnb659fds-lookup-role-${prod.account}-${prod.region}`;
  const deployStatement = {
    Action: 'sts:AssumeRole',
    Effect: 'Allow',
    Resource: cdkBootstrapRoles,
    Sid: 'AssumeCdkBootstrapRolesOnly',
  };
  const diffStatement = {
    Action: 'sts:AssumeRole',
    Effect: 'Allow',
    Resource: cdkLookupRole,
    Sid: 'AssumeCdkLookupRoleOnly',
  };

  const roles = githubOidc.findResources('AWS::IAM::Role');
  const roleEntry = (name: string): [string, any] => {
    const entry = Object.entries(roles).find(
      ([, candidate]: [string, any]) => candidate.Properties.RoleName === name,
    );
    if (!entry) throw new Error(`GithubOidc must define the ${name} role`);
    return entry;
  };
  const roleNamed = (name: string): any => roleEntry(name)[1];
  const inlinePolicyFor = (name: string): any => {
    const [logicalId] = roleEntry(name);
    const policy = Object.values(githubOidc.findResources('AWS::IAM::Policy')).find(
      (candidate: any) =>
        candidate.Properties.Roles.some((reference: any) => reference.Ref === logicalId),
    );
    if (!policy) throw new Error(`no inline policy attached to ${name}`);
    return policy;
  };
  const boundaryNamed = (name: string): any => {
    const boundary = Object.values(githubOidc.findResources('AWS::IAM::ManagedPolicy')).find(
      (candidate: any) => candidate.Properties.ManagedPolicyName === name,
    );
    if (!boundary) throw new Error(`GithubOidc must define the ${name} boundary`);
    return boundary;
  };

  it('defines exactly the deploy role and the read-only diff role', () => {
    expect(
      Object.values(roles)
        .map((role: any) => role.Properties.RoleName)
        .sort(),
    ).toEqual(['plainsight-github-deploy', 'plainsight-github-diff']);
  });

  it('the deploy role trusts exactly this repository on main, nothing wider', () => {
    // Full-document equality: no StringLike branch exists at all. The
    // retired approval gate's environment:* subject must never return;
    // environments auto-create unprotected, so it would let any workflow on
    // any ref assume the deploy role.
    expect(
      roleNamed('plainsight-github-deploy').Properties.AssumeRolePolicyDocument.Statement,
    ).toEqual([
      expect.objectContaining({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${repo}:ref:refs/heads/main`,
          },
        },
      }),
    ]);
  });

  it('the diff role trusts exactly the pull_request subject, nothing wider', () => {
    // Full-document equality: no StringLike branch exists at all, so the
    // trust cannot quietly regrow a wildcard, and a PR run can never present
    // as a deploy.
    expect(
      roleNamed('plainsight-github-diff').Properties.AssumeRolePolicyDocument.Statement,
    ).toEqual([
      expect.objectContaining({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:${repo}:pull_request`,
          },
        },
      }),
    ]);
  });

  it('each role carries its own permissions boundary', () => {
    const deploy = roleNamed('plainsight-github-deploy');
    const diff = roleNamed('plainsight-github-diff');
    const boundaryIds = Object.keys(githubOidc.findResources('AWS::IAM::ManagedPolicy'));
    expect(boundaryIds).toContain(deploy.Properties.PermissionsBoundary.Ref);
    expect(boundaryIds).toContain(diff.Properties.PermissionsBoundary.Ref);
    expect(deploy.Properties.PermissionsBoundary.Ref).not.toBe(
      diff.Properties.PermissionsBoundary.Ref,
    );
  });

  it('the deploy role holds exactly one grant: sts:AssumeRole on the cdk-* roles', () => {
    expect(
      inlinePolicyFor('plainsight-github-deploy').Properties.PolicyDocument.Statement,
    ).toEqual([deployStatement]);
    const role = roleNamed('plainsight-github-deploy');
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.Policies).toBeUndefined();
  });

  it('the diff role holds exactly one grant: sts:AssumeRole on the lookup role alone', () => {
    expect(inlinePolicyFor('plainsight-github-diff').Properties.PolicyDocument.Statement).toEqual([
      diffStatement,
    ]);
    const role = roleNamed('plainsight-github-diff');
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
    expect(role.Properties.Policies).toBeUndefined();
  });

  it('each boundary pins the same ceiling as its role', () => {
    expect(
      boundaryNamed('plainsight-deploy-boundary').Properties.PolicyDocument.Statement,
    ).toEqual([deployStatement]);
    expect(boundaryNamed('plainsight-diff-boundary').Properties.PolicyDocument.Statement).toEqual([
      diffStatement,
    ]);
  });
});

describe('site deploy role (main plan §7: the app pipeline ships assets, nothing else)', () => {
  const roles = staticSite.findResources('AWS::IAM::Role');
  const role: any = only(roles);

  it('trusts only this repository on main (no environment claim)', () => {
    const repo = `${prod.github.owner}/${prod.github.repo}`;
    expect(role.Properties.AssumeRolePolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
          StringLike: {
            'token.actions.githubusercontent.com:sub': `repo:${repo}:ref:refs/heads/main`,
          },
        },
      }),
    ]);
  });

  it('grants exactly list, object sync, and one invalidation action', () => {
    const policy: any = only(staticSite.findResources('AWS::IAM::Policy'));
    const statements: any[] = policy.Properties.PolicyDocument.Statement;
    expect(statements.map((statement) => statement.Sid)).toEqual([
      'ListSiteBucket',
      'SyncSiteObjects',
      'InvalidateDistribution',
    ]);
    expect(statements[1].Action).toEqual(['s3:GetObject', 's3:PutObject', 's3:DeleteObject']);
    expect(statements[2].Action).toBe('cloudfront:CreateInvalidation');
    expect(role.Properties.ManagedPolicyArns).toBeUndefined();
  });

  it('does not exist on a rehearsal copy', () => {
    const rehearsalApp = testApp();
    const rehearsal = buildApp(rehearsalApp, rehearsalFrom(prod));
    expect(
      Object.keys(Template.fromStack(rehearsal.staticSite).findResources('AWS::IAM::Role')),
    ).toEqual([]);
  });
});

describe('budget (spec §8: staged alerts on the converted AUD figure)', () => {
  const budget: any = only(foundation.findResources('AWS::Budgets::Budget'));

  it('stages the thresholds once each, one SNS subscriber apiece', () => {
    // Two Budgets service rules, enforced only at deploy time: thresholds
    // are unique per budget, and each notification carries at most one SNS
    // subscriber. The kill threshold therefore owns its notification (the
    // flipper relays the event to the alert topic in words).
    const notifications: any[] = budget.Properties.NotificationsWithSubscribers;
    const thresholds = notifications.map((entry) => entry.Notification.Threshold);
    expect(thresholds).toEqual(
      [...new Set([50, 80, 100, prod.budgets.killSwitchAt])].sort((a, b) => a - b),
    );
    for (const entry of notifications) {
      expect(entry.Notification.NotificationType).toBe('ACTUAL');
      expect(entry.Notification.ThresholdType).toBe('PERCENTAGE');
      expect(entry.Subscribers).toHaveLength(1);
      expect(entry.Subscribers[0].SubscriptionType).toBe('SNS');
      // The address is a topic ARN (a Ref to the topic).
      expect(entry.Subscribers[0].Address).toHaveProperty('Ref');
    }
    // With every feature off (the Phase 0/1 posture) the kill notification
    // does not exist: nothing deployed can spend, and every stage notifies
    // the alert topic.
    const offBudget: any = only(foundationOff.findResources('AWS::Budgets::Budget'));
    const offNotifications: any[] = offBudget.Properties.NotificationsWithSubscribers;
    expect(offNotifications.map((entry) => entry.Notification.Threshold)).toEqual([50, 80, 100]);
    const offAddresses = new Set(
      offNotifications.map((entry) => JSON.stringify(entry.Subscribers[0].Address)),
    );
    expect(offAddresses.size).toBe(1);
  });

  it('counts only the project tag on the shared account (ADR 0001 amendment)', () => {
    // The prefixed key is Budgets' documented form for user-defined tags;
    // the anomaly monitor deliberately differs (bare 'project': Cost
    // Explorer's form). Neither may be "unified" to match the other.
    expect(budget.Properties.Budget.FilterExpression).toEqual({
      Tags: { Key: 'user:project', Values: ['plainsight'], MatchOptions: ['EQUALS'] },
    });
  });

  it('is denominated in USD via the pinned conservative conversion', () => {
    expect(budget.Properties.Budget.BudgetLimit.Unit).toBe('USD');
    // The stack rounds to whole cents; compare at cent precision so a config
    // change to monthlyAud cannot fail on floating-point noise.
    expect(budget.Properties.Budget.BudgetLimit.Amount).toBeCloseTo(
      prod.budgets.monthlyAud * AUD_TO_USD_BUDGET_RATE,
      2,
    );
  });
});

describe('runtime feature flags (spec §3)', () => {
  it.each([...FEATURE_FLAGS])('/app/prod/features/%s exists and is false', (flag) => {
    foundation.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/app/prod/features/${flag}`,
      Type: 'String',
      Value: 'false',
    });
  });

  it('no other parameters exist', () => {
    expect(Object.keys(foundation.findResources('AWS::SSM::Parameter'))).toHaveLength(
      FEATURE_FLAGS.length,
    );
  });
});

describe('feature gating (spec §1.2: a stack that is off does not exist)', () => {
  it('with every feature off, no Phase 2 stack synthesises', () => {
    expect(offStacks.data).toBeUndefined();
    expect(offStacks.ingestion).toBeUndefined();
    expect(offStacks.api).toBeUndefined();
  });

  it('either consumer flag brings the table', () => {
    const ingestionOnly = buildApp(testApp(), {
      ...featuresOffConfig,
      features: { ...featuresOffConfig.features, ingestion: true },
    });
    expect(ingestionOnly.data).toBeDefined();
    const apiOnly = buildApp(testApp(), {
      ...featuresOffConfig,
      features: { ...featuresOffConfig.features, api: true },
    });
    expect(apiOnly.data).toBeDefined();
  });
});

describe('Data stack (spec §6 prod posture; spec §8 cost ceiling)', () => {
  const table: any = only(data.findResources('AWS::DynamoDB::Table'));

  it('prod: point-in-time recovery, deletion protection, retained on delete', () => {
    expect(table.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: true,
    });
    expect(table.Properties.DeletionProtectionEnabled).toBe(true);
    expect(table.DeletionPolicy).toBe('Retain');
    expect(table.UpdateReplacePolicy).toBe('Retain');
  });

  it('provisioned capacity across table and indexes sums inside the 25/25 free tier', () => {
    // The free tier counts provisioned capacity account-wide, indexes
    // included (spec §8): the sum, not the table figure, is the guardrail.
    const throughput = table.Properties.ProvisionedThroughput;
    expect(throughput).toBeDefined();
    const indexes: any[] = table.Properties.GlobalSecondaryIndexes ?? [];
    const totalRead =
      throughput.ReadCapacityUnits +
      indexes.reduce((sum, index) => sum + index.ProvisionedThroughput.ReadCapacityUnits, 0);
    const totalWrite =
      throughput.WriteCapacityUnits +
      indexes.reduce((sum, index) => sum + index.ProvisionedThroughput.WriteCapacityUnits, 0);
    expect(totalRead).toBeLessThanOrEqual(25);
    expect(totalWrite).toBeLessThanOrEqual(25);
  });

  it('carries the pinned key design and the shared TTL attribute (backend spec §3)', () => {
    expect(table.Properties.KeySchema).toEqual([
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ]);
    expect(table.Properties.TimeToLiveSpecification).toEqual({
      AttributeName: 'expiresAt',
      Enabled: true,
    });
  });

  it('carries exactly the two sparse indexes: watched tickers and the sync feed', () => {
    const indexes: any[] = table.Properties.GlobalSecondaryIndexes;
    expect(indexes).toHaveLength(2);
    const watch = indexes.find((index) => index.IndexName === WATCHED_TICKERS_INDEX);
    expect(watch.KeySchema).toEqual([
      { AttributeName: 'watchPartition', KeyType: 'HASH' },
      { AttributeName: 'ticker', KeyType: 'RANGE' },
    ]);
    expect(watch.Projection).toEqual({ ProjectionType: 'ALL' });
    const feed = indexes.find((index) => index.IndexName === SYNC_FEED_INDEX);
    expect(feed.KeySchema).toEqual([
      { AttributeName: 'syncUser', KeyType: 'HASH' },
      { AttributeName: 'syncSeq', KeyType: 'RANGE' },
    ]);
    expect(feed.Projection).toEqual({ ProjectionType: 'ALL' });
    // The carve-out, not an addition (spec §8): 15/15 + 5/5 + 5/5.
    expect(table.Properties.ProvisionedThroughput.ReadCapacityUnits).toBe(15);
    for (const index of indexes) {
      expect(index.ProvisionedThroughput.ReadCapacityUnits).toBe(5);
      expect(index.ProvisionedThroughput.WriteCapacityUnits).toBe(5);
    }
  });

  it('adds no compute and no custom resources (storage, not behaviour)', () => {
    expect(Object.keys(data.findResources('AWS::Lambda::Function'))).toEqual([]);
    const resources: Record<string, { Type: string }> = data.toJSON().Resources ?? {};
    const customTypes = Object.values(resources)
      .map((resource) => resource.Type)
      .filter((type) => type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource');
    expect(customTypes).toEqual([]);
  });

  it('is tagged like everything else (spec §4)', () => {
    data.hasResourceProperties(
      'AWS::DynamoDB::Table',
      Match.objectLike({
        Tags: Match.arrayWith([
          { Key: 'env', Value: 'prod' },
          { Key: 'owner', Value: 'ivan' },
          { Key: 'project', Value: 'plainsight' },
        ]),
      }),
    );
  });

  it('a rehearsal copy relaxes every protection so teardown stays five minutes', () => {
    const rehearsal = buildApp(testApp(), rehearsalFrom(prod));
    if (!rehearsal.data) throw new Error('a rehearsal build must synthesise Data');
    expect(rehearsal.data.stackName).toBe('RehearsalData');
    const rehearsalTable: any = only(
      Template.fromStack(rehearsal.data).findResources('AWS::DynamoDB::Table'),
    );
    expect(rehearsalTable.DeletionPolicy).toBe('Delete');
    expect(rehearsalTable.Properties.DeletionProtectionEnabled).toBe(false);
    expect(rehearsalTable.Properties.PointInTimeRecoverySpecification).toEqual({
      PointInTimeRecoveryEnabled: false,
    });
  });
});

describe('Auth stack (spec §3: single admin-created user, no signup, hosted UI)', () => {
  const pool: any = only(auth.findResources('AWS::Cognito::UserPool'));
  const client: any = only(auth.findResources('AWS::Cognito::UserPoolClient'));

  it('prod: signup off, email sign-in, retained and protected on delete', () => {
    expect(pool.Properties.AdminCreateUserConfig).toEqual(
      expect.objectContaining({ AllowAdminCreateUserOnly: true }),
    );
    expect(pool.Properties.UsernameAttributes).toEqual(['email']);
    expect(pool.Properties.DeletionProtection).toBe('ACTIVE');
    expect(pool.DeletionPolicy).toBe('Retain');
    expect(pool.UpdateReplacePolicy).toBe('Retain');
  });

  it('stays on the free feature plan with a deliberate password policy', () => {
    expect(pool.Properties.UserPoolTier).toBe('LITE');
    expect(pool.Properties.Policies.PasswordPolicy).toEqual(
      expect.objectContaining({
        MinimumLength: 12,
        RequireLowercase: true,
        RequireUppercase: true,
        RequireNumbers: true,
        RequireSymbols: true,
      }),
    );
    expect(pool.Properties.MfaConfiguration).toBe('OPTIONAL');
  });

  it('hosts sign-in on the deterministic Cognito domain', () => {
    const domain: any = only(auth.findResources('AWS::Cognito::UserPoolDomain'));
    expect(domain.Properties.Domain).toBe('plainsight-prod-679345828813');
  });

  it('the web client is public, hosted-UI code flow plus the IAM-gated admin flow', () => {
    expect(client.Properties.GenerateSecret).toBeUndefined();
    expect(client.Properties.AllowedOAuthFlows).toEqual(['code']);
    // The admin flow serves the pairs engine's publish step (integration
    // plan §4): the owner mints a refresh token once via
    // admin-initiate-auth, which is IAM-gated server-side, so no public
    // sign-in surface is added. Refresh-token auth is its companion flag.
    expect(client.Properties.ExplicitAuthFlows).toEqual([
      'ALLOW_ADMIN_USER_PASSWORD_AUTH',
      'ALLOW_REFRESH_TOKEN_AUTH',
    ]);
    expect(client.Properties.AllowedOAuthFlowsUserPoolClient).toBe(true);
    expect(client.Properties.AllowedOAuthScopes).toEqual(
      expect.arrayContaining(['openid', 'email']),
    );
    expect(client.Properties.CallbackURLs).toEqual([
      'https://doqe2dc30jwq8.cloudfront.net',
      'http://localhost:5173',
    ]);
    expect(client.Properties.LogoutURLs).toEqual(client.Properties.CallbackURLs);
    expect(client.Properties.PreventUserExistenceErrors).toBe('ENABLED');
  });

  it('accepts the default token lifetimes, deliberately', () => {
    // 60-minute access and id tokens, 30-day refresh: the Cognito defaults,
    // relied on rather than overridden (one seat, hosted UI, quiet refresh;
    // the stack comment records the same call). This pin makes the absence
    // read as a decision: adding explicit lifetimes is a posture change to
    // make loudly, not a tidy-up.
    expect(client.Properties.AccessTokenValidity).toBeUndefined();
    expect(client.Properties.IdTokenValidity).toBeUndefined();
    expect(client.Properties.RefreshTokenValidity).toBeUndefined();
    expect(client.Properties.TokenValidityUnits).toBeUndefined();
  });

  it('adds no compute and no custom resources (identity, not behaviour)', () => {
    expect(Object.keys(auth.findResources('AWS::Lambda::Function'))).toEqual([]);
    const resources: Record<string, { Type: string }> = auth.toJSON().Resources ?? {};
    const customTypes = Object.values(resources)
      .map((resource) => resource.Type)
      .filter((type) => type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource');
    expect(customTypes).toEqual([]);
  });

  it('does not exist while the feature is off (spec §1.2), and a rehearsal copy is disposable', () => {
    expect(offStacks.auth).toBeUndefined();
    const rehearsal = buildApp(testApp(), rehearsalFrom(prod));
    if (!rehearsal.auth) throw new Error('a rehearsal build must synthesise Auth');
    expect(rehearsal.auth.stackName).toBe('RehearsalAuth');
    const rehearsalPool: any = only(
      Template.fromStack(rehearsal.auth).findResources('AWS::Cognito::UserPool'),
    );
    expect(rehearsalPool.DeletionPolicy).toBe('Delete');
    expect(rehearsalPool.Properties.DeletionProtection).toBe('INACTIVE');
    const rehearsalDomain: any = only(
      Template.fromStack(rehearsal.auth).findResources('AWS::Cognito::UserPoolDomain'),
    );
    expect(rehearsalDomain.Properties.Domain).toBe('plainsight-rehearsal-679345828813');
  });
});

describe('Api stack (spec §5 Lambda rules; backend spec §2 route table)', () => {
  const functions = api.findResources('AWS::Lambda::Function');

  it('every Lambda: ARM64, Node 22, explicit timeout and memory', () => {
    const entries = Object.values(functions);
    expect(entries).toHaveLength(11);
    for (const fn of entries as any[]) {
      expect(fn.Properties.Architectures).toEqual(['arm64']);
      expect(fn.Properties.Runtime).toBe('nodejs22.x');
      expect(fn.Properties.MemorySize).toBe(256);
    }
    // Reads, job routes, and the pairs transport answer in 10 seconds, the
    // sync functions carry the pinned 15, and the proxy its 25 (backend
    // spec §10 inventory).
    const timeouts = entries.map((fn: any) => fn.Properties.Timeout).sort((a: number, b: number) => a - b);
    expect(timeouts).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 15, 15, 25]);
    // The company routes, both sync functions, both job routes, and both
    // pairs functions read the table; search, the presigner, and the proxy
    // deliberately do not (the proxy carries no environment at all:
    // destination from the registry, key from the caller).
    const withTable = entries.filter(
      (fn: any) => fn.Properties.Environment?.Variables?.TABLE_NAME !== undefined,
    );
    expect(withTable).toHaveLength(8);
    const withoutEnvironment = entries.filter((fn: any) => fn.Properties.Environment === undefined);
    expect(withoutEnvironment).toHaveLength(1);
    expect((withoutEnvironment[0] as any).Properties.Timeout).toBe(25);
    const search: any = entries.find(
      (fn: any) => fn.Properties.Environment.Variables.INDEX_BUCKET !== undefined,
    );
    expect(search).toBeDefined();
    expect(search.Properties.Environment.Variables.TABLE_NAME).toBeUndefined();
    expect(search.Properties.Environment.Variables.INDEX_KEY).toBe(
      'edgar/company_tickers_exchange.json',
    );
  });

  it('log retention is explicit log groups, not the custom-resource shortcut', () => {
    // One group per function plus the access-log group; every group 30 days.
    const groups = Object.values(api.findResources('AWS::Logs::LogGroup')) as any[];
    expect(groups).toHaveLength(12);
    for (const group of groups) {
      expect(group.Properties.RetentionInDays).toBe(30);
    }
    for (const fn of Object.values(functions) as any[]) {
      expect(fn.Properties.LoggingConfig.LogGroup).toBeDefined();
    }
    const resources: Record<string, { Type: string }> = api.toJSON().Resources ?? {};
    const customTypes = Object.values(resources)
      .map((resource) => resource.Type)
      .filter((type) => type.startsWith('Custom::') || type === 'AWS::CloudFormation::CustomResource');
    expect(customTypes).toEqual([]);
  });

  it('exposes exactly the route table, with auth exactly where the spec flags it', () => {
    // The spec §6 route invariant: every route the backend spec flags auth
    // carries the Cognito authoriser, and no unflagged route does.
    const routes = Object.values(api.findResources('AWS::ApiGatewayV2::Route')) as any[];
    expect(routes.map((route) => route.Properties.RouteKey).sort()).toEqual([
      'GET /v1/companies/{ticker}',
      'GET /v1/companies/{ticker}/financials',
      'GET /v1/extractions/{jobId}',
      'GET /v1/pairs/artefacts/{kind}',
      'GET /v1/search',
      'GET /v1/sync/pull',
      'POST /v1/extractions',
      'POST /v1/proxy/{providerId}',
      'POST /v1/sync/push',
      'POST /v1/uploads',
      'PUT /v1/pairs/artefacts/{kind}',
    ]);
    for (const route of routes) {
      const key: string = route.Properties.RouteKey;
      const flagged =
        key.includes('/v1/sync/') ||
        key.includes('/v1/proxy/') ||
        key.includes('/v1/uploads') ||
        key.includes('/v1/extractions') ||
        key.includes('/v1/pairs/');
      if (flagged) {
        expect(route.Properties.AuthorizationType).toBe('JWT');
        expect(route.Properties.AuthorizerId).toBeDefined();
      } else {
        expect(route.Properties.AuthorizationType ?? 'NONE').toBe('NONE');
      }
    }
  });

  it('the one authoriser is the user pool, checked at the gateway', () => {
    const authorizer: any = only(api.findResources('AWS::ApiGatewayV2::Authorizer'));
    expect(authorizer.Properties.AuthorizerType).toBe('JWT');
    expect(authorizer.Properties.IdentitySource).toEqual(['$request.header.Authorization']);
    expect(authorizer.Properties.JwtConfiguration.Audience).toBeDefined();
    expect(JSON.stringify(authorizer.Properties.JwtConfiguration.Issuer)).toContain('cognito-idp');
  });

  it('the search role touches one S3 object and no table', () => {
    const policies = Object.values(api.findResources('AWS::IAM::Policy')) as any[];
    const searchPolicy = policies.find((policy) =>
      policy.Properties.PolicyDocument.Statement.some(
        (statement: any) => statement.Sid === 'ReadWriteTickerIndexObject',
      ),
    );
    expect(searchPolicy).toBeDefined();
    const statements: any[] = searchPolicy.Properties.PolicyDocument.Statement;
    const s3Statement = statements.find((entry) => entry.Sid === 'ReadWriteTickerIndexObject');
    expect(s3Statement.Action).toEqual(['s3:GetObject', 's3:PutObject']);
    expect(JSON.stringify(s3Statement.Resource)).toContain('edgar/company_tickers_exchange.json');
    const actions = statements.flatMap((entry) => [entry.Action].flat());
    expect(actions.filter((action: string) => action.startsWith('dynamodb:'))).toEqual([]);
  });

  it('throttles every route at the pinned rate and logs access with the request id', () => {
    const stage: any = only(api.findResources('AWS::ApiGatewayV2::Stage'));
    expect(stage.Properties.DefaultRouteSettings).toEqual(
      expect.objectContaining({ ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 }),
    );
    const format: string = stage.Properties.AccessLogSettings.Format;
    expect(format).toContain('$context.requestId');
    // The redaction rule (backend spec §11): no header or payload variables.
    expect(format).not.toContain('$context.authorizer');
    expect(format).not.toContain('header');
  });

  it('the halt alert publishes to exactly the one alert topic', () => {
    // Integration plan §10: the pairs put function may nudge the
    // Foundation alert topic when a halted daily artefact lands, and
    // nothing else on this stack may publish to SNS at all.
    const policies = Object.values(api.findResources('AWS::IAM::Policy')) as any[];
    const snsStatements = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .filter((statement) => [statement.Action].flat().some((action: string) => action.startsWith('sns:')));
    expect(snsStatements).toHaveLength(1);
    const statement = snsStatements[0];
    expect(statement.Sid).toBe('PublishHaltAlert');
    expect([statement.Action].flat()).toEqual(['sns:Publish']);
    // The resource is the imported Foundation topic, never a wildcard.
    expect(JSON.stringify(statement.Resource)).not.toContain('*');
    const putPairs: any = Object.values(functions).find(
      (fn: any) => fn.Properties.Environment?.Variables?.ALERT_TOPIC_ARN !== undefined,
    );
    expect(putPairs).toBeDefined();
    expect(putPairs.Properties.Environment.Variables.UPLOADS_BUCKET).toBeDefined();
  });

  it('table writes exist only on the sync and job-start roles, key-prefix confined', () => {
    // The read path stays write-free; the sync functions write under USER#
    // and IDEMP# leading keys, and the job starter under JOB#, USER#, and
    // IDEMP# (backend spec §3 ownership: ticker partitions belong to
    // ingestion).
    const policies = Object.values(api.findResources('AWS::IAM::Policy')) as any[];
    expect(policies.length).toBeGreaterThan(0);
    const writeActions = ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'];
    const writeBearing: any[] = [];
    for (const policy of policies) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        const actions: string[] = [statement.Action].flat();
        if (actions.some((action) => writeActions.includes(action))) {
          writeBearing.push(statement);
        }
      }
    }
    const expectedKeysBySid: Record<string, string[]> = {
      ReadWriteUserPartitions: ['USER#*', 'IDEMP#*'],
      WriteJobsQuotaAndReplays: ['JOB#*', 'USER#*', 'IDEMP#*'],
      WritePairsRuns: ['PAIRS#*'],
    };
    expect(writeBearing.map((statement) => statement.Sid).sort()).toEqual([
      'ReadWriteUserPartitions',
      'ReadWriteUserPartitions',
      'WriteJobsQuotaAndReplays',
      'WritePairsRuns',
    ]);
    for (const statement of writeBearing) {
      expect(statement.Condition).toEqual({
        'ForAllValues:StringLike': {
          'dynamodb:LeadingKeys': expectedKeysBySid[statement.Sid as string],
        },
      });
      expect([statement.Action].flat()).not.toContain('dynamodb:DeleteItem');
      expect([statement.Action].flat()).not.toContain('dynamodb:BatchWriteItem');
    }
  });
});

describe('Ingestion stack (backend spec §5, §10; main plan §6 tracing rule)', () => {
  const functions = Object.values(ingestion.findResources('AWS::Lambda::Function')) as any[];
  const ingestFn: any = functions.find((fn) => fn.Properties.Timeout === 120);
  const dispatcherFn: any = functions.find((fn) => fn.Properties.Timeout === 60);
  const extractFn: any = functions.find((fn) => fn.Properties.Timeout === 300);
  const policies = Object.values(ingestion.findResources('AWS::IAM::Policy')) as any[];
  const statementsWithSid = (sid: string): any =>
    policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .find((statement) => statement.Sid === sid);

  it('the ingest function carries the pinned sizing and X-Ray tracing', () => {
    expect(functions).toHaveLength(3);
    expect(ingestFn).toBeDefined();
    expect(ingestFn.Properties.MemorySize).toBe(512);
    expect(ingestFn.Properties.Architectures).toEqual(['arm64']);
    expect(ingestFn.Properties.Runtime).toBe('nodejs22.x');
    expect(ingestFn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
    expect(ingestFn.Properties.Environment.Variables.TABLE_NAME).toBeDefined();
    expect(ingestFn.Properties.Environment.Variables.EDGAR_CONTACT_PARAMETER).toBe(
      '/app/prod/edgar/contact',
    );
    // The router knows the extraction function; the delegation is the .AX fork.
    expect(ingestFn.Properties.Environment.Variables.EXTRACT_FUNCTION_NAME).toBeDefined();
  });

  it('the extraction function carries the pinned §10 sizing and scoped grants', () => {
    expect(extractFn).toBeDefined();
    expect(extractFn.Properties.MemorySize).toBe(1536);
    expect(extractFn.Properties.Architectures).toEqual(['arm64']);
    expect(extractFn.Properties.Runtime).toBe('nodejs22.x');
    expect(extractFn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
    expect(extractFn.Properties.Environment.Variables.TABLE_NAME).toBeDefined();
    expect(extractFn.Properties.Environment.Variables.CONTACT_PARAMETER).toBe(
      '/app/prod/edgar/contact',
    );
    // The spender honours the kill switch (backend spec §11; the runbook).
    expect(extractFn.Properties.Environment.Variables.EXTRACTION_FLAG_PARAMETER).toBe(
      '/app/prod/features/extraction',
    );

    // Writes stay inside ticker partitions, with GetItem for the DOC# cache
    // and JOB# joining for the upload-job walk (backend spec §6).
    const writes = statementsWithSid('ExtractWriteTickerPartitions');
    expect(writes.Action).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:BatchWriteItem',
    ]);
    expect(writes.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TICKER#*', 'JOB#*'] },
    });
    const uploadsRead = statementsWithSid('ReadUploadedFilings');
    expect(uploadsRead.Action).toBe('s3:GetObject');
    expect(JSON.stringify(uploadsRead.Resource)).toContain('/uploads/*');

    // Provider keys are readable only under the extraction prefix.
    const keys = statementsWithSid('ReadProviderKeyParameters');
    expect(keys.Action).toBe('ssm:GetParameter');
    expect(JSON.stringify(keys.Resource)).toContain('parameter/app/prod/extraction/*');

    // Exactly two invoke grants exist in this stack (the sweep task invoking
    // the router; the router delegating to extraction), each aimed at one
    // named function, never a wildcard.
    const invokes = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .filter((statement) => [statement.Action].flat().includes('lambda:InvokeFunction'));
    expect(invokes).toHaveLength(2);
    for (const statement of invokes) {
      expect(JSON.stringify(statement.Resource)).toContain('Fn');
      expect(JSON.stringify(statement.Resource)).not.toContain('"*"');
    }
  });

  it('reads and writes only ticker partitions, never deletes, and reads one SSM parameter', () => {
    // GetItem is the sweep's freshness check (the stored filing marker); it
    // rides the same ticker-partition condition as the writes.
    const writes = statementsWithSid('WriteTickerPartitions');
    expect(writes.Action).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:BatchWriteItem',
    ]);
    expect(writes.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['TICKER#*'] },
    });
    const allActions = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .flatMap((statement) => [statement.Action].flat());
    expect(allActions).not.toContain('dynamodb:DeleteItem');
    expect(allActions).not.toContain('dynamodb:Scan');
    const ssmRead = statementsWithSid('ReadEdgarContactParameter');
    expect(ssmRead.Action).toBe('ssm:GetParameter');
    expect(JSON.stringify(ssmRead.Resource)).toContain('parameter/app/prod/edgar/contact');
  });

  it('the dispatcher lists watched tickers, refreshes one object, and starts one state machine', () => {
    expect(dispatcherFn).toBeDefined();
    expect(dispatcherFn.Properties.Environment.Variables.STATE_MACHINE_ARN).toBeDefined();
    expect(dispatcherFn.Properties.Environment.Variables.WATCH_INDEX_NAME).toBe('watchedTickers');
    const query = statementsWithSid('QueryWatchedTickers');
    expect(query.Action).toBe('dynamodb:Query');
    expect(JSON.stringify(query.Resource)).toContain('/index/watchedTickers');
    expect(query.Condition).toEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WATCH'] },
    });
    const refresh = statementsWithSid('RefreshTickerIndexObject');
    expect(refresh.Action).toBe('s3:PutObject');
    expect(JSON.stringify(refresh.Resource)).toContain('edgar/company_tickers_exchange.json');
    const starts = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .filter((statement) => [statement.Action].flat().includes('states:StartExecution'));
    expect(starts).toHaveLength(1);
  });

  it('the sweep map runs at concurrency 2 in sweep mode with a per-item catch to the DLQ', () => {
    const machine: any = only(ingestion.findResources('AWS::StepFunctions::StateMachine'));
    // The definition is a CFN join; stringifying escapes its inner quotes.
    const definition = JSON.stringify(machine.Properties.DefinitionString);
    expect(definition).toContain('\\"MaxConcurrency\\":2');
    expect(definition).toContain('\\"mode\\":\\"sweep\\"');
    expect(definition).toContain('SendToDlq');
    expect(machine.Properties.TracingConfiguration).toEqual({ Enabled: true });
    expect(machine.Properties.LoggingConfiguration.Level).toBe('ALL');
  });

  it('runs weekly and alarms on DLQ depth and sweep failure, to the alert topic', () => {
    const rule: any = only(ingestion.findResources('AWS::Events::Rule'));
    expect(rule.Properties.ScheduleExpression).toBe('cron(0 19 ? * SUN *)');
    const queue: any = only(ingestion.findResources('AWS::SQS::Queue'));
    expect(queue.Properties.MessageRetentionPeriod).toBe(14 * 24 * 60 * 60);
    const alarms = Object.values(ingestion.findResources('AWS::CloudWatch::Alarm')) as any[];
    // DLQ depth, sweep failure, and the extraction function's errors (its
    // delegation is asynchronous, so failures never reach the sweep DLQ).
    expect(alarms).toHaveLength(3);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(alarm.Properties.Threshold).toBe(1);
    }
    expect(
      alarms.some((alarm) => alarm.Properties.MetricName === 'Errors'),
    ).toBe(true);
  });

  it('exactly two named invokes exist: the ingest fire and the worker fire', () => {
    const financials: any = Object.values(api.findResources('AWS::Lambda::Function')).find(
      (candidate: any) => candidate.Properties.Environment?.Variables?.INGEST_FUNCTION_NAME,
    );
    expect(financials).toBeDefined();
    const policies = Object.values(api.findResources('AWS::IAM::Policy')) as any[];
    const invokeStatements = policies
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .filter((statement) => [statement.Action].flat().includes('lambda:InvokeFunction'));
    expect(invokeStatements.map((statement) => statement.Sid).sort()).toEqual([
      'FireExtractionWorker',
      'FireIngest',
    ]);
    for (const statement of invokeStatements) {
      expect(JSON.stringify(statement.Resource)).not.toContain('"*"');
    }
  });

  it('an api-only build serves 202 without the ingest wiring', () => {
    const apiOnly = buildApp(testApp(), {
      ...featuresOffConfig,
      features: { ...featuresOffConfig.features, api: true },
    });
    expect(apiOnly.ingestion).toBeUndefined();
    expect(apiOnly.api).toBeDefined();
    if (!apiOnly.api) return;
    const template = Template.fromStack(apiOnly.api);
    for (const fnResource of Object.values(template.findResources('AWS::Lambda::Function')) as any[]) {
      expect(fnResource.Properties.Environment.Variables.INGEST_FUNCTION_NAME).toBeUndefined();
    }
  });
});

describe('the edge (cdk spec §3: the same distribution fronts /v1/*)', () => {
  const distribution: any = only(staticSite.findResources('AWS::CloudFront::Distribution'));
  const distributionOff: any = only(staticSiteOff.findResources('AWS::CloudFront::Distribution'));

  it('SPA routing is a viewer-request rewrite, not distribution-wide error responses', () => {
    for (const candidate of [distribution, distributionOff]) {
      const distributionConfig = candidate.Properties.DistributionConfig;
      // Custom error responses would rewrite API not_found envelopes into
      // the app shell; the rewrite function is scoped to the site behaviour.
      expect(distributionConfig.CustomErrorResponses).toBeUndefined();
      expect(distributionConfig.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
    }
    const fn: any = only(staticSite.findResources('AWS::CloudFront::Function'));
    expect(fn.Properties.FunctionCode).toContain("startsWith('/v1/')");
    expect(fn.Properties.FunctionCode).toContain("request.uri = '/index.html'");
  });

  it('every feature off keeps the single-origin distribution', () => {
    const distributionConfig = distributionOff.Properties.DistributionConfig;
    expect(distributionConfig.CacheBehaviors).toBeUndefined();
    expect(distributionConfig.Origins).toHaveLength(1);
  });

  it('the financials path caches 6 hours, everything else on /v1/* does not', () => {
    const distributionConfig = distribution.Properties.DistributionConfig;
    expect(distributionConfig.Origins).toHaveLength(2);
    const behaviours: any[] = distributionConfig.CacheBehaviors;
    // Insertion order is precedence: the specific path must outrank the
    // catch-all.
    expect(behaviours.map((behaviour) => behaviour.PathPattern)).toEqual([
      '/v1/companies/*/financials',
      '/v1/*',
    ]);
    for (const behaviour of behaviours) {
      expect(behaviour.ViewerProtocolPolicy).toBe('redirect-to-https');
      // No SPA rewrite on the API behaviours.
      expect(behaviour.FunctionAssociations ?? []).toEqual([]);
    }
    // The cached financials path is read-only; the uncached catch-all
    // carries the writable routes (sync push now, uploads later), so every
    // method passes there.
    expect(behaviours[0].AllowedMethods).toEqual(['GET', 'HEAD']);
    expect([...behaviours[1].AllowedMethods].sort()).toEqual([
      'DELETE',
      'GET',
      'HEAD',
      'OPTIONS',
      'PATCH',
      'POST',
      'PUT',
    ]);
    // The catch-all uses the managed CachingDisabled policy.
    expect(behaviours[1].CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');

    const cachePolicy: any = only(staticSite.findResources('AWS::CloudFront::CachePolicy'));
    const policyConfig = cachePolicy.Properties.CachePolicyConfig;
    expect(policyConfig.DefaultTTL).toBe(6 * 60 * 60);
    expect(policyConfig.MaxTTL).toBe(6 * 60 * 60);
    expect(policyConfig.MinTTL).toBe(0);
    expect(policyConfig.ParametersInCacheKeyAndForwardedToOrigin.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: ['years', 'statements'],
    });
  });

  it('publishes the distribution id for the ingest path, and only when the edge fronts the API', () => {
    staticSite.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/app/prod/cloudfront/distribution-id',
    });
    expect(Object.keys(staticSiteOff.findResources('AWS::SSM::Parameter'))).toEqual([]);
  });

  it('the ingest function can read the id and invalidate, nothing else new', () => {
    const ingestFns = Object.values(ingestion.findResources('AWS::Lambda::Function')) as any[];
    const ingestFn = ingestFns.find((fn) => fn.Properties.Timeout === 120);
    expect(ingestFn.Properties.Environment.Variables.DISTRIBUTION_ID_PARAMETER).toBe(
      '/app/prod/cloudfront/distribution-id',
    );
    const statements = (Object.values(ingestion.findResources('AWS::IAM::Policy')) as any[])
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[]);
    const invalidate = statements.find((statement) => statement.Sid === 'InvalidateFinancialsPath');
    expect(invalidate.Action).toBe('cloudfront:CreateInvalidation');
    expect(JSON.stringify(invalidate.Resource)).toContain(':distribution/*');
    const readId = statements.find((statement) => statement.Sid === 'ReadDistributionIdParameter');
    expect(JSON.stringify(readId.Resource)).toContain('parameter/app/prod/cloudfront/distribution-id');
  });
});

describe('the budget kill switch (cdk spec §8; backend spec §10)', () => {
  it('every feature off keeps Foundation compute-free and three-notification', () => {
    expect(Object.keys(foundationOff.findResources('AWS::Lambda::Function'))).toEqual([]);
    const budget: any = only(foundationOff.findResources('AWS::Budgets::Budget'));
    expect(budget.Properties.NotificationsWithSubscribers).toHaveLength(3);
  });

  it('the spend-capable prod wires the flipper to its own topic at the kill threshold', () => {
    const flipper: any = only(foundation.findResources('AWS::Lambda::Function'));
    expect(flipper.Properties.Timeout).toBe(30);
    expect(flipper.Properties.MemorySize).toBe(128);
    expect(flipper.Properties.Environment.Variables.EXTRACTION_FLAG_PARAMETER).toBe(
      '/app/prod/features/extraction',
    );

    const budget: any = only(foundation.findResources('AWS::Budgets::Budget'));
    const notifications: any[] = budget.Properties.NotificationsWithSubscribers;
    // The kill threshold's notification publishes to the flipper's own
    // topic, not the alert topic (one SNS subscriber per notification is a
    // Budgets service rule); the flipper's relay keeps the owner informed.
    const killEntry = notifications.find(
      (entry) => entry.Notification.Threshold === prod.budgets.killSwitchAt,
    );
    const alertAddress = JSON.stringify(notifications[0].Subscribers[0].Address);
    expect(JSON.stringify(killEntry.Subscribers[0].Address)).not.toBe(alertAddress);
    // The relay's wiring: the flipper knows the alert topic and may publish to it.
    expect(flipper.Properties.Environment.Variables.ALERT_TOPIC_ARN).toHaveProperty('Ref');
    const policies = Object.values(foundation.findResources('AWS::IAM::Policy')) as any[];
    const statements = policies.flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as any[],
    );
    expect(
      statements.some((statement) => JSON.stringify(statement.Action).includes('sns:Publish')),
    ).toBe(true);

    const flip = statements.find((statement) => statement.Sid === 'FlipExtractionFlag');
    expect(flip.Action).toBe('ssm:PutParameter');
    expect(JSON.stringify(flip.Resource)).toContain('parameter/app/prod/features/extraction');
  });
});

describe('tagging (spec §4: project/env/owner at the root)', () => {
  const expectedTags = Match.arrayWith([
    { Key: 'env', Value: 'prod' },
    { Key: 'owner', Value: 'ivan' },
    { Key: 'project', Value: 'plainsight' },
  ]);

  it('reaches a taggable resource in every stack', () => {
    foundation.hasResourceProperties('AWS::SNS::Topic', Match.objectLike({ Tags: expectedTags }));
    githubOidc.hasResourceProperties('AWS::IAM::Role', Match.objectLike({ Tags: expectedTags }));
    staticSite.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({ Tags: expectedTags }));
  });
});

describe('rehearsal overlay (spec §2: same code, prefixed names, disposable data)', () => {
  const rehearsalApp = testApp();
  const rehearsal = buildApp(rehearsalApp, rehearsalFrom(prod));

  it('prefixes stack names and skips the one-time GithubOidc scaffolding', () => {
    expect(rehearsal.foundation.stackName).toBe('RehearsalFoundation');
    expect(rehearsal.staticSite.stackName).toBe('RehearsalStaticSite');
    expect(rehearsal.githubOidc).toBeUndefined();
  });

  it('relaxes data protection so teardown stays a five-minute operation', () => {
    Template.fromStack(rehearsal.staticSite).hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
    });
  });

  it('watches its own project tag, and a rehearsal copy adds no second monitor', () => {
    const rehearsalFoundation = Template.fromStack(rehearsal.foundation);
    expect(Object.keys(rehearsalFoundation.findResources('AWS::CE::AnomalyMonitor'))).toEqual([]);
    // The prod Foundation carries it, CUSTOM and tag-scoped: the shared
    // account's one DIMENSIONAL slot belongs to the account's existing
    // monitor (ADR 0001 amendment), and rehearsal spend wears the same
    // project tag, so it already lands inside this scope.
    const monitor: any = only(foundation.findResources('AWS::CE::AnomalyMonitor'));
    expect(monitor.Properties.MonitorType).toBe('CUSTOM');
    // Bare 'project', never the budget's 'user:project': Cost Explorer
    // expressions take the unprefixed key, and a prefixed one is read
    // literally, matching no spend, silently. Each service keeps its own
    // documented form.
    expect(JSON.parse(monitor.Properties.MonitorSpecification)).toEqual({
      Tags: { Key: 'project', Values: ['plainsight'], MatchOptions: ['EQUALS'] },
    });
    // The name must carry a digest of the specification, not a fixed string:
    // MonitorSpecification is create-only, so a fixed name collides with the
    // torn-down monitor on every spec change (AlreadyExists). Pinning the
    // spec-derived name keeps that replacement collision-free and stops a
    // future "tidy the name" from reintroducing the failed-deploy trap.
    const digest = createHash('sha256')
      .update(monitor.Properties.MonitorSpecification)
      .digest('hex')
      .slice(0, 8);
    expect(monitor.Properties.MonitorName).toBe(`plainsight-project-costs-${digest}`);
    expect(Object.keys(foundation.findResources('AWS::CE::AnomalySubscription'))).toHaveLength(1);
  });
});
