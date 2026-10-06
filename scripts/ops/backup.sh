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
# Hosted on Render (BACKUP_SOURCE=render-export, the shapesos-backup cron job
# in render.yaml): Render's database owner is not a superuser and has no
# BYPASSRLS, so pg_dump as that user stops at the first FORCE ROW LEVEL
# SECURITY table ("query would be affected by row-level security policy").
# Instead this asks Render for a logical export of the whole database
# (POST /v1/postgres/{id}/export, https://render.com/docs/postgresql-backups),
# waits for it, downloads it, checks it unpacks, and uploads it with the same
# S3 upload as below (e.g. to a Cloudflare R2 bucket; region "auto").
#   BACKUP_SOURCE           pg_dump (default) | render-export
#   RENDER_API_KEY          render-export: a Render API key (sent on stdin to curl)
#   RENDER_POSTGRES_ID      render-export: the database id (dpg-…)
#   BACKUP_EXPORT_TIMEOUT_SECONDS  render-export: how long to wait (default 3600)
#   BACKUP_EXPORT_POLL_SECONDS     render-export: poll interval (default 15)
#   RENDER_API_BASE         tests only (default https://api.render.com/v1)
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
    pruned=$(find "$DIR" -maxdepth 1 -type f \( -name 'shapesos-*.dump' -o -name 'shapesos-*.dump.sha256' -o -name 'shapesos-*.dir.tar.gz' -o -name 'shapesos-*.dir.tar.gz.sha256' \) -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
    log info "retention applied" ",\"keepDays\":$KEEP_DAYS,\"deleted\":$pruned"
  fi
}

# Render API call: the key goes to curl on stdin (a config line), never argv.
render_api() {
  method="$1"
  path="$2"
  printf 'header = "Authorization: Bearer %s"\n' "$RENDER_API_KEY" |
    curl --fail --silent --show-error --config - -X "$method" \
      -H 'Accept: application/json' "${RENDER_API_BASE:-https://api.render.com/v1}${path}"
}

# Export ids from a List Postgres exports response (an array of exports, or of
# {cursor, <export>} wrappers like Render's other list endpoints).
export_rows() {
  jq -r '.[] | (if has("id") then . else ([.[] | objects | select(has("id"))][0] // {}) end)
         | select(.id != null) | [.id, (.url // "")] | @tsv'
}

render_export_once() {
  [ -n "${RENDER_API_KEY:-}" ] || fail "BACKUP_SOURCE=render-export needs RENDER_API_KEY"
  [ -n "${RENDER_POSTGRES_ID:-}" ] || fail "BACKUP_SOURCE=render-export needs RENDER_POSTGRES_ID"
  command -v jq >/dev/null 2>&1 || fail "jq is needed for BACKUP_SOURCE=render-export"
  case "$KEEP_DAYS" in '' | *[!0-9]*) fail "BACKUP_RETENTION_DAYS must be a whole number" ;; esac
  timeout_s="${BACKUP_EXPORT_TIMEOUT_SECONDS:-3600}"
  case "$timeout_s" in '' | *[!0-9]*) fail "BACKUP_EXPORT_TIMEOUT_SECONDS must be a whole number" ;; esac
  path="/postgres/${RENDER_POSTGRES_ID}/export"
  # Capture first: in a pipeline the curl status would be lost (no pipefail in sh).
  json="$(render_api GET "$path")" || fail "listing Render exports failed"
  before="$(printf '%s' "$json" | export_rows | cut -f1)" || fail "unexpected Render export list"
  render_api POST "$path" >/dev/null || fail "starting a Render export failed"
  started=$(date +%s)
  log info "render export requested" ",\"postgres\":\"${RENDER_POSTGRES_ID}\""
  url=""
  while [ -z "$url" ]; do
    if [ $(($(date +%s) - started)) -ge "$timeout_s" ]; then
      fail "the Render export did not finish within ${timeout_s}s"
    fi
    sleep "${BACKUP_EXPORT_POLL_SECONDS:-15}"
    json="$(render_api GET "$path")" || fail "listing Render exports failed"
    rows="$(printf '%s' "$json" | export_rows)" || fail "unexpected Render export list"
    url="$(printf '%s\n' "$rows" | while IFS="$(printf '\t')" read -r id u; do
      [ -n "$id" ] || continue
      if ! printf '%s\n' "$before" | grep -qx "$id" && [ -n "$u" ]; then printf '%s' "$u"; break; fi
    done)"
  done
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$DIR"
  name="shapesos-render-${RENDER_POSTGRES_ID}-${stamp}.dir.tar.gz"
  final="$DIR/$name"
  tmp="$DIR/.${name}.partial"
  trap 'rm -f "$tmp"' EXIT INT TERM
  # The export URL carries its own authorization; the API key is not sent.
  curl --fail --silent --show-error --location -o "$tmp" "$url" || fail "downloading the Render export failed"
  tar -tzf "$tmp" >/dev/null 2>&1 || fail "the Render export does not unpack"
  mv "$tmp" "$final"
  trap - EXIT INT TERM
  (cd "$DIR" && sha256sum "$name" >"$name.sha256")
  bytes=$(wc -c <"$final" | tr -d ' ')
  log info "backup written" ",\"file\":\"$name\",\"bytes\":$bytes,\"seconds\":$(($(date +%s) - started)),\"source\":\"render-export\""
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    upload "$final" "$name"
    upload "$final.sha256" "$name.sha256"
  fi
  if [ "$KEEP_DAYS" -gt 0 ]; then
    pruned=$(find "$DIR" -maxdepth 1 -type f \( -name 'shapesos-*.dir.tar.gz' -o -name 'shapesos-*.dir.tar.gz.sha256' \) -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
    log info "retention applied" ",\"keepDays\":$KEEP_DAYS,\"deleted\":$pruned"
  fi
}

run_once() {
  case "${BACKUP_SOURCE:-pg_dump}" in
    pg_dump) backup_once ;;
    render-export) render_export_once ;;
    *) fail "BACKUP_SOURCE must be pg_dump or render-export" ;;
  esac
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
    (run_once) || log error "backup run failed; retrying next interval"
    sleep "$INTERVAL"
  done
else
  run_once
fi
