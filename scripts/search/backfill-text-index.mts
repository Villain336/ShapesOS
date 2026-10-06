// ShapesOS — Phase 18.1 (WS=find): index the text inside every existing
// workspace file and Office doc for Spotlight (lib/search/text-index.ts).
//
//   DATABASE_URL=… npx tsx scripts/search/backfill-text-index.mts [--workspace <id>] [--force] [--no-embed] [--limit N]
//
// Idempotent: a record whose extracted text (content hash) is unchanged is
// skipped, so it is safe to run again (and /api/cron/search-index runs the
// same function on a schedule). --force re-extracts everything; --no-embed
// leaves embeddings to the cron (full-text search works without them).
// Runs as the app role: every write goes through withWorkspaceScope (FORCE RLS).

import "dotenv/config";
import { backfillTextIndex } from "../../lib/search/text-index";
import { prisma } from "../../lib/prisma";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const started = Date.now();
const summary = await backfillTextIndex({
  workspaceId: arg("--workspace"),
  force: process.argv.includes("--force"),
  embed: !process.argv.includes("--no-embed"),
  limit: arg("--limit") ? Number(arg("--limit")) : undefined,
});
console.log(JSON.stringify({ ...summary, seconds: Math.round((Date.now() - started) / 100) / 10 }, null, 2));
await prisma.$disconnect();
