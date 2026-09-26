#!/usr/bin/env bash
# Marketr — Phase 10 M5: one-time Common Crawl hyperlink-graph download.
#
# Downloads the DOMAIN-LEVEL graph release the difficulty model needs and
# builds the local SQLite index used by lib/intelligence/difficulty/authority.ts.
#
#   One-time cost:  ~16GB download (vertices + edges + ranks for the release)
#   Recurring cost: $0 per query (local index)
#
# The difficulty model only needs the domain-RANKS file (~1.9GB compressed):
# pass --ranks-only to skip vertices/edges. Quarterly freshness: re-run with
# CC_GRAPH_CRAWL=<new-crawl> to refresh.
#
# Layout on disk (see ccGraphPaths() in authority.ts):
#   <CC_GRAPH_DIR>/<crawl>/<crawl>-domain-ranks.txt.gz
#   <CC_GRAPH_DIR>/cc-domain-ranks.sqlite   (built index)
#
# Usage:
#   CC_GRAPH_CRAWL=cc-main-2026-26 CC_GRAPH_DIR=~/.cc-graph ./scripts/cc-graph-download.sh [--ranks-only]

set -euo pipefail

CRAWL="${CC_GRAPH_CRAWL:-cc-main-2026-26}"
DIR="${CC_GRAPH_DIR:-$HOME/workspace/marketr/.cc-graph}"
RANKS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --ranks-only) RANKS_ONLY=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

BASE="https://data.commoncrawl.org/projects/hyperlinkgraph/${CRAWL}/domain"
OUTDIR="$DIR/$CRAWL"
mkdir -p "$OUTDIR"

echo "== Common Crawl hyperlink graph: $CRAWL"
echo "== destination: $OUTDIR"

files=(
  "${CRAWL}-domain-ranks.txt.gz"
)
if [ "$RANKS_ONLY" -eq 0 ]; then
  files+=(
    "${CRAWL}-domain-vertices.txt.gz"
    "${CRAWL}-domain-edges.txt.gz"
  )
fi

for f in "${files[@]}"; do
  if [ -f "$OUTDIR/$f" ]; then
    echo "-- exists, skipping: $f"
    continue
  fi
  echo "++ downloading $f (~GBs — this takes a while)"
  curl -fL --retry 3 -o "$OUTDIR/$f" "$BASE/$f"
done

echo "== verifying ranks file"
gzip -t "$OUTDIR/${CRAWL}-domain-ranks.txt.gz"
echo "ranks file OK"

echo ""
echo "Next: build the local index (one-time, streams the ~2GB file):"
echo "  npx tsx -e \"import('./lib/intelligence/difficulty/authority.ts').then(m => m.buildCcIndex())\""
echo ""
echo "Set CC_GRAPH_CRAWL=$CRAWL (already the default) and CC_GRAPH_DIR=$DIR to use it."
