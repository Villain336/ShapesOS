// Marketr — F1 reallocation command center (Phase 7).
// Mode toggle (propose-only default / SRA opt-in), proposal queue with
// marginal-ROAS decision records, SRA envelope management with plain-language
// consequences, breaker status + acknowledgment, immutable audit log view.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import ReallocationApp from "./ReallocationApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reallocation — Marketr",
  description: "Budget reallocation agent: marginal-ROAS optimizer, SRA guardrails, breakers, audit.",
};

export default async function ReallocationPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const isOwner = membership.role === "owner" || membership.role === "admin";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Budget reallocation</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-stone-500">
          Marginal-ROAS equalization across channels on diminishing-returns curves — never greedy
          last-click. Mode (a) proposes and every move is human-approved; mode (b) executes only
          inside a human-signed, expiring Standing Reallocation Approval. Every dollar stays
          human-signed — that is the exit gate, not a feature.
        </p>
      </div>
      <ReallocationApp isOwner={isOwner} />
    </div>
  );
}
