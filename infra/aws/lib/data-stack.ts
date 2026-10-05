// Data: RDS for PostgreSQL 16, Multi-AZ, in the isolated subnets.
// db.m7g.large (2 vCPU / 8 GiB, Graviton), gp3 50 GB growing to 500 GB,
// encrypted with a customer-managed KMS key, 35 days of automated backups
// (the RDS maximum), TLS required (rds.force_ssl=1), deletion protection, and
// a final snapshot if the stack is ever deleted. RDS PostgreSQL 16 ships the
// extensions the migrations create — vector (pgvector 0.8.2), btree_gist,
// pg_trgm, pgcrypto
// (https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html).
// No RDS Proxy: per-transaction SET LOCAL for row-level security pins every
// connection, so a proxy adds cost and nothing else (plan, "AWS choices").
//
// The master user (shapesos_owner) owns the schema and is used ONLY by the
// migrate task. It is not a superuser on RDS, which scripts/db/
// create-app-role.sql handles; the app connects as shapesos_app.

import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import type { ShapesConfig } from "./config.ts";
import { logRetention } from "./retention.ts";

export interface DataStackProps extends StackProps {
  config: ShapesConfig;
  vpc: ec2.IVpc;
}

export const DB_NAME = "shapesos";
export const DB_OWNER = "shapesos_owner";
export const DB_APP_USER = "shapesos_app";

export class DataStack extends Stack {
  readonly db: rds.DatabaseInstance;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  /** Master (owner) credentials: host, port, username, password, dbname. */
  readonly ownerSecret: secretsmanager.ISecret;
  /** The app role's password (created by the migrate task). */
  readonly appPasswordSecret: secretsmanager.Secret;
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, vpc } = props;

    this.key = new kms.Key(this, "DataKey", {
      description: "ShapesOS database storage and Performance Insights encryption",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc,
      description: "ShapesOS Postgres: only the ShapesOS tasks may connect",
      allowAllOutbound: false,
    });

    // Major version only: RDS picks the current 16.x and keeps it patched
    // (autoMinorVersionUpgrade), and CloudFormation matches "16" as a prefix
    // so auto-upgrades are not drift
    // (https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-rds-dbinstance.html).
    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 });
    const parameterGroup = new rds.ParameterGroup(this, "Params", {
      engine,
      description: "ShapesOS: TLS required",
      parameters: { "rds.force_ssl": "1" },
    });

    this.db = new rds.DatabaseInstance(this, "Db", {
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.M7G, ec2.InstanceSize.LARGE),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      multiAz: true,
      databaseName: DB_NAME,
      // Secrets use Secrets Manager's AWS-managed key: a customer key here would
      // make the key policy name the ECS roles of another stack (a cycle while
      // the account is unknown at synth).
      credentials: rds.Credentials.fromGeneratedSecret(DB_OWNER, { excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\" }),
      storageType: rds.StorageType.GP3,
      allocatedStorage: 50,
      maxAllocatedStorage: 500,
      storageEncrypted: true,
      storageEncryptionKey: this.key,
      parameterGroup,
      backupRetention: Duration.days(35),
      preferredBackupWindow: "06:00-06:30",
      preferredMaintenanceWindow: "sun:07:00-sun:07:30",
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      enablePerformanceInsights: true,
      performanceInsightEncryptionKey: this.key,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logRetention(config.logRetentionDays) as logs.RetentionDays,
      copyTagsToSnapshot: true,
      publiclyAccessible: false,
    });
    this.ownerSecret = this.db.secret!;

    this.appPasswordSecret = new secretsmanager.Secret(this, "AppDbPassword", {
      description: `ShapesOS: password of the ${DB_APP_USER} role (least privilege; created by the migrate task)`,
      // URL-safe: runtime-env.mjs percent-encodes anyway.
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
  }
}
