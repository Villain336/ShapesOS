#!/bin/sh
# ShapesOS — CI: give the GitHub runner more swap before `next build`.
#
# A standard runner for a private repository has 2 CPUs / 8 GB RAM / 14 GB SSD
# and ~4 GB of swap. The production build's Turbopack compile holds ~9–10 GB
# at its peak (measured 2026-10-06: #26 9.4 GB, #27 10.3 GB process RSS on a
# 4-CPU box; the JS heap cap barely changes it — the native compiler owns it).
# When RAM + swap run out the runner itself is killed ("The runner has
# received a shutdown signal") and no log says why. Extra swap lets the
# kernel page out cold compiler data instead, so the build finishes (a little
# slower) instead of taking the runner down.
#
# CI-only; nothing in the app changes. The lasting fix is a bigger build
# machine (a larger GitHub runner, or Render's build pipeline — see
# docs/deploy/RENDER.md "Build capacity").
#
# Usage: sh scripts/ci/add-swap.sh [target total swap in GB, default 12]
set -eu

target_gb=${1:-12}
dir=/mnt
if [ ! -d "$dir" ]; then dir=/; fi
file="$dir/shapes-build.swap"

current_mb=$(free -m | awk '/^Swap:/ {print $2}')
want_mb=$((target_gb * 1024 - current_mb))
# Keep at least 4 GB of disk free for node_modules, .next and the database.
avail_mb=$(df -m --output=avail "$dir" | tail -1 | tr -d ' ')
max_mb=$((avail_mb - 4096))
if [ "$want_mb" -gt "$max_mb" ]; then want_mb=$max_mb; fi

echo "swap before: ${current_mb} MB; disk free: ${avail_mb} MB; adding: ${want_mb} MB at $file"
add_swap() {
  sudo fallocate -l "${want_mb}M" "$file" || sudo dd if=/dev/zero of="$file" bs=1M count="$want_mb" status=none
  sudo chmod 600 "$file"
  sudo mkswap "$file" >/dev/null
  sudo swapon "$file"
}
if [ "$want_mb" -gt 512 ] && [ ! -f "$file" ]; then
  # Best effort: if the runner refuses, the build still runs (and says so).
  add_swap || echo "::warning::could not add swap; the build runs with the runner's default swap"
fi
free -m
