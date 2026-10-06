# Backup and restore

ShapesOS keeps everything that matters in Postgres: workspaces, content, contacts, the usage ledger, the encrypted credential vault and the audit trails. Uploaded files live in the bundled MinIO's `marketr-minio` volume by default (`MARKETR_STORAGE=s3`), or in your own S3 bucket, or in the `marketr-data` volume with `MARKETR_STORAGE=local`. Other on-disk state (report PDFs, logos, site working copies) is in `marketr-data`, agent run recordings in `marketr-run-artifacts` and the knowledge corpus in `marketr-corpus`. Those need their own snapshot or bucket versioning. This page covers the database (it also holds the `rate_limit_buckets` counters, which need no backup).

## What runs

`scripts/ops/backup.sh` does one backup per run:

1. `pg_dump --format=custom` writes `shapesos-<db>-<yyyymmddThhmmssZ>.dump` into `BACKUP_DIR`. It writes to a hidden `.partial` file first and renames it, so a half-written dump never looks like a backup.
2. `pg_restore --list` reads the archive back. If that fails, the run fails. It then writes a `.sha256` next to the dump.
3. If `BACKUP_S3_BUCKET` is set, it uploads the dump and its checksum to S3 or MinIO. It signs the upload with curl `--aws-sigv4`, so no AWS CLI is needed, and passes the secret to curl on stdin, not on the command line.
4. It deletes local dumps older than `BACKUP_RETENTION_DAYS`.

Each step logs one JSON line, in the same shape as the app's structured logs. A failed dump, check or upload exits non-zero.

### With Docker Compose (default)

The `backup` service in `docker-compose.yml` runs `backup.sh --loop`:

- It takes one backup every `BACKUP_INTERVAL_SECONDS` (default `86400`, so daily).
- It keeps the files in the `marketr-backups` volume.
- It starts after `migrate` succeeds.

A failed run is logged and retried at the next interval.

```sh
docker compose logs backup                      # what ran
docker compose exec backup ls -l /backups       # what's there
docker compose exec backup shapesos-backup      # take one now
```

### Without Compose (host cron)

```cron
15 3 * * * BACKUP_DATABASE_URL=postgresql://marketr:…@127.0.0.1:5432/marketr BACKUP_DIR=/var/backups/shapesos /opt/shapesos/scripts/ops/backup.sh >> /var/log/shapesos-backup.log 2>&1
```

The host needs `pg_dump` / `pg_restore` at the server's major version (16), and `curl` if you upload.

### On Render (hosted)

Render's database owner is not a superuser and has no `BYPASSRLS`, so `pg_dump` as that user stops at the first `FORCE ROW LEVEL SECURITY` table ("query would be affected by row-level security policy" — reproduced with a non-superuser owner on PostgreSQL 16). The hosted setup therefore uses three layers (docs/deploy/RENDER.md §12):

1. Render's point-in-time recovery (last 7 days on a Pro workspace).
2. Render's logical exports (kept 7 days).
3. The `shapesos-backup` cron job (`render.yaml`, daily 03:17 UTC) runs `shapesos-backup` with `BACKUP_SOURCE=render-export`: it asks Render for an export (`POST /v1/postgres/{id}/export`), waits for its download URL, downloads it, checks it unpacks (`tar -tzf`), writes a `.sha256`, and uploads both to `BACKUP_S3_BUCKET` (Cloudflare R2, region `auto`) with the same SigV4 upload. The Render API key goes to curl on stdin and is never sent to the download URL.

