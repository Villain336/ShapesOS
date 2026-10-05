// Marketr — Wave 2 WFH mode slice 6: home-office expenses page.
//
// Pre-wired category pack with allocation rules; record expenses and see the
// monthly deductible summary. A category pack + allocation engine, not a full
// expense product — a finance ledger consumes rows via the toLedgerEntry hook.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import WfhTabs from "../_components/WfhTabs";
import ExpensesPanel from "./_components/ExpensesPanel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WFH home-office expenses — ShapesOS",
  description: "Home-office expense pack with allocation rules and monthly summaries.",
};

export default async function WfhExpensesPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="bg-canvas p-4 md:p-6">
      <h1 className="aos-heading">WFH mode</h1>
      <p className="mt-1 text-sm text-muted">
        Home-office expenses: pre-wired categories with allocation rules. The
        deductible math is a starting point for your accountant — not tax advice.
      </p>
      <div className="mt-3">
        <WfhTabs active="expenses" />
      </div>
      <div className="mt-4">
        <ExpensesPanel />
      </div>
    </div>
  );
}
