# ShapesOS on AWS

ShapesOS runs on Render today ([RENDER.md](RENDER.md)). This is the move to AWS: when to do it, what the CDK app in `infra/aws` builds, and the exact steps. The same images, the same env plan (`scripts/deploy/render-env.mjs`), the same migrations and the same start wrapper run on both, so the move is configuration, not code.

## When to move

Owner decision (2026-10-05): stay on Render until one of these happens.

1. The first deal that needs a HIPAA BAA, data residency or a private network (VPC).
2. A customer who needs a fixed outbound IP for their firewall allow-list (SFTP, WordPress).
3. The Render bill passes about $2,000 a month.

If a HIPAA or enterprise deal is expected within about 6 months, start on AWS instead.

## What the CDK app builds

`infra/aws` is its own package (AWS CDK v2, TypeScript). `npm test` asserts the important settings; CI (`ci` → `infra` job) runs it and `cdk synth` with no AWS credentials on every push, so it can't rot. Six stacks:

| Stack | Region | What's in it |
|---|---|---|
| `ShapesOS-Network` | app region | VPC on 2 Availability Zones: public subnets (tasks) and isolated subnets (database, internal load balancer). No NAT gateway; `-c natGateway=true` adds one and moves tasks to private subnets (a fixed outbound IP). S3 gateway endpoint. |
| `ShapesOS-Data` | app region | RDS for PostgreSQL 16, Multi-AZ, `db.m7g.large`, gp3 50 GB growing to 500 GB, customer-managed KMS key, 35-day backups, `rds.force_ssl=1`, deletion protection, final snapshot on delete, isolated subnets. Owner password in Secrets Manager; a generated password for the app role. pgvector 0.8.2, btree_gist, pg_trgm and pgcrypto are available on RDS PostgreSQL 16 ([extensions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html)). |
| `ShapesOS-App` | app region | ECR repositories (`shapesos-runner`, `-worker`, `-migrate`; scan on push; sha tags immutable). ECS cluster. Web on Fargate (2 vCPU / 4 GB, 2–6 tasks on CPU) behind an **internal** load balancer (idle timeout 300 s, deregistration delay 90 s, health check `/api/health/live`). Worker on Fargate (no load balancer). A migrate task definition. Private files bucket. Secrets Manager: `shapesos/shared`, `shapesos/web`, `shapesos/worker` (JSON, the keys you provide) and `shapesos/generated/*`. Log groups `/shapesos/*` with 30-day retention. |
| `ShapesOS-EdgeGlobal` | us-east-1 | ACM certificate for `<domain>` and `app.<domain>`; WAF web ACL (AWS IP reputation, common rule set, known bad inputs, and a rate limit of 100 requests per 5 minutes per IP on `/api/auth/*`). CloudFront only takes certificates and web ACLs from us-east-1. |
| `ShapesOS-Edge` | app region | CloudFront: a VPC origin to the internal load balancer (CloudFront reaches it privately; there is no public listener to get around the WAF), no caching for the app and API, `/_next/static/*` cached, `/updates/*` from the desktop-updates bucket (origin access control). |
| `ShapesOS-Ops` | app region | SNS topic, CloudWatch alarms (5xx, web/worker CPU, database CPU, connections and free storage), monthly AWS Budget at 80 % actual / 100 % forecast. |

Plus `infra/aws/bootstrap/bootstrap.yaml`: the GitHub OIDC provider and two roles (`shapesos-github-deploy`, `shapesos-github-plan`) that trust only `repo:Villain336/ShapesOS:environment:production` ([GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)). No long-lived AWS keys anywhere.

Why these choices (plan, "AWS choices"): ECS on Fargate (App Runner is closed to new customers; EKS is too much); RDS Multi-AZ, not Aurora Serverless (about 4 always-on ACUs cost more) and no RDS Proxy (per-transaction `SET LOCAL` for row-level security pins every connection); CDK, not Terraform (TypeScript like the app; CloudFormation keeps the state); no NAT at launch.

### Long-lived streams

CloudFront closes an origin connection that sends nothing for its read timeout: 60 s here (VPC origins allow up to 120 s by default). Every SSE stream sends a heartbeat at least every 15 s, the load balancer idles out after 300 s, and Next keeps connections alive for 310 s (`KEEP_ALIVE_TIMEOUT`), so the app never closes a connection the load balancer still uses. Tasks get 120 s after SIGTERM (the Fargate maximum) and the load balancer drains for 90 s. WebSockets pass through CloudFront without extra settings.

