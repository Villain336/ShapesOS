// Marketr — /api/authority/aeo/runs
// GET  → list runs (latest first; viewer+)
// POST → run the weekly cadence (on-demand too): one AeoRun row per engine,
//        N=3 reps per prompt per engine, nano judge, cost envelope verified.
//        Engines run via official APIs only — fake fixtures by default; the
//        real path throws NotConfiguredError without a key. (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { aeoRunSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady, authorityAudit } from "@/lib/authority/db";
import {
  AEO_ENGINES, AEO_PROXY_DISCLAIMER, ENGINE_MODELS,
  resolveEngineClient, type AeoEngineName,
} from "@/lib/authority/aeo/engines";
import {
  estimateRunCost, buildRunPlan, executeRunPlan, createPrismaMentionSink,
} from "@/lib/authority/aeo/run";
import { resolveJudge } from "@/lib/authority/aeo/judge";
import { refreshSourceImpact } from "@/lib/authority/aeo/impact";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ runs: [], tablesReady: false });
  }
  const runs = await prisma.aeoRun.findMany({
    where: { workspaceId: gate.workspaceId },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: { promptSet: { select: { version: true } } },
  });
  return Response.json({
    runs: runs.map((r) => ({
      id: r.id,
      promptSetVersion: r.promptSetVersion,
      engine: r.engine,
      status: r.status,
      reps: r.reps,
      costEstimateCents: r.costEstimateCents,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
    })),
    disclaimer: AEO_PROXY_DISCLAIMER,
  });
}

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json(
      { error: "Authority tables not provisioned yet (migration pending)." },
      { status: 503 },
    );
  }
  const parsed = aeoRunSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const { promptSetId, engines, reps, brand, ownedDomain } = parsed.data;
  const engineList: AeoEngineName[] = engines ?? AEO_ENGINES;

  try {
    const promptSet = promptSetId
      ? await prisma.aeoPromptSet.findFirst({ where: { id: promptSetId, workspaceId: gate.workspaceId } })
      : await prisma.aeoPromptSet.findFirst({ where: { workspaceId: gate.workspaceId, active: true } });
    if (!promptSet) {
      return badRequest(
        promptSetId ? "Prompt set not found in workspace." : "No active prompt set — create and activate one first.",
      );
    }
    const prompts = promptSet.promptsJson as string[];

    const costEstimate = estimateRunCost({ promptCount: prompts.length, engines: engineList, reps });

    // Fake by default; real adapters throw NotConfiguredError honestly without keys.
    const fake = true;
    const judge = resolveJudge({ fake });
    const engineClients = Object.fromEntries(
      engineList.map((e) => [e, resolveEngineClient(e, { fake, brand, ownedDomain })]),
    ) as Record<AeoEngineName, ReturnType<typeof resolveEngineClient>>;

    const startedAt = new Date();
    const runRows = [];
    for (const engine of engineList) {
      const row = await prisma.aeoRun.create({
        data: {
          workspaceId: gate.workspaceId,
          promptSetId: promptSet.id,
          promptSetVersion: promptSet.version,
          engine,
          startedAt,
          reps,
          status: "running",
          costEstimateCents: Math.round((costEstimate.perEngine[engine]?.totalUsd ?? 0) * 100),
        },
      });
      runRows.push(row);
    }

    for (const row of runRows) {
      const engine = row.engine as AeoEngineName;
      const plan = buildRunPlan(prompts.length, [engine], reps);
      try {
        await executeRunPlan(
          {
            engineClients: { [engine]: engineClients[engine] } as Record<AeoEngineName, ReturnType<typeof resolveEngineClient>>,
            judge,
            sink: createPrismaMentionSink(row.id),
            brand,
          },
          plan,
          prompts,
          costEstimate,
        );
        await prisma.aeoRun.update({
          where: { id: row.id },
          data: { status: "completed", completedAt: new Date() },
        });
      } catch (err) {
        await prisma.aeoRun.update({
          where: { id: row.id },
          data: { status: "failed", completedAt: new Date() },
        });
        throw err;
      }
    }

    await refreshSourceImpact(gate.workspaceId);
    await authorityAudit.logAsync({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "aeo_run_completed",
      entityType: "aeo_run",
      entityId: runRows[0].id,
      detail: {
        promptSetVersion: promptSet.version,
        engines: engineList,
        reps,
        generations: costEstimate.generations,
        monthlyUsd: Math.round(costEstimate.monthlyUsd * 100) / 100,
        withinEnvelope: costEstimate.withinEnvelope,
      },
    });

    return Response.json(
      {
        runIds: runRows.map((r) => r.id),
        promptSetVersion: promptSet.version,
        engines: engineList.map((e) => ({ engine: e, model: ENGINE_MODELS[e], fake })),
        judge: judge.name,
        costEstimate: {
          weeklyUsd: Math.round(costEstimate.weeklyUsd * 10000) / 10000,
          monthlyUsd: Math.round(costEstimate.monthlyUsd * 100) / 100,
          envelopeUsd: costEstimate.envelopeUsd,
          withinEnvelope: costEstimate.withinEnvelope,
        },
        envelopeFlagged: !costEstimate.withinEnvelope,
        disclaimer: AEO_PROXY_DISCLAIMER,
      },
      { status: 201 },
    );
  } catch (err) {
    return safetyError(err);
  }
}
