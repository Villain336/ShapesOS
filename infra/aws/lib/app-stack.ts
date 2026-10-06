// App: container registry, ECS on Fargate, the internal load balancer,
// storage buckets, secrets and the migrate task.
//
//   ECR      shapesos-runner / -worker / -migrate (scan on push; sha tags are
//            immutable, `latest` may move)
//   web      Fargate service behind an INTERNAL Application Load Balancer that
//            only CloudFront reaches (a VPC origin, edge-stack.ts). Idle
//            timeout 300 s (SSE streams send a heartbeat at least every 15 s),
//            deregistration delay 90 s, 2+ tasks autoscaled on CPU, health
//            check /api/health/live.
//   worker   Fargate service, no load balancer.
//   migrate  task definition for one-off runs (release: `aws ecs run-task`),
//            the only place the owner credentials are injected.
//   files    private S3 bucket (blocked public access, versioned, TLS only).
//            (The desktop-updates bucket lives in the edge stack, next to the
//            distribution that serves it, so the OAC policy has no cycle.)
//
// Secrets: Secrets Manager. One JSON secret per env group (shapesos/shared,
// shapesos/web, shapesos/worker) holds every owner-pasted key (names from
// scripts/deploy/render-env.mjs; `npm run secret-skeleton -- <group>` prints
// the JSON to paste), plus one generated secret per generated key. The
// container start wrapper (scripts/deploy/with-runtime-env.sh) exports the
// non-empty keys and composes DATABASE_URL for the app role.

import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { ShapesConfig } from "./config.ts";
import { DB_APP_USER, DB_NAME } from "./data-stack.ts";
import { awsEnvPlan, type Group } from "./env-plan.ts";
import { logRetention } from "./retention.ts";
import { privateBucket } from "./buckets.ts";

export interface AppStackProps extends StackProps {
  config: ShapesConfig;
  vpc: ec2.IVpc;
  taskSubnets: ec2.SubnetSelection;
  assignPublicIp: boolean;
  db: rds.DatabaseInstance;
  dbSecurityGroup: ec2.ISecurityGroup;
  ownerSecret: secretsmanager.ISecret;
  appPasswordSecret: secretsmanager.ISecret;
}

/** Load balancer idle timeout; the app's KEEP_ALIVE_TIMEOUT (310 s) stays above it. */
export const ALB_IDLE_TIMEOUT_SECONDS = 300;
export const DEREGISTRATION_DELAY_SECONDS = 90;
export const HEALTH_CHECK_PATH = "/api/health/live";
const START = ["sh", "scripts/deploy/with-runtime-env.sh"];

