// ShapesOS on AWS — the settings that matter, asserted on the synthesized
// CloudFormation (aws-cdk-lib/assertions). No AWS credentials needed.
// Run: cd infra/aws && npm test

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";

import { buildApp } from "../lib/build-app.ts";
import { ALB_IDLE_TIMEOUT_SECONDS, DEREGISTRATION_DELAY_SECONDS, HEALTH_CHECK_PATH } from "../lib/app-stack.ts";
import { AUTH_RATE_LIMIT_PER_5_MIN } from "../lib/edge-global-stack.ts";
import { ORIGIN_READ_TIMEOUT_SECONDS } from "../lib/edge-stack.ts";
import { readConfig } from "../lib/config.ts";
import { bootstrapTemplate } from "../lib/bootstrap-template.ts";

const CDK_CONTEXT = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")).context as Record<string, unknown>;

function synth(overrides: Record<string, unknown> = {}) {
  const app = new App({ context: { ...CDK_CONTEXT, ...overrides } });
  const stacks = buildApp(app);
  const t = (s: { stackName: string }) => Template.fromStack(s as never);
  return {
    stacks,
    network: t(stacks.network),
    data: t(stacks.data),
    app: t(stacks.app),
    edgeGlobal: t(stacks.edgeGlobal),
    edge: t(stacks.edge),
    ops: t(stacks.ops),
  };
}

const s = synth();

/** The env-var list of one container in a task definition template. */
function containerEnv(t: Template, containerName: string) {
  const defs = t.findResources("AWS::ECS::TaskDefinition");
  for (const def of Object.values(defs)) {
    const c = (def.Properties.ContainerDefinitions as Array<Record<string, unknown>>).find((x) => x.Name === containerName);
    if (c) {
      const env = Object.fromEntries(((c.Environment ?? []) as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]));
      const secrets = ((c.Secrets ?? []) as Array<{ Name: string }>).map((x) => x.Name);
      return { env, secrets, command: c.Command as string[], stopTimeout: c.StopTimeout as number | undefined };
    }
  }
  throw new Error(`no container ${containerName}`);
}

describe("network", () => {
  it("has no NAT gateway by default; tasks get public IPs", () => {
    s.network.resourceCountIs("AWS::EC2::NatGateway", 0);
    s.app.allResourcesProperties("AWS::ECS::Service", {
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "ENABLED" } },
    });
  });
  it("-c natGateway=true adds exactly one NAT and moves tasks to private subnets", () => {
    const n = synth({ natGateway: "true" });
    n.network.resourceCountIs("AWS::EC2::NatGateway", 1);
    n.app.allResourcesProperties("AWS::ECS::Service", {
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: "DISABLED" } },
    });
  });
  it("spans 2 Availability Zones (public + isolated subnets)", () => {
    s.network.resourceCountIs("AWS::EC2::Subnet", 4);
  });
});

