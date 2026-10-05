#!/bin/sh
# ShapesOS — database backup (Phase 4a). See docs/ops/BACKUP-RESTORE.md.
#
#   sh scripts/ops/backup.sh            one backup, then prune old ones
#   sh scripts/ops/backup.sh --loop     forever: back up every BACKUP_INTERVAL_SECONDS
#                                       (the compose `backup` service runs this)
#
# What it does:
#   1. pg_dump --format=custom into BACKUP_DIR as
#      shapesos-<db>-<UTC yyyymmddThhmmssZ>.dump (written to a temp name, then
#      renamed, so a half-written file never looks like a backup)
#   2. checks the archive reads back (pg_restore --list) and writes a
#      .sha256 next to it
#   3. uploads both to S3 / MinIO when BACKUP_S3_BUCKET is set (curl SigV4,
#      no AWS CLI needed)
#   4. deletes local backups older than BACKUP_RETENTION_DAYS
#
# Environment:
#   BACKUP_DATABASE_URL    connection to dump, as the schema OWNER (the
#                          migrator / POSTGRES_USER). Falls back to DATABASE_URL.
#                          NOT the runtime app role: its tables are FORCE ROW
#                          LEVEL SECURITY, and pg_dump refuses to dump rows
#                          a policy would hide.
#   BACKUP_DIR             default ./backups
#   BACKUP_RETENTION_DAYS  default 14 (0 keeps everything)
#   BACKUP_INTERVAL_SECONDS  --loop only, default 86400 (daily)
#   BACKUP_S3_BUCKET       optional; enables upload
#   BACKUP_S3_ENDPOINT     e.g. https://s3.us-east-1.amazonaws.com or http://minio:9000
#   BACKUP_S3_REGION       default us-east-1
#   BACKUP_S3_PREFIX       default backups/
#   BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY
#
# Exit status is non-zero when the dump, the check or a configured upload
# fails, so cron / the compose service log shows it.
set -eu

DB_URL="${BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_RETENTION_DAYS:-14}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

log() {
  # One JSON line per event, like the app's structured logs. No secrets.
  printf '{"ts":"%s","level":"%s","msg":"%s","service":"shapesos-backup"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${3:-}"
}

fail() {
  log error "$1"
  exit 1
}

backup_once() {
  [ -n "$DB_URL" ] || fail "BACKUP_DATABASE_URL (or DATABASE_URL) is not set"
  case "$KEEP_DAYS" in '' | *[!0-9]*) fail "BACKUP_RETENTION_DAYS must be a whole number" ;; esac
  # libpq rejects Prisma's ?schema= parameter.
  url="${DB_URL%%\?*}"
  db="$(printf '%s' "$url" | sed -e 's#.*/##')"
  [ -n "$db" ] || db="postgres"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$DIR"
  name="shapesos-${db}-${stamp}.dump"
  final="$DIR/$name"
  tmp="$DIR/.${name}.partial"
  trap 'rm -f "$tmp"' EXIT INT TERM

  started=$(date +%s)
  if ! pg_dump --format=custom --compress=6 --no-password --file="$tmp" "$url"; then
    fail "pg_dump failed"
  fi
  # The archive must read back before it counts as a backup.
  if ! pg_restore --list "$tmp" >/dev/null; then
    fail "backup archive does not read back"
  fi
  mv "$tmp" "$final"
  trap - EXIT INT TERM
  (cd "$DIR" && sha256sum "$name" >"$name.sha256")
  bytes=$(wc -c <"$final" | tr -d ' ')
  log info "backup written" ",\"file\":\"$name\",\"bytes\":$bytes,\"seconds\":$(($(date +%s) - started))"

  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    upload "$final" "$name"
    upload "$final.sha256" "$name.sha256"
  fi

  if [ "$KEEP_DAYS" -gt 0 ]; then
    # -mtime +N: older than N whole days.
    pruned=$(find "$DIR" -maxdepth 1 -type f \( -name 'shapesos-*.dump' -o -name 'shapesos-*.dump.sha256' \) -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
    log info "retention applied" ",\"keepDays\":$KEEP_DAYS,\"deleted\":$pruned"
  fi
}

upload() {
  file="$1"
  key="${BACKUP_S3_PREFIX:-backups/}$2"
  endpoint="${BACKUP_S3_ENDPOINT:-https://s3.${BACKUP_S3_REGION:-us-east-1}.amazonaws.com}"
  [ -n "${BACKUP_S3_ACCESS_KEY:-}" ] && [ -n "${BACKUP_S3_SECRET_KEY:-}" ] ||
    fail "BACKUP_S3_BUCKET is set but BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY are not"
  command -v curl >/dev/null 2>&1 || fail "curl is needed for the S3 upload"
  # Path-style URL (works for AWS S3 and MinIO). The secret goes to curl on
  # stdin (a config line), never on the command line where ps could see it.
  if ! printf 'user = "%s:%s"\n' "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" |
    curl --fail --silent --show-error --config - \
      --aws-sigv4 "aws:amz:${BACKUP_S3_REGION:-us-east-1}:s3" \
      --upload-file "$file" "${endpoint%/}/${BACKUP_S3_BUCKET}/${key}" >/dev/null; then
    fail "upload to s3://${BACKUP_S3_BUCKET}/${key} failed"
  fi
  log info "backup uploaded" ",\"bucket\":\"${BACKUP_S3_BUCKET}\",\"key\":\"${key}\""
}

if [ "${1:-}" = "--loop" ]; then
  case "$INTERVAL" in '' | *[!0-9]*) fail "BACKUP_INTERVAL_SECONDS must be a whole number" ;; esac
  while true; do
    # A failed run is logged and retried next interval; the loop keeps going.
    (backup_once) || log error "backup run failed; retrying next interval"
    sleep "$INTERVAL"
  done
else
  backup_once
fi
