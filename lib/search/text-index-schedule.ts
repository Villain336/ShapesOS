// ShapesOS — Phase 18.1: the light entry point of the Spotlight text index.
//
// lib/filesystem/service.ts (imported by ~30 routes) and lib/univer/docs.ts
// call these on every write. They used to import lib/search/text-index.ts
// directly, which statically pulls in the document extractors (adm-zip),
// exceljs, the Univer exporters and the embedder — so every one of those
// routes bundled all of it and the production build outgrew the CI runner.
// This module imports nothing heavy: the indexer is loaded with a dynamic
// import() only when an index job actually runs (after the response).

import { log } from "@/lib/observability/log";

/**
 * Run indexing after the current request without making it wait. In a Next
 * request this uses after() (the platform keeps the work alive past the
 * response); elsewhere (scripts, workers, tests) it runs detached. Failures
 * are logged; the backfill script repairs anything missed.
 */
export function scheduleTextIndex(job: () => Promise<unknown>, label: string): void {
  const run = () =>
    job().catch((err) => log.warn("search text index failed", { label, error: err instanceof Error ? err.message : String(err) }));
  void (async () => {
    try {
      const { after } = await import("next/server");
      after(run);
    } catch {
      void run();
    }
  })();
}

// On write, the text is indexed at once (full text works immediately). The
// chunks are embedded right away only when this process already has the
// model loaded (any Spotlight search loads it); otherwise the search-index
// cron (/api/cron/search-index) embeds them, so an upload never pays for a
// model load. SPOTLIGHT_INDEX_ON_WRITE=off turns the write hook off (the
// cron and the backfill script still index).
export function scheduleFileTextIndex(workspaceId: string, fileId: string): void {
  if (process.env.SPOTLIGHT_INDEX_ON_WRITE === "off") return;
  scheduleTextIndex(async () => {
    const [{ indexFileText }, { spotlightEmbedderLoaded }] = await Promise.all([import("./text-index"), import("./semantic")]);
    return indexFileText(workspaceId, fileId, { embed: spotlightEmbedderLoaded() });
  }, `file:${fileId}`);
}

export function scheduleUniverDocTextIndex(workspaceId: string, docId: string): void {
  if (process.env.SPOTLIGHT_INDEX_ON_WRITE === "off") return;
  scheduleTextIndex(async () => {
    const [{ indexUniverDocText }, { spotlightEmbedderLoaded }] = await Promise.all([import("./text-index"), import("./semantic")]);
    return indexUniverDocText(workspaceId, docId, { embed: spotlightEmbedderLoaded() });
  }, `doc:${docId}`);
}