On AWS (docs/deploy/AWS.md), RDS keeps 35 days of automated backups with point-in-time restore; take snapshots for longer retention.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKUP_DATABASE_URL` | `DATABASE_URL` | The database to dump, **as the schema owner** (the migrator / `POSTGRES_USER`). |
| `BACKUP_DIR` | `./backups` (`/backups` in compose) | Where dumps go. |
| `BACKUP_RETENTION_DAYS` | `14` | Local dumps older than this are deleted. `0` keeps everything. |
| `BACKUP_INTERVAL_SECONDS` | `86400` | Time between runs, `--loop` only. |
| `BACKUP_S3_BUCKET` | (unset) | Turns the upload on. |
| `BACKUP_S3_ENDPOINT` | `https://s3.<region>.amazonaws.com` | Use `http://minio:9000` for the bundled MinIO. |
| `BACKUP_S3_REGION` | `us-east-1` | SigV4 region. |
| `BACKUP_S3_PREFIX` | `backups/` | Key prefix. |
| `BACKUP_S3_ACCESS_KEY` / `BACKUP_S3_SECRET_KEY` | (unset) | Required when the bucket is set. |
| `BACKUP_SOURCE` | `pg_dump` | `render-export`: copy Render's own export instead of running `pg_dump`. |
| `RENDER_API_KEY` / `RENDER_POSTGRES_ID` | (unset) | `render-export` only: an API key and the database id (`dpg-…`). |
| `BACKUP_EXPORT_TIMEOUT_SECONDS` / `BACKUP_EXPORT_POLL_SECONDS` | `3600` / `15` | `render-export` only: how long to wait for the export, and how often to look. |

**Why the schema owner?** The runtime app role (`marketr_app`) is subject to `FORCE ROW LEVEL SECURITY` on the tenant tables. `pg_dump` refuses to dump rows that a policy would hide, rather than silently skipping them. Only the owner or superuser sees every tenant.

**Remote retention:** the script prunes local copies only. Set a lifecycle rule on the bucket to expire objects (for example, 35 days) and turn on bucket versioning or object lock if you need protection against deletion.

**Encryption:** dumps contain the credential vault in its encrypted form (envelope-encrypted with `MARKETR_CREDENTIALS_KEY`, or AWS KMS when `SECRETS_PROVIDER=aws-kms`), plus everything else in plain form. Keep the backup volume and bucket private. Use server-side encryption on the bucket. Store `MARKETR_CREDENTIALS_KEY` somewhere other than the backups: a restore without it keeps every row, but stored credentials can't be decrypted.

## Restore

Restore into an **empty** database. Never restore over a live one.

```sh
# 0. Pick the dump and check it.
cd /path/to/backups
sha256sum -c shapesos-marketr-20261005T031500Z.dump.sha256
pg_restore --list shapesos-marketr-20261005T031500Z.dump > /dev/null

# 1. Stop writers so nothing lands in the old database mid-restore.
docker compose stop app backup

# 2. Create the target database (as the superuser / POSTGRES_USER).
psql "postgresql://marketr:…@db:5432/postgres" -c 'CREATE DATABASE marketr_restored'

# 3. Restore. --no-owner/--no-acl: the restoring superuser owns everything,
#    and grants are recreated in step 4 (the dump's grants name roles that
#    may not exist on a new server).
pg_restore --exit-on-error --no-owner --no-acl \
  --dbname="postgresql://marketr:…@db:5432/marketr_restored" \
  shapesos-marketr-20261005T031500Z.dump

# 4. Recreate the least-privilege runtime role's grants. migrate.sh does this
#    when APP_DB_PASSWORD is set, and also applies any migrations newer than
#    the dump.
DATABASE_URL="postgresql://marketr:…@db:5432/marketr_restored" APP_DB_PASSWORD=… sh scripts/db/migrate.sh

# 5. Point the app at the restored database (POSTGRES_DB=marketr_restored in
#    .env, or rename the databases while the app is stopped), start it, and
#    check readiness:
docker compose up -d app backup
curl -fsS http://127.0.0.1:3000/api/health   # expect {"status":"ok", …}
```

To swap names instead of changing `POSTGRES_DB`, run this while nothing is connected:

```sql
ALTER DATABASE marketr RENAME TO marketr_before_restore;
ALTER DATABASE marketr_restored RENAME TO marketr;
```

Keep `marketr_before_restore` until you've checked the restored data.

### Restoring a Render export

