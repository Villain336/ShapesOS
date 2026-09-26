// Marketr — Phase 10 M3 API: citation-gap analysis.
// GET /api/intelligence/geo/citations?panelId=…&ownedDomain=… (viewer+)

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import {
  detectCitationGaps,
  ownedCitationCoverage,
  rankCitedDomains,
  type CitationObservation,
} from "@/lib/intelligence/geo/citations";
import { gapToBriefHandoff } from "@/lib/intelligence/geo/actions";
import { getPanel, getActivePanels } from "@/lib/intelligence/geo/panels";

export const dynamic = "force-dynamic";

function engineOf(meta: unknown): string | null {
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    return typeof m.engine === "string" ? m.engine : null;
  }
  return null;
}
function promptIdxOf(meta: unknown): number | null {
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    return typeof m.promptIdx === "number" ? m.promptIdx : null;
  }
  return null;
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const params = new URL(req.url).searchParams;
  let panelId = params.get("panelId") ?? "";
  const ownedDomain = (params.get("ownedDomain") ?? "").trim().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const projectId = (params.get("projectId") ?? "").trim() || undefined;
  if (!ownedDomain) {
    return Response.json({ error: "ownedDomain is required." }, { status: 400 });
  }
  if (!panelId) {
    const active = await getActivePanels(workspace.id);
    if (!active[0]) return Response.json({ error: "No prompt panels yet." }, { status: 404 });
    panelId = active[0].id;
  }
  const panel = await getPanel(workspace.id, panelId);
  if (!panel) return Response.json({ error: "Panel not found." }, { status: 404 });

  const rows = await withWorkspaceScope(workspace.id, (tx: TxClient) =>
    tx.geoObservation.findMany({
      where: { workspaceId: workspace.id, panelId: panel.id },
      select: { brandMentioned: true, citationUrls: true, stabilityMetadata: true },
    }),
  );
  const obs: CitationObservation[] = rows.map((r) => ({
    promptIdx: promptIdxOf(r.stabilityMetadata),
    engine: engineOf(r.stabilityMetadata) ?? "unknown",
    citationUrls: r.citationUrls,
    brandMentioned: r.brandMentioned,
  }));

  const gaps = detectCitationGaps(obs, [ownedDomain], panel.prompts);
  const handoffs = gaps.map((g) =>
    gapToBriefHandoff(g, panel.prompts[g.promptIdx] ?? `Prompt ${g.promptIdx + 1}`, ownedDomain, {
      projectId,
    }),
  );

  return Response.json({
    panelId: panel.id,
    promptSetVersion: panel.promptSetVersion,
    observations: rows.length,
    coverage: ownedCitationCoverage(obs, [ownedDomain]),
    gaps: gaps.map((g, i) => ({ ...g, handoff: handoffs[i] })),
    topCitedDomains: rankCitedDomains(obs),
  });
}
