// Marketr — automation settings page (Phase 9 M6, SPEC-PHASE9.md §P9E).
// Server-gated: editor+ only (this page changes what the agent may do on
// its own). Renders the per-action policy table + escalation rules form.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import AutomationSettingsForm from "@/components/settings/AutomationSettingsForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Automation settings — Marketr",
  description:
    "Per-action autopilot policy: what Marketr may do on its own, what asks for approval, and what can never run automatically — plus escalation rules.",
};

export default async function AutomationSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard/settings");

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Automation settings</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — what Marketr may do on its own, what asks you first, and what is never
          allowed. The safety core enforces these in code, not in prompts.
        </p>
      </div>
      <SettingsNav />
      <AutomationSettingsForm />
    </div>
  );
}