describe("load balancer and services", () => {
  it(`ALB is internal with a ${ALB_IDLE_TIMEOUT_SECONDS}s idle timeout`, () => {
    s.app.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internal",
      LoadBalancerAttributes: Match.arrayWith([{ Key: "idle_timeout.timeout_seconds", Value: String(ALB_IDLE_TIMEOUT_SECONDS) }]),
    });
  });
  it("ALB admits only the VPC (CloudFront's VPC origin), never the internet", () => {
    const sgs = s.app.findResources("AWS::EC2::SecurityGroup", { Properties: { GroupDescription: Match.stringLikeRegexp("ALB") } });
    for (const sg of Object.values(sgs)) {
      for (const rule of (sg.Properties.SecurityGroupIngress ?? []) as Array<{ CidrIp?: unknown }>) {
        assert.notEqual(rule.CidrIp, "0.0.0.0/0");
      }
    }
  });
  it(`target group: ${HEALTH_CHECK_PATH} health check, ${DEREGISTRATION_DELAY_SECONDS}s deregistration delay`, () => {
    s.app.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: HEALTH_CHECK_PATH,
      TargetGroupAttributes: Match.arrayWith([{ Key: "deregistration_delay.timeout_seconds", Value: String(DEREGISTRATION_DELAY_SECONDS) }]),
    });
  });
  it("web runs 2+ tasks, autoscaled on CPU; worker runs without a load balancer", () => {
    s.app.hasResourceProperties("AWS::ECS::Service", { ServiceName: "shapesos-web", DesiredCount: 2, LoadBalancers: Match.anyValue() });
    s.app.hasResourceProperties("AWS::ECS::Service", { ServiceName: "shapesos-worker", DesiredCount: 1, LoadBalancers: Match.absent() });
    s.app.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", { MinCapacity: 2, MaxCapacity: 6 });
    s.app.hasResourceProperties("AWS::ApplicationAutoScaling::ScalingPolicy", {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({ PredefinedMetricSpecification: { PredefinedMetricType: "ECSServiceAverageCPUUtilization" } }),
    });
  });
  it("containers start through the runtime-env wrapper; the app never gets the owner credentials", () => {
    const web = containerEnv(s.app, "web");
    assert.deepEqual(web.command, ["sh", "scripts/deploy/with-runtime-env.sh", "node", "server.js"]);
    assert.equal(web.env.KEEP_ALIVE_TIMEOUT, "310000");
    assert.ok(Number(web.env.KEEP_ALIVE_TIMEOUT) / 1000 > ALB_IDLE_TIMEOUT_SECONDS, "Next keep-alive outlives the ALB idle timeout");
    assert.equal(web.env.DEPLOYMENT_MODE, "hosted");
    assert.equal(web.env.CRON_RUNNER, "internal");
    assert.equal(web.env.AGENT_WORKER, "external");
    assert.equal(web.env.APP_URL, "https://app.shapesos.com");
    assert.equal(web.env.WEBSITE_HOST, "shapesos.com");
    assert.equal(web.env.APP_DB_USER, "shapesos_app");
    assert.equal(web.env.DATABASE_URL, undefined);
    assert.equal(web.stopTimeout, 120);
    assert.ok(web.secrets.includes("APP_DB_PASSWORD"));
    assert.ok(web.secrets.includes("SHAPESOS_ENV_JSON_SHARED") && web.secrets.includes("SHAPESOS_ENV_JSON_WEB"));
    assert.ok(web.secrets.includes("AUTH_SECRET") && web.secrets.includes("MARKETR_CREDENTIALS_KEY") && web.secrets.includes("CRON_SECRET"));
    for (const c of [web, containerEnv(s.app, "worker")]) {
      assert.ok(!c.secrets.some((n) => n.startsWith("SHAPESOS_DB_OWNER")), "owner credentials only on the migrate task");
    }
    const worker = containerEnv(s.app, "worker");
    assert.deepEqual(worker.command, ["sh", "scripts/deploy/with-runtime-env.sh", "node", "node_modules/tsx/dist/cli.mjs", "scripts/worker.mts"]);
    assert.ok(!worker.secrets.includes("CRON_SECRET"), "web-only secrets stay on web");
    const migrate = containerEnv(s.app, "migrate");
    assert.deepEqual(migrate.command, ["sh", "scripts/deploy/with-runtime-env.sh", "--owner", "sh", "scripts/db/migrate.sh"]);
    assert.deepEqual(migrate.secrets.sort(), ["APP_DB_PASSWORD", "SHAPESOS_DB_OWNER_PASSWORD", "SHAPESOS_DB_OWNER_USER"]);
  });
  it("owner-pasted settings secrets carry no value in the template (deploys never overwrite them)", () => {
    const secrets = s.app.findResources("AWS::SecretsManager::Secret", { Properties: { Name: Match.stringLikeRegexp("^shapesos/(shared|web|worker)$") } });
    assert.equal(Object.keys(secrets).length, 3);
    for (const sec of Object.values(secrets)) assert.equal(sec.Properties.SecretString, undefined);
  });
  it("MARKETR_CREDENTIALS_KEY is generated as 64 hex characters", () => {
    s.app.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "shapesos/generated/MARKETR_CREDENTIALS_KEY",
      GenerateSecretString: Match.objectLike({ PasswordLength: 64, ExcludeUppercase: true, ExcludePunctuation: true, ExcludeCharacters: "ghijklmnopqrstuvwxyz" }),
    });
  });
  it("files bucket is private, versioned and TLS-only; the task role is scoped to it", () => {
    s.app.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      VersioningConfiguration: { Status: "Enabled" },
    });
    s.app.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
    });
    const policies = s.app.findResources("AWS::IAM::Policy", { Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp("AppTaskRole") }]) } });
    for (const p of Object.values(policies)) {
      for (const st of p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>) {
        const actions = ([] as string[]).concat(st.Action);
        assert.ok(actions.every((a) => a.startsWith("s3:")), `task role only has S3 actions: ${actions}`);
        assert.ok(JSON.stringify(st.Resource).includes("Files"), "and only on the files bucket");
      }
    }
  });
  it("ECR repositories: scan on push, sha tags immutable, latest may move", () => {
    for (const name of ["shapesos-runner", "shapesos-worker", "shapesos-migrate"]) {
      s.app.hasResourceProperties("AWS::ECR::Repository", {
        RepositoryName: name,
        ImageScanningConfiguration: { ScanOnPush: true },
        ImageTagMutability: "IMMUTABLE_WITH_EXCLUSION",
      });
    }
  });
  it("every log group has a retention period", () => {
    for (const t of [s.app, s.data, s.network, s.edge, s.edgeGlobal, s.ops]) {
      for (const lg of Object.values(t.findResources("AWS::Logs::LogGroup"))) {
        assert.equal(lg.Properties.RetentionInDays, 30);
      }
    }
    assert.equal(Object.keys(s.app.findResources("AWS::Logs::LogGroup")).length, 3);
    s.data.hasResourceProperties("AWS::RDS::DBInstance", { EnableCloudwatchLogsExports: ["postgresql"] });
    // RDS log exports get their retention through CDK's log-retention resource.
    s.data.hasResourceProperties("Custom::LogRetention", { RetentionInDays: 30 });
  });
});

