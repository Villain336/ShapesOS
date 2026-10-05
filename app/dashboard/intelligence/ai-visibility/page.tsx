// Marketr — Phase 10 M3: AI-visibility intelligence page.
// Per-engine distribution tables with confidence intervals and stability
// scores. Tables first, charts only where distributions need them.
// UI copy obeys the honest-labeling contract: "estimated range," never "score."

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listPanels, getPanel } from "@/lib/intelligence/geo/panels";
import { summarizePanel } from "@/lib/intelligence/geo/summary";
import { AiVisibilityClient } from "./AiVisibilityClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "AI visibility — ShapesOS",
  description:
    "Honest AI-visibility intelligence: per-engine estimated ranges with confidence intervals, N-rep stability, citation gaps, and first-party correlation.",
};

interface SearchParams {
  panelId?: string;
  ownedDomain?: string;
  brand?: string;
  projectId?: string;
}

export default async function AiVisibilityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit =
    membership.role === "owner" ||
    membership.role === "admin" ||
    membership.role === "editor";

  const { panelId: panelParam, ownedDomain: domainParam, brand: brandParam, projectId: projectParam } =
    await searchParams;
  const ownedDomain = (domainParam ?? "").trim();
  const brand = (brandParam ?? "").trim();
  const projectId = (projectParam ?? "").trim();

  const panels = await listPanels(workspace.id);
  const activeId = panelParam ?? panels[0]?.id ?? null;
  const panel = activeId ? await getPanel(workspace.id, activeId) : null;

  const summary =
    panel && ownedDomain ? await summarizePanel(workspace.id, panel.id, ownedDomain) : null;

  return (
    <AiVisibilityClient
      panels={panels.map((p) => ({
        id: p.id,
        engine: p.engine,
        promptSetVersion: p.promptSetVersion,
        promptCount: p.prompts.length,
        cadence: p.cadence,
        nReps: p.nReps,
        createdAt: p.createdAt.toISOString(),
      }))}
      activePanel={
        panel
          ? {
              id: panel.id,
              engine: panel.engine,
              promptSetVersion: panel.promptSetVersion,
              prompts: panel.prompts,
              cadence: panel.cadence,
              nReps: panel.nReps,
            }
          : null
      }
      summary={summary}
      ownedDomain={ownedDomain}
      brand={brand}
      canEdit={canEdit}
      projectId={projectId}
    />
  );
}
