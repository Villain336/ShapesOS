// Marketr — /api/authority/aeo/runs/:id
// GET → one run + per-engine scores for its prompt-set version.
// Per-engine ONLY — there is no composite score anywhere in this file.

import type { NextRequest } from "next/server";
import { authorityGuard, safetyError } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { scorePerEngine, roundScore } from "@/lib/authority/aeo/scoring";
import { AEO_PROXY_DISCLAIMER, ENGINE_MODELS, type AeoEngineName } from "@/lib/authority/aeo/engines";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const { id } = await params;
  // Brand is supplied at run time; accept it as ?brand= for entity-accuracy scoring.
  const brand = new URL(req.url).searchParams.get("brand")?.trim() ?? "";
  try {
    const run = await prisma.aeoRun.findFirst({
      where: { id, workspaceId: gate.workspaceId },
      include: { promptSet: { select: { version: true, promptsJson: true } } },
    });
    if (!run) return Response.json({ error: "Run not found in workspace." }, { status: 404 });

    // Per-engine scores aggregate the sibling runs of the same prompt-set version.
    const siblings = await prisma.aeoRun.findMany({
      where: {
        workspaceId: gate.workspaceId,
        promptSetId: run.promptSetId,
        status: "completed",
      },
      include: { mentions: true },
    });
    const byEngine: Partial<Record<AeoEngineName, Parameters<typeof scorePerEngine>[0][AeoEngineName]>> = {};
    for (const s of siblings) {
      const engine = s.engine as AeoEngineName;
      byEngine[engine] = s.mentions.map((m) => ({
        promptIdx: m.promptIdx,
        rep: m.rep,
        mentioned: m.mentioned,
        position: m.position,
        sentiment: m.sentiment as "positive" | "neutral" | "negative" | null,
        competitors: m.competitors,
        citedSources: m.citedSources,
      }));
    }
    const perEngine = scorePerEngine(byEngine, brand);
    const rounded: Record<string, ReturnType<typeof roundScore> | null> = {};
    for (const [engine, score] of Object.entries(perEngine)) {
      rounded[engine] = score ? roundScore(score) : null;
    }

    return Response.json({
      run: {
        id: run.id,
        promptSetVersion: run.promptSetVersion,
        engine: run.engine,
        status: run.status,
        reps: run.reps,
        costEstimateCents: run.costEstimateCents,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      },
      // Per-engine only — no composite.
      perEngine: rounded,
      models: ENGINE_MODELS,
      disclaimer: AEO_PROXY_DISCLAIMER,
    });
  } catch (err) {
    return safetyError(err);
  }
}
