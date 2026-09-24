// Marketr — CRM forecast: weighted pipeline per stage.
// GET /api/crm/forecast?pipelineId=
// Weight = value × (score/100): a $10k lead at score 80 contributes $8k.
// Read-only reporting surface (R2's future home); no meter, no mutation.

import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { parseStages, CLOSED_STAGES } from "@/lib/crm/stages";

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const pipelineId = new URL(req.url).searchParams.get("pipelineId");
  const whereBase = { workspaceId: workspace.id, ...(pipelineId ? { pipelineId } : {}) };

  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId: workspace.id, ...(pipelineId ? { id: pipelineId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  if (pipelines.length === 0) return Response.json({ pipelines: [] });

  const out = [];
  for (const p of pipelines) {
    const stages = parseStages(p.stages);
    const leads = await prisma.lead.findMany({
      where: { ...whereBase, pipelineId: p.id },
      select: { stage: true, score: true, valueCents: true },
    });
    const byStage = stages.map((s) => {
      const inStage = leads.filter((l) => l.stage === s.id);
      const value = inStage.reduce((a, l) => a + (l.valueCents ?? 0), 0);
      const weighted = inStage.reduce((a, l) => a + (l.valueCents ?? 0) * (l.score / 100), 0);
      return {
        id: s.id, label: s.label, color: s.color,
        count: inStage.length,
        valueCents: value,
        weightedCents: Math.round(weighted),
        closed: CLOSED_STAGES.has(s.id),
      };
    });
    const openStages = byStage.filter((s) => !s.closed);
    out.push({
      pipeline: { id: p.id, name: p.name },
      stages: byStage,
      totals: {
        openCount: openStages.reduce((a, s) => a + s.count, 0),
        openValueCents: openStages.reduce((a, s) => a + s.valueCents, 0),
        weightedCents: openStages.reduce((a, s) => a + s.weightedCents, 0),
        wonCents: byStage.filter((s) => s.id === "won").reduce((a, s) => a + s.valueCents, 0),
      },
    });
  }
  return Response.json({ pipelines: out });
}