A Render export (from R2 `shapesos-backups/render/`, or downloaded from the dashboard) is a `.dir.tar.gz` of `pg_dump`'s directory format:

```sh
sha256sum -c shapesos-render-dpg-xxxx-20261006T031700Z.dir.tar.gz.sha256
mkdir restore && tar -xzf shapesos-render-dpg-xxxx-20261006T031700Z.dir.tar.gz -C restore
ls restore/*/                       # the database directory: toc.dat + data files
psql "postgresql://…/postgres" -c 'CREATE DATABASE shapesos_restored'
pg_restore --exit-on-error --no-owner --no-acl --format=directory \
  --dbname="postgresql://…/shapesos_restored" restore/<timestamp>/<database>
DATABASE_URL="postgresql://…/shapesos_restored" APP_DB_USER=shapesos_app APP_DB_PASSWORD=… sh scripts/db/migrate.sh
```

Restore as a user that can create the extensions and bypass row-level security while loading (a superuser locally; on Render, restore into a new database through point-in-time recovery instead — it needs no `pg_restore`). Render documents the same `pg_restore` flags ([backups](https://render.com/docs/postgresql-backups)).

### Checks after a restore

- `GET /api/health` returns 200, with `checks.migrations.pending` and `checks.migrations.failed` both 0.
- `node scripts/ci/check-schema-drift.mjs`, with `DATABASE_URL` set to the restored database as the owner, prints OK.
- Row counts on a few key tables match what you expect: `workspaces`, `workspace_members`, `usage_events`.
- Sign in, open a workspace, and open a connector that has stored credentials. This proves `MARKETR_CREDENTIALS_KEY` matches the dump.

## Restore drill (recorded)

Run on 2026-10-03 against the scratch database `p4_ops`, migrated to `20261005100000_phase4a_workspace_orphan_fks` (145 migrations), on Postgres 16.14:

1. `BACKUP_DATABASE_URL=postgresql://marketr:…@localhost:5432/p4_ops?schema=public BACKUP_RETENTION_DAYS=14 sh scripts/ops/backup.sh`
   - It wrote `shapesos-p4_ops-20261003T205051Z.dump` (1,332,700 bytes) in about 1 s. The `?schema=` parameter was stripped, as it should be.
   - Retention deleted two planted files dated 20 days back (`deleted: 2`) and kept the new one.
2. `sha256sum -c *.sha256` reported OK.
3. `CREATE DATABASE p4_ops_restore`, then `pg_restore --exit-on-error --no-owner --no-acl --dbname=…/p4_ops_restore <dump>` exited 0 in 2.9 s.
4. `scripts/db/create-app-role.sql` re-granted the least-privilege role.
5. The source and the restore matched exactly:

   | | migrations | workspaces | members | mcp_api_keys | RLS policies | FORCE-RLS tables | foreign keys | triggers |
   | --- | --- | --- | --- | --- | --- | --- | --- | --- |
   | p4_ops | 145 | 1 | 1 | 1 | 78 | 75 | 631 | 1 |
   | p4_ops_restore | 145 | 1 | 1 | 1 | 78 | 75 | 631 | 1 |

6. Checks on the restored database:
   - `check-schema-drift.mjs` reported OK.
   - `workspace-orphans-db.test.ts`, run as the non-superuser app role, passed 4/4. The restored RLS, grants, foreign keys and the append-only trigger all work.
   - The app role is `rolsuper = f` and reads the drill workspace.
7. Upload path: the backup ran with `BACKUP_S3_BUCKET=drill` against a local mock endpoint.
   - It sent two `PUT /drill/backups/<file>` requests (the dump and the `.sha256`).
   - Both were signed with `AWS4-HMAC-SHA256` and `x-amz-content-sha256: UNSIGNED-PAYLOAD`.
   - **Not yet verified against a real S3 or MinIO endpoint, which checks the signature.** Run one upload against your bucket before you rely on it.

Repeat the drill after major upgrades and at least once a quarter. A backup that has never been restored isn't a backup.
