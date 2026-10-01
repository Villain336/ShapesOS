// Marketr — Phase 12: Repurpose (content repurposing over the expert corpus).
// Server page: auth + house shell, hands off to RepurposeClient.
// House style per StudioApp.tsx (diffed class-by-class).

import { redirect } from "next/navigation";
import Link from "next/link";
import { Database } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { RepurposeClient } from "./RepurposeClient";
import { REPURPOSE_FORMATS } from "@/lib/content/repurpose";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Repurpose — Marketr",
  description:
    "Turn expert-corpus knowledge into derivative assets: content briefs, video scripts, social threads, newsletter sections.",
};

export default async function RepurposePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="aos-heading">Repurpose</h1>
          <p className="mt-0.5 max-w-2xl text-[13px] text-muted">
            Turn expert-corpus knowledge into derivative assets. Retrieval grounds every
            asset in cited sources; the copy is always synthesized fresh — never verbatim.
          </p>
        </div>
        <Link
          href="/dashboard/intelligence/corpus"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-white px-3 py-1.5 text-[13px] font-medium text-muted hover:bg-hover-paper"
        >
          <Database className="h-3.5 w-3.5" /> Expert corpus
        </Link>
      </div>
      <RepurposeClient formats={REPURPOSE_FORMATS} />
    </div>
  );
}
