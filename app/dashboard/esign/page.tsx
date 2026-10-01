// Marketr — Wave 2 E-sign module: page shell (server).
// Follows the Studio/Office house pattern (AGENTS.md).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { EsignApp } from "./EsignApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "E-sign — Marketr",
  description: "Prepare, send, and track signature envelopes — governed, evidence-first.",
};

export default async function EsignPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">E-sign</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Prepare signature envelopes, review them, and send — the vendor seals the
          document, Marketr keeps the evidence.
        </p>
      </div>
      <EsignApp />
    </div>
  );
}
