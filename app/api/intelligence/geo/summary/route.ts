// Marketr — Phase 10 M3 API: honest per-engine summary.
// GET /api/intelligence/geo/summary?panelId=…&ownedDomain=… (viewer+)
// Every metric ships with Wilson 95% CI + stability — never a single score.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { summarizePanel } from "@/lib/intelligence/geo/summary";
import { getActivePanels } from "@/lib/intelligence/geo/panels";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const params = new URL(req.url).searchParams;
  let panelId = params.get("panelId") ?? "";
  const ownedDomain = (params.get("ownedDomain") ?? "").trim();
  if (!ownedDomain) {
    return Response.json({ error: "ownedDomain is required (citation coverage needs the brand domain)." }, { status: 400 });
  }
  if (!panelId) {
    // Default: the active (latest-version) panel of the first engine with data.
    const active = await getActivePanels(workspace.id);
    const first = active[0];
    if (!first) return Response.json({ error: "No prompt panels yet. Create one first." }, { status: 404 });
    panelId = first.id;
  }
  try {
    const summary = await summarizePanel(workspace.id, panelId, ownedDomain);
    return Response.json(summary);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Summary failed." },
      { status: 400 },
    );
  }
}
