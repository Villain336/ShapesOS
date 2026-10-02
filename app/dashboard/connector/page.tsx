// Marketr — Connector Agent slice 1: dashboard page shell (server).
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary actions, Lucide icons only, tokens only.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { ConnectorApp } from "./ConnectorApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Network — Marketr",
  description:
    "Your connector agent's network graph: people, companies, relationship warmth, and import provenance.",
};

export default async function ConnectorPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Network</h1>
        <p className="mt-0.5 text-sm text-muted">
          Your connector agent&apos;s graph: the people you know, how warm each
          relationship is, and where every contact came from.
        </p>
      </div>
      <ConnectorApp />
    </div>
  );
}