export class AppStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly web: ecsPatterns.ApplicationLoadBalancedFargateService;
  readonly worker: ecs.FargateService;
  readonly migrateTask: ecs.FargateTaskDefinition;
  readonly filesBucket: s3.Bucket;
  readonly repositories: Record<"runner" | "worker" | "migrate", ecr.Repository>;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;
    const retention = logRetention(config.logRetentionDays);

    // --- registry ---------------------------------------------------------
    const repo = (name: string) =>
      new ecr.Repository(this, `Repo-${name}`, {
        repositoryName: `shapesos-${name}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE_WITH_EXCLUSION,
        imageTagMutabilityExclusionFilters: [ecr.ImageTagMutabilityExclusionFilter.wildcard("latest")],
        lifecycleRules: [{ description: "keep the last 100 images", maxImageCount: 100 }],
        removalPolicy: RemovalPolicy.RETAIN,
      });
    this.repositories = { runner: repo("runner"), worker: repo("worker"), migrate: repo("migrate") };

    // --- storage ----------------------------------------------------------
    this.filesBucket = privateBucket(this, "Files");

    // --- secrets ----------------------------------------------------------
    const plan = awsEnvPlan(config, { filesBucketName: this.filesBucket.bucketName });
    const groupSecret = (group: Group) =>
      new secretsmanager.Secret(this, `Env-${group}`, {
        secretName: `shapesos/${group}`,
        description: `ShapesOS ${group} settings: a JSON object of KEY: value (npm run secret-skeleton -- ${group}). Empty values are ignored.`,
        // Created with a random placeholder, never rewritten by later deploys:
        // the owner's values are safe across `cdk deploy`.
      });
    const blobs = { shared: groupSecret("shared"), web: groupSecret("web"), worker: groupSecret("worker") };
    const generated = new Map<string, { group: Group; secret: secretsmanager.Secret }>();
    for (const g of plan.generated) {
      generated.set(g.key, {
        group: g.group,
        secret: new secretsmanager.Secret(this, `Gen-${g.key}`, {
          secretName: `shapesos/generated/${g.key}`,
          description: `ShapesOS ${g.key} (generated once)`,
          generateSecretString: g.hex
            ? { passwordLength: 64, excludeUppercase: true, excludePunctuation: true, excludeCharacters: "ghijklmnopqrstuvwxyz" }
            : { passwordLength: 64, excludePunctuation: true },
        }),
      });
    }

    const dbEnv = {
      SHAPESOS_DB_HOST: props.db.dbInstanceEndpointAddress,
      SHAPESOS_DB_PORT: props.db.dbInstanceEndpointPort,
      SHAPESOS_DB_NAME: DB_NAME,
      APP_DB_USER: DB_APP_USER,
    };
    const secretsFor = (groups: Group[]): Record<string, ecs.Secret> => {
      const out: Record<string, ecs.Secret> = {
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appPasswordSecret),
      };
      for (const g of groups) out[`SHAPESOS_ENV_JSON_${g.toUpperCase()}`] = ecs.Secret.fromSecretsManager(blobs[g]);
      for (const [key, { group, secret }] of generated) if (groups.includes(group)) out[key] = ecs.Secret.fromSecretsManager(secret);
      return out;
    };

    // --- cluster, logs, roles ----------------------------------------------
    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: "shapesos",
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `Logs-${name}`, {
        logGroupName: `/shapesos/${name}`,
        retention,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    // Task role: least privilege on the files bucket only (objects + list).
    const appTaskRole = new iam.Role(this, "AppTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "ShapesOS web and worker tasks: the files bucket, nothing else",
    });
    this.filesBucket.grantReadWrite(appTaskRole);
    this.filesBucket.grantDelete(appTaskRole);

    const image = (r: ecr.IRepository, tag = config.imageTag) => ecs.ContainerImage.fromEcrRepository(r, tag);

    // --- web -----------------------------------------------------------------
    const webTask = new ecs.FargateTaskDefinition(this, "WebTask", {
      cpu: 2048,
      memoryLimitMiB: 4096,
      taskRole: appTaskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    webTask.addContainer("web", {
      image: image(this.repositories.runner),
      command: [...START, "node", "server.js"],
      portMappings: [{ containerPort: 3000 }],
      environment: { ...plan.values.shared, ...plan.values.web, ...dbEnv, NODE_OPTIONS: "--max-old-space-size=3072", PORT: "3000" },
      secrets: secretsFor(["shared", "web"]),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "web", logGroup: logGroup("web") }),
      // SIGTERM → drain streams and requests; Fargate allows at most 120 s.
      stopTimeout: Duration.seconds(120),
    });

    // Internal: reachable only from inside the VPC — CloudFront's VPC origin
    // ENIs live there. No public listener, nothing to bypass the WAF with.
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc, description: "ShapesOS ALB: CloudFront VPC origin only", allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80), "CloudFront VPC origin (its ENIs are in this VPC)");
    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroup: albSg,
      idleTimeout: Duration.seconds(ALB_IDLE_TIMEOUT_SECONDS),
      dropInvalidHeaderFields: true,
      deletionProtection: true,
    });

    this.web = new ecsPatterns.ApplicationLoadBalancedFargateService(this, "Web", {
      cluster: this.cluster,
      serviceName: "shapesos-web",
      loadBalancer: this.alb,
      openListener: false,
      listenerPort: 80,
      taskDefinition: webTask,
      taskSubnets: props.taskSubnets,
      assignPublicIp: props.assignPublicIp,
      desiredCount: 2,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(90),
      circuitBreaker: { enable: true, rollback: true },
      enableExecuteCommand: false,
    });
    this.web.targetGroup.configureHealthCheck({
      path: HEALTH_CHECK_PATH,
      healthyHttpCodes: "200",
      interval: Duration.seconds(15),
      timeout: Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });
    this.web.targetGroup.setAttribute("deregistration_delay.timeout_seconds", String(DEREGISTRATION_DELAY_SECONDS));
    const scaling = this.web.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 6 });
    scaling.scaleOnCpuUtilization("Cpu", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(1),
    });

    // --- worker --------------------------------------------------------------
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole: appTaskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    workerTask.addContainer("worker", {
      image: image(this.repositories.worker),
      command: [...START, "node", "node_modules/tsx/dist/cli.mjs", "scripts/worker.mts"],
      environment: { ...plan.values.shared, ...plan.values.worker, ...dbEnv, NODE_OPTIONS: "--max-old-space-size=1536" },
      secrets: secretsFor(["shared", "worker"]),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup: logGroup("worker") }),
      stopTimeout: Duration.seconds(120),
    });
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc, description: "ShapesOS worker: no inbound", allowAllOutbound: true });
    this.worker = new ecs.FargateService(this, "Worker", {
      cluster: this.cluster,
      serviceName: "shapesos-worker",
      taskDefinition: workerTask,
      desiredCount: 1,
      vpcSubnets: props.taskSubnets,
      assignPublicIp: props.assignPublicIp,
      securityGroups: [workerSg],
      minHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
    });

    // --- migrate (one-off) ------------------------------------------------------
    this.migrateTask = new ecs.FargateTaskDefinition(this, "MigrateTask", {
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    this.migrateTask.addContainer("migrate", {
      image: image(this.repositories.migrate, config.migrateImageTag),
      // Composes the OWNER's DATABASE_URL, migrates, then creates/refreshes
      // the app role with APP_DB_PASSWORD (scripts/db/migrate.sh).
      command: [...START, "--owner", "sh", "scripts/db/migrate.sh"],
      environment: { ...dbEnv, PGSSLMODE: "require" },
      secrets: {
        SHAPESOS_DB_OWNER_USER: ecs.Secret.fromSecretsManager(props.ownerSecret, "username"),
        SHAPESOS_DB_OWNER_PASSWORD: ecs.Secret.fromSecretsManager(props.ownerSecret, "password"),
        APP_DB_PASSWORD: ecs.Secret.fromSecretsManager(props.appPasswordSecret),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "migrate", logGroup: logGroup("migrate") }),
    });
    const migrateSg = new ec2.SecurityGroup(this, "MigrateSg", { vpc, description: "ShapesOS migrate task: no inbound", allowAllOutbound: true });

    // --- database access ------------------------------------------------------------
    // Rules live in THIS stack (L1): addIngressRule would put them in the data
    // stack, which would then depend on this one — a cycle.
    for (const [name, sg] of [
      ["Web", this.web.service.connections.securityGroups[0]!],
      ["Worker", workerSg],
      ["Migrate", migrateSg],
    ] as const) {
      new ec2.CfnSecurityGroupIngress(this, `DbFrom${name}`, {
        groupId: props.dbSecurityGroup.securityGroupId,
        sourceSecurityGroupId: sg.securityGroupId,
        ipProtocol: "tcp",
        fromPort: 5432,
        toPort: 5432,
        description: `ShapesOS ${name.toLowerCase()} to Postgres`,
      });
    }

    // For the release workflow / runbook (aws ecs run-task needs these).
    this.exportValue(migrateSg.securityGroupId, { name: "ShapesOS-MigrateSecurityGroup" });
    this.exportValue(this.migrateTask.taskDefinitionArn, { name: "ShapesOS-MigrateTaskDefinition" });
  }
}