### Secrets and the start wrapper

- The values Render keeps in env groups are, on AWS, plain container environment (fixed values, rewritten for your domain) or Secrets Manager entries, all from the same table (`infra/aws/lib/env-plan.ts` reads `scripts/deploy/render-env.mjs`).
- The keys you provide live in three JSON secrets. `npm run secret-skeleton -- shared` (and `web`, `worker`) prints the JSON with every key empty; fill in what you use. Empty keys are skipped at start, so an unused feature stays unset. CloudFormation never writes these secrets after creating them, so `cdk deploy` can't overwrite your values.
- Each container starts with `sh scripts/deploy/with-runtime-env.sh …`, which exports the JSON keys and composes `DATABASE_URL` for `shapesos_app` from the RDS endpoint and the app-role secret. Only the migrate task gets the owner credentials (`--owner`).
- Files: the S3 adapter still takes static keys (`MARKETR_S3_ACCESS_KEY` / `_SECRET_KEY` in `shapesos/shared`). Until it reads the ECS task role, create an IAM user with access to the files bucket only and paste its keys. The task role and its bucket-only grant already exist for when it does.
- TLS to the database: `rds.force_ssl=1`. Prisma encrypts by default; node-postgres (Payload) gets `PGSSLMODE=no-verify`, which encrypts without checking the RDS certificate. To verify it too, add the RDS CA bundle to the images, set `NODE_EXTRA_CA_CERTS` to it and `PGSSLMODE=verify-full`.

## Costs (us-east-1, on demand; re-check in the AWS Pricing Calculator)

From the plan's research (2026-10-05): about **$520/month at launch** without a NAT gateway (RDS `db.m7g.large` Multi-AZ about $257 of it), **$1,500–1,900** at 3–4× load, **$1,100–1,400** with Savings Plans and an RDS reservation. On top: a NAT gateway (about $33/month plus data) only with `natGateway=true`; WAF ($5 per web ACL plus $1 per rule and request charges); Secrets Manager ($0.40 per secret per month, about 18 secrets); CloudFront data transfer. The HIPAA BAA is free in AWS Artifact; the logging and threat-detection services it expects cost about $30–100/month.

## Steps

### 1. Account (owner, about 10 minutes)

1. Create the AWS account (ideally an Organization with `prod` and `staging` accounts), MFA on the root user, an IAM Identity Center admin user. Stop using root.
2. Pick the region (`us-east-1` unless data residency says otherwise). For any region other than us-east-1 you also pass `-c account=<id>`: the certificate and WAF stay in us-east-1 and are referenced across regions.
3. Check that neither Availability Zone you'll use is `use1-az3` in us-east-1: CloudFront VPC origins don't support it ([VPC origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html)). In CloudShell: `aws ec2 describe-availability-zones --query 'AvailabilityZones[].[ZoneName,ZoneId]'`, then pass two good ones as `-c availabilityZones=us-east-1a,us-east-1b`.

### 2. Bootstrap from CloudShell (owner, about 10 minutes)

```sh
# Upload infra/aws/bootstrap/bootstrap.yaml to CloudShell (Actions → Upload file), then:
aws cloudformation deploy --template-file bootstrap.yaml \
  --stack-name shapesos-github-oidc --capabilities CAPABILITY_NAMED_IAM
# The account already has GitHub's OIDC provider? Add:
#   --parameter-overrides ExistingOidcProviderArn=arn:aws:iam::<id>:oidc-provider/token.actions.githubusercontent.com
aws cloudformation describe-stacks --stack-name shapesos-github-oidc \
  --query 'Stacks[0].Outputs' --output table          # the two role ARNs

npx aws-cdk@2 bootstrap aws://<ACCOUNT_ID>/us-east-1
npx aws-cdk@2 bootstrap aws://<ACCOUNT_ID>/<APP_REGION>  # if not us-east-1
```

