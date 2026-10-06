#!/usr/bin/env tsx
// ShapesOS — Deploy PR (WS=state): publish the knowledge corpus to shared
// storage for a multi-instance install.
//
// The corpus is a platform asset built from a checkout of the repo with
// scripts/ingest-corpus.mts (it writes data/corpus/). On a single box the app
// reads that directory directly. On a shared install (MARKETR_STORAGE=s3:
// several web replicas and a worker, no shared disk) every instance reads a
// cached copy of the snapshot published here and refreshes it within a
// minute of a new publish (lib/intelligence/corpus/sync.ts).
//
// Usage (with the production storage settings in the environment):
//   MARKETR_STORAGE=s3 MARKETR_S3_ENDPOINT=… MARKETR_S3_BUCKET=… \
//   MARKETR_S3_ACCESS_KEY=… MARKETR_S3_SECRET_KEY=… \
//     npx tsx scripts/corpus-publish.mts [--from data/corpus]
//
// Uploads the chunk files, licence notes, eval results, removal flags and
// proposals, then the manifest LAST (readers key on it). Stale remote
// proposals are removed.

import path from "node:path";
import { publishCorpusSnapshot } from "../lib/intelligence/corpus/sync";

const i = process.argv.indexOf("--from");
const from = path.resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : path.join(process.cwd(), "data", "corpus"));

try {
  const res = await publishCorpusSnapshot(from);
  console.log(`[corpus-publish] published ${res.uploaded.length} file(s) from ${from}`);
  for (const f of res.uploaded) console.log(`  + ${f}`);
  for (const f of res.removed) console.log(`  - ${f}`);
} catch (err) {
  console.error(`[corpus-publish] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
