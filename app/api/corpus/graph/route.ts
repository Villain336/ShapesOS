// Marketr — Knowledge Brain graph API.
// GET /api/corpus/graph → { version, updatedAt, stats, nodes, edges } (viewer+).
//
// Data-driven: every source in data/corpus/manifest.json becomes a node;
// proposed sources (data/corpus/proposed/) and removal flags
// (data/corpus/removals.json) layer on top. New registry/manifest entries
// need zero code changes to appear.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { loadManifest } from "@/lib/intelligence/corpus/store";
import { ensureCorpusFresh } from "@/lib/intelligence/corpus/sync";
import { buildCorpusGraph } from "@/lib/intelligence/corpus/graph";
import { listProposed, removalIdMap } from "@/lib/intelligence/corpus/proposals";
import { loadEvalSummary, readRetrievalUsage } from "@/lib/intelligence/corpus/activity";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  await ensureCorpusFresh(); // shared installs: refresh this instance's read cache
  const manifest = loadManifest();
  if (!manifest) return Response.json({ error: "Corpus manifest not found" }, { status: 404 });

  // Audit data — all real: eval results file, retrieval-usage counter.
  const evalSummary = loadEvalSummary();
  const usage = await readRetrievalUsage();
  const graph = buildCorpusGraph(manifest, listProposed(), removalIdMap(), {
    eval: evalSummary
      ? {
          precision: evalSummary.precision,
          questions: evalSummary.questions,
          correct: evalSummary.correct,
          runAt: evalSummary.runAt,
        }
      : null,
    evalHitsBySource: evalSummary?.hitsBySource,
    retrievalHitsBySource: new Map(
      [...usage.entries()].map(([id, u]) => [id, u.hits] as const),
    ),
  });
  return Response.json(graph);
}