### 3. GitHub variables

Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
|---|---|
| `AWS_DEPLOY_ENABLED` | `true` (until then `infra.yml` only checks) |
| `AWS_REGION` | the app region |
| `AWS_ACCOUNT_ID` | the 12-digit id |
| `AWS_DEPLOY_ROLE_ARN` / `AWS_PLAN_ROLE_ARN` | from step 2 |
| `AWS_DOMAIN` | `shapesos.com` |
| `AWS_HOSTED_ZONE_ID` | the Route 53 zone of the domain (optional: with it, certificates validate and DNS aliases are created automatically) |
| `AWS_ALARM_EMAIL` | where alarms and budget alerts go |

Both roles only trust jobs in the `production` environment, so `infra.yml`'s diff and deploy jobs wait for your approval.

### 4. Deploy the infrastructure

Actions → infra → Run workflow, deploy checked (or push a change under `infra/aws` to `main`). Locally instead, with admin credentials:

```sh
cd infra/aws && npm ci
npx cdk diff --all -c region=us-east-1 -c domain=shapesos.com
npx cdk deploy --all -c region=us-east-1 -c domain=shapesos.com -c alarmEmail=you@example.com
```

Without `hostedZoneId`, ACM waits for the certificate's DNS records: ACM console → the certificate → add the two CNAMEs it shows to your DNS. Confirm the SNS subscription email.

The services start once images exist (step 5) and the settings are filled (step 6); until then ECS keeps retrying.

### 5. Images

The release workflow builds for GHCR. For ECR, build the same targets and push them with the git sha:

```sh
REG=<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin "$REG"
SHA=$(git rev-parse HEAD)
REGISTRY=$REG TAG=$SHA GIT_COMMIT=$SHA APP_URL=https://app.shapesos.com \
  docker buildx bake -f docker-bake.hcl runner worker migrate --push \
  --set '*.cache-from=' --set '*.cache-to='
```

(`docker-bake.hcl` names images `<REGISTRY>/shapesos-<target>:<TAG>`, which matches the ECR repositories.) A GitHub job for this uses the deploy role, which may push to `shapesos-*` repositories.

### 6. Settings

