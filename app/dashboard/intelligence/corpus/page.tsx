// Marketr — Phase 10 M9: Expert corpus browser (server page).
// Reads the workspace-agnostic corpus manifest (corpusDir()/manifest.json —
// data/corpus on a single box; the refreshed read cache of the published
// snapshot on a shared install, deploy PR) and hands it to CorpusClient.
// House style per StudioApp.tsx (diffed class-by-class).

import { redirect } from "next/navigation";
import Link from "next/link";
import { Brain } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { CorpusClient } from "./CorpusClient";
import { loadManifest } from "@/lib/intelligence/corpus/store";
import { ensureCorpusFresh } from "@/lib/intelligence/corpus/sync";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Expert corpus — ShapesOS",
  description:
    "ShapesOS's expert knowledge base: licensed marketing sources, Tier 1S original syntheses, chunk counts, licenses, and eval precision.",
};

export default async function CorpusPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  await ensureCorpusFresh();
  const manifest = loadManifest();

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Expert corpus</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            The marketing knowledge the Chief Strategy Agent reasons with: licensed
            sources ingested verbatim, learn-only sources shipped as Marketr-original
            Tier 1S syntheses, and the precision gate every corpus build must pass.
          </p>
        </div>
        <Link
          href="/dashboard/intelligence/corpus/brain"
          className="aos-press flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ink-hover"
        >
          <Brain className="h-3.5 w-3.5" /> Knowledge Brain
        </Link>
      </div>
      <CorpusClient manifest={manifest} />
    </div>
  );
}