describe("database", () => {
  it("RDS PostgreSQL 16, Multi-AZ, encrypted gp3 50 GB, 35-day backups, deletion protection, isolated", () => {
    s.data.hasResourceProperties("AWS::RDS::DBInstance", {
      Engine: "postgres",
      EngineVersion: "16",
      DBInstanceClass: "db.m7g.large",
      MultiAZ: true,
      StorageEncrypted: true,
      KmsKeyId: Match.anyValue(),
      StorageType: "gp3",
      AllocatedStorage: "50",
      BackupRetentionPeriod: 35,
      DeletionProtection: true,
      PubliclyAccessible: false,
    });
    s.data.hasResource("AWS::RDS::DBInstance", { DeletionPolicy: "Snapshot" });
  });
  it("requires TLS (rds.force_ssl = 1)", () => {
    s.data.hasResourceProperties("AWS::RDS::DBParameterGroup", { Family: "postgres16", Parameters: { "rds.force_ssl": "1" } });
  });
  it("only the web, worker and migrate tasks reach Postgres", () => {
    const rules = s.app.findResources("AWS::EC2::SecurityGroupIngress", { Properties: { FromPort: 5432 } });
    assert.equal(Object.keys(rules).length, 3);
    for (const r of Object.values(rules)) assert.ok(r.Properties.SourceSecurityGroupId, "from a security group, never a CIDR");
  });
});

describe("edge", () => {
  it("CloudFront has the WAF attached, the domains, and the internal ALB as a VPC origin", () => {
    s.edge.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: ["shapesos.com", "app.shapesos.com"],
        WebACLId: Match.anyValue(),
        ViewerCertificate: Match.objectLike({ SslSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" }),
        Origins: Match.arrayWith([Match.objectLike({ VpcOriginConfig: Match.objectLike({ OriginReadTimeout: ORIGIN_READ_TIMEOUT_SECONDS }) })]),
      }),
    });
    s.edge.hasResourceProperties("AWS::CloudFront::VpcOrigin", { VpcOriginEndpointConfig: Match.objectLike({ OriginProtocolPolicy: "http-only" }) });
  });
  it("SSE: the origin read timeout leaves room for the 15 s heartbeat; nothing dynamic is cached", () => {
    assert.ok(ORIGIN_READ_TIMEOUT_SECONDS >= 30 && ORIGIN_READ_TIMEOUT_SECONDS <= 120);
    const dist = Object.values(s.edge.findResources("AWS::CloudFront::Distribution"))[0]!;
    const dc = dist.Properties.DistributionConfig;
    // Managed CachingDisabled + AllViewer on the default behaviour.
    assert.equal(dc.DefaultCacheBehavior.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    assert.equal(dc.DefaultCacheBehavior.OriginRequestPolicyId, "216adef6-5c7f-47e4-b989-5492eafa07d3");
    const paths = (dc.CacheBehaviors as Array<{ PathPattern: string }>).map((b) => b.PathPattern).sort();
    assert.deepEqual(paths, ["/_next/static/*", "/updates/*"]);
  });
  it("WAF: CLOUDFRONT scope, managed rules, and a rate limit on /api/auth/*", () => {
    assert.equal(s.stacks.edgeGlobal.region, "us-east-1");
    s.edgeGlobal.hasResourceProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      Rules: Match.arrayWith([
        Match.objectLike({ Name: "AWSManagedRulesCommonRuleSet" }),
        Match.objectLike({
          Name: "auth-rate-limit",
          Action: { Block: {} },
          Statement: {
            RateBasedStatement: Match.objectLike({
              Limit: AUTH_RATE_LIMIT_PER_5_MIN,
              AggregateKeyType: "IP",
              ScopeDownStatement: { ByteMatchStatement: Match.objectLike({ SearchString: "/api/auth/", PositionalConstraint: "STARTS_WITH" }) },
            }),
          },
        }),
      ]),
    });
  });
  it("certificate covers both hosts (us-east-1)", () => {
    s.edgeGlobal.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "shapesos.com",
      SubjectAlternativeNames: ["app.shapesos.com"],
      ValidationMethod: "DNS",
    });
  });
  it("with -c hostedZoneId, DNS aliases are created", () => {
    const z = synth({ hostedZoneId: "Z0123456789ABC" });
    z.edge.resourceCountIs("AWS::Route53::RecordSet", 2);
    s.edge.resourceCountIs("AWS::Route53::RecordSet", 0);
  });
});