1. `npm run secret-skeleton -- shared` → Secrets Manager → `shapesos/shared` → Retrieve secret value → Edit → Plaintext → paste the JSON with your values. Same for `web` and `worker`. The keys and where each comes from are the "Values you paste" lists in [RENDER.md](RENDER.md) step 7 and [KEYS.md](../KEYS.md).
2. Coming from Render: copy `MARKETR_CREDENTIALS_KEY` from the Render env group into `shapesos/generated/MARKETR_CREDENTIALS_KEY` (otherwise stored connector credentials can't be decrypted). Copy `AUTH_SECRET` too, so sessions survive the move.

### 7. Release: migrate first, then the services

```sh
cd infra/aws
CTX="-c region=$REGION -c account=$ACCOUNT -c domain=shapesos.com"
# 1. Point only the migrate task at the new images, and run it.
npx cdk deploy ShapesOS-App $CTX -c imageTag=$CURRENT_SHA -c migrateImageTag=$SHA
TASKDEF=$(aws cloudformation list-exports --query "Exports[?Name=='ShapesOS-MigrateTaskDefinition'].Value" --output text)
SG=$(aws cloudformation list-exports --query "Exports[?Name=='ShapesOS-MigrateSecurityGroup'].Value" --output text)
SUBNETS=<the two public subnet ids, or private ones with natGateway=true>
ARN=$(aws ecs run-task --cluster shapesos --launch-type FARGATE --task-definition "$TASKDEF" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster shapesos --tasks "$ARN"
aws ecs describe-tasks --cluster shapesos --tasks "$ARN" --query 'tasks[0].containers[0].exitCode'   # must be 0
# 2. Then roll web and worker (ECS rolls back by itself if new tasks fail: circuit breaker).
npx cdk deploy ShapesOS-App $CTX -c imageTag=$SHA -c migrateImageTag=$SHA
curl -fsS https://app.shapesos.com/api/health
```

Logs: CloudWatch → `/shapesos/migrate`, `/shapesos/web`, `/shapesos/worker`.

### 8. Move the database from Render

Two ways; both need the same `MARKETR_CREDENTIALS_KEY` on the new side.

**A. Export and restore (short downtime, simplest).**

1. Put the app in maintenance (Render: shapesos-web → Settings → Maintenance mode) so nothing writes.
2. Render → shapesos-db → Recovery → Create export; download it.
3. Restore into RDS as the owner from a host that can reach it (a one-off Fargate task, or CloudShell in the VPC): `pg_restore --no-owner --no-privileges --format=directory …` as in [BACKUP-RESTORE.md](../ops/BACKUP-RESTORE.md).
4. Run the migrate task (step 7.1): it applies anything newer and creates the app role and grants.
5. Switch DNS (step 9). Check counts, sign in, open a connector with stored credentials.

**B. Logical replication (minutes of downtime).** Render enables it on request, on a Pro workspace with at least 10 GB of storage; `CREATE PUBLICATION … FOR ALL TABLES` needs a superuser, so Render support runs it ([logical replication](https://render.com/docs/postgresql-logical-replication)).

1. Ask Render support (from the dashboard) to enable logical replication on `shapesos-db`, publish all tables of schemas `public` and `payload`, and create a replication role **with BYPASSRLS**: the initial table copy reads every row, and the tenant tables are `FORCE ROW LEVEL SECURITY`.
2. On RDS: run the migrate task once (schema, extensions, roles), then turn row-level security off on the tenant tables for the copy (nothing serves from RDS yet). As the owner:
   ```sql
   SELECT format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY;', schemaname, tablename)
   FROM pg_tables WHERE schemaname = 'public' AND rowsecurity \gexec
   ```
   Keep that list: you turn it back on in step 5.
3. `CREATE SUBSCRIPTION shapesos_move CONNECTION 'host=<render external host> port=5432 dbname=shapesos user=<role> password=… sslmode=require' PUBLICATION <name>;` (add the RDS NAT/egress address to the Render database's allow list first — with no NAT, run it from a task with a public IP and allow that IP).
4. Wait until `pg_stat_subscription` shows the copy done and lag near zero. Maintenance mode on Render; wait for lag 0; `ALTER SUBSCRIPTION shapesos_move DISABLE; DROP SUBSCRIPTION shapesos_move;`; reset sequences (`SELECT setval(...)` from the max ids — logical replication doesn't carry sequence values).
5. Turn row-level security back on for exactly the tables from step 2 (`ENABLE` + `FORCE`), run the migrate task again (grants), switch DNS.

### 9. DNS cutover

- With Route 53 (`hostedZoneId`): the edge stack already created `A` aliases for `<domain>` and `app.<domain>` to CloudFront. Move the domain's nameservers to Route 53 (registrar), or keep Cloudflare DNS and point `@` and `app` at the distribution domain name (`dxxxx.cloudfront.net`; Cloudflare flattens the apex CNAME), DNS only.
- Lower the TTLs a day before. Keep Render running until traffic on it stops, then scale it to zero.
- Tenant custom domains CNAME to `domains.shapesos.com`: point that name at CloudFront and add tenant domains with CloudFront SaaS Manager (multi-tenant distribution). Customers change nothing.
- OAuth callbacks stay on `https://app.shapesos.com/...`; nothing to re-register.

### 10. After the move

- `TRUSTED_PROXY_HOPS` is 2 on AWS too (CloudFront, then the load balancer). Verify it the same way as on Render (RENDER.md step 9.6).
- Backups: RDS keeps 35 days of automated backups with point-in-time restore. For long-term copies use manual snapshots or AWS Backup. The R2 job doesn't apply here, and a `pg_dump` as the master user only works if it has `BYPASSRLS` (`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user;`): the master user is not a superuser on RDS, and `pg_dump` stops at the first `FORCE ROW LEVEL SECURITY` table otherwise.
- HIPAA: accept the BAA in AWS Artifact, use only HIPAA-eligible services for PHI (all of the above are), turn on CloudTrail, GuardDuty and Config, and sign BAAs/DPAs with providers that touch personal data.

## What is verified, and what isn't

- Verified here: `cdk synth` without credentials; 35 assertion tests (`infra/aws/test`); cfn-lint 1.57.1 on every template (no errors; one false-positive warning: it flags `EngineVersion: "16"`, which AWS documents as a valid major-version prefix); the bootstrap template's trust policy.
- Not verified (no AWS account here): the first `cdk deploy`, VPC-origin creation in the chosen zones, certificate validation, the migrate task against RDS, the database move, and the costs.
