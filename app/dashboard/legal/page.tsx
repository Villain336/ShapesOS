// Marketr — Legal/Compliance slice 1: dashboard page shell (server).
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary actions, Lucide icons only, tokens only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { LegalApp } from "./LegalApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Legal — Marketr",
  description:
    "Your per-business obligation map: licenses, filings, tax registrations, insurance, and permits. General information only — not legal advice.",
};

export default async function LegalPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Legal</h1>
        <p className="mt-0.5 text-sm text-muted">
          Your obligation map — licenses, filings, tax registrations, insurance,
          and permits for your industry, business model, and jurisdictions.
          Computed per business, never generic.
        </p>
      </div>
      <LegalApp />
    </div>
  );
}
