// Marketr — Wave 2 Insurance slice 1: policy inventory page shell (server).
// Follows the Studio/Office house pattern (AGENTS.md).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { InsuranceApp } from "./InsuranceApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Insurance — Marketr",
  description: "Policy inventory, renewal alerts, and declarations-page ingestion — governed, coverage-truth only.",
};

export default async function InsurancePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Insurance</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Every policy, carrier, limit, premium, and renewal date in one place —
          coverage renders from carrier truth only, never invented.
        </p>
      </div>
      <InsuranceApp />
    </div>
  );
}
