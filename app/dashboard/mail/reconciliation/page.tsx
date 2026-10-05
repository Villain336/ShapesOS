// Marketr — cost reconciliation report (Phase 4, Track T3; spec F7).
// Lives under /dashboard/mail — NOT /dashboard/billing.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { ReconcileApp } from "./ReconcileApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cost Reconciliation — ShapesOS",
  description:
    "Ledger estimates vs provider actuals for direct mail: campaigns or month, variance flags, manual invoice import.",
};

export default async function ReconciliationPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Cost Reconciliation</h1>
        <p className="mt-1 text-sm text-muted">
          Ledger estimates vs provider actuals for direct mail. Actuals come from webhook-derived
          costs automatically, plus provider invoices you import manually. Variance beyond rounding
          is flagged.
        </p>
      </div>
      <ReconcileApp />
    </div>
  );
}
