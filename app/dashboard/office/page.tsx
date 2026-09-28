// Marketr — Phase 14: Office page shell (server).
// The standalone docs surface: workspace sheets/docs list + embedded Univer
// editor. Follows the Studio house pattern (AGENTS.md).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listUniverDocs } from "@/lib/univer/docs";
import { OfficeClient } from "./OfficeClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Office — Marketr",
  description: "Sheets, docs and decks your agents and reports produce — editable, stored by Marketr.",
};

export default async function OfficePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const docs = await listUniverDocs(workspace.id, { limit: 100 });

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Office</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Reports as live spreadsheets, content calendars, client deliverables — created by
          you or your agents, stored by Marketr, editable right here.
        </p>
      </div>
      <OfficeClient initialDocs={JSON.parse(JSON.stringify(docs))} />
    </div>
  );
}