describe("ops", () => {
  it("alarms notify the topic; a monthly budget exists", () => {
    assert.ok(s.stacks.ops.alarms.length >= 7);
    for (const a of Object.values(s.ops.findResources("AWS::CloudWatch::Alarm"))) {
      assert.ok((a.Properties.AlarmActions as unknown[]).length > 0);
    }
    s.ops.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({ BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 2000, Unit: "USD" } }),
    });
  });
  it("-c alarmEmail subscribes an address", () => {
    synth({ alarmEmail: "ops@example.com" }).ops.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "ops@example.com" });
  });
});

describe("regions and settings", () => {
  it("another region keeps the certificate and WAF in us-east-1 (cross-region references)", () => {
    const eu = synth({ region: "eu-central-1", account: "123456789012" });
    assert.equal(eu.stacks.app.region, "eu-central-1");
    assert.equal(eu.stacks.edgeGlobal.region, "us-east-1");
  });
  it("rejects bad settings", () => {
    assert.throws(() => readConfig((k) => ({ region: "eu-west-1" })[k]), /needs -c account/);
    assert.throws(() => readConfig((k) => ({ domain: "not a domain" })[k]), /not a domain/);
    assert.throws(() => readConfig((k) => ({ account: "12" })[k]), /12-digit/);
    assert.throws(() => readConfig((k) => ({ availabilityZones: "us-east-1a" })[k]), /exactly 2/);
    assert.throws(() => synth({ logRetentionDays: 31 }), /logRetentionDays must be one of/);
  });
});

describe("GitHub OIDC bootstrap template", () => {
  const t = bootstrapTemplate() as { Resources: Record<string, { Type: string; Properties: Record<string, unknown>; Condition?: string }>; Rules?: unknown; Parameters: Record<string, unknown> };
  const roles = Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Role");
  it("trusts only this repository's production environment, audience sts.amazonaws.com", () => {
    assert.equal(roles.length, 2);
    for (const r of roles) {
      const st = (r.Properties.AssumeRolePolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
      assert.equal(st.length, 1);
      assert.equal(st[0]!.Action, "sts:AssumeRoleWithWebIdentity");
      assert.deepEqual(st[0]!.Condition, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:Villain336/ShapesOS:environment:production",
        },
      });
    }
  });
  it("is standalone: no bootstrap-version rule, and the provider is optional", () => {
    assert.equal(t.Rules, undefined);
    assert.equal((t.Parameters as Record<string, unknown>).BootstrapVersion, undefined);
    const provider = Object.values(t.Resources).find((r) => r.Type === "AWS::IAM::OIDCProvider")!;
    assert.equal(provider.Condition, "CreateProvider");
    assert.deepEqual(provider.Properties.ClientIdList, ["sts.amazonaws.com"]);
    assert.equal(provider.Properties.Url, "https://token.actions.githubusercontent.com");
  });
  it("the deploy role can assume the CDK roles and push shapesos-* images only", () => {
    const deploy = roles.find((r) => r.Properties.RoleName === "shapesos-github-deploy")!;
    assert.ok(deploy);
    const policies = Object.values(t.Resources).filter((r) => r.Type === "AWS::IAM::Policy");
    const all = JSON.stringify(policies);
    assert.match(all, /cdk-hnb659fds-\*/);
    assert.match(all, /repository\/shapesos-\*/);
    assert.doesNotMatch(all, /"Action":"\*"/);
  });
});
