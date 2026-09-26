// Marketr — Phase 10 M9: Expert corpus browser (server page).
// Reads the workspace-agnostic corpus manifest (data/corpus/manifest.json)
// on the server and hands it to CorpusClient for tabs/tables.
// House style per StudioApp.tsx (diffed class-by-class).

import { redirect } from "next/navigation";
import fs from "node:fs";
import path from "node:path";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { CorpusClient } from "./CorpusClient";
import type { CorpusManifest } from "@/lib/intelligence/corpus/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Expert corpus — Marketr",
  description:
    "Marketr's expert knowledge base: licensed marketing sources, Tier 1S original syntheses, chunk counts, licenses, and eval precision.",
};

function readManifest(): CorpusManifest | null {
  try {
    const p = path.join(process.cwd(), "data", "corpus", "manifest.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as CorpusManifest;
  } catch {
    return null;
  }
}

export default async function CorpusPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const manifest = readManifest();

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Expert corpus</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
          The marketing knowledge the Chief Strategy Agent reasons with: licensed
          sources ingested verbatim, learn-only sources shipped as Marketr-original
          Tier 1S syntheses, and the precision gate every corpus build must pass.
        </p>
      </div>
      <CorpusClient manifest={manifest} />
    </div>
  );
}
