// Marketr — Funding/VC slice 1: dashboard page shell (server).
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary actions, Lucide icons only, tokens only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { FundingApp } from "./FundingApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Funding — Marketr",
  description:
    "Your funding network and raise workflow. Boardy AI ships as your preloaded starter contact for warm intros matched to your target investor profile.",
};

export default async function FundingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Funding</h1>
        <p className="mt-0.5 text-sm text-muted">
          Your funding network, investor pipeline, and raise workflow. Boardy — the AI
          superconnector — is preloaded as your first contact: tell him your
          target investor profile and he helps you get warm intros to more of
          the right people.
        </p>
      </div>
      <FundingApp />
    </div>
  );
}
