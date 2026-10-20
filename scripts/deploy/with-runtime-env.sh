#!/bin/sh
# ShapesOS — start a process with the hosted runtime environment (deploy PR).
#
#   sh scripts/deploy/with-runtime-env.sh node server.js                    (web)
#   sh scripts/deploy/with-runtime-env.sh node node_modules/tsx/dist/cli.mjs scripts/worker.mts
#   sh scripts/deploy/with-runtime-env.sh --owner sh scripts/db/migrate.sh  (AWS migrate task)
#
# The dockerCommand / container command of the hosted services (render.yaml,
# infra/aws). scripts/deploy/runtime-env.mjs loads secret blobs and composes
# DATABASE_URL (the app role; --owner: the schema owner, migrations only);
# then the command is exec'd so it receives SIGTERM directly (graceful drain).
# If DATABASE_URL can't be formed, nothing starts. Unused under compose.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
mode=""
if [ "${1:-}" = "--owner" ]; then
  mode="--owner"
  shift
fi
[ "$#" -gt 0 ] || { echo "usage: with-runtime-env.sh [--owner] <command> [args…]" >&2; exit 2; }
exports="$(node "$here/runtime-env.mjs" $mode)"
eval "$exports"
exec "$@"
