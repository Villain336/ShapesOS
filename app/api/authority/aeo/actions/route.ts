// Marketr — /api/authority/aeo/actions
// GET  → list actions (filterable by status/kind; viewer+)
// POST → create an action, or generate from the latest source-impact
//        ranking: owned domains → GEO16 fix proposals; third-party → user
//        action plans with expected lift + deadlines. (editor+)

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { aeoGenerateActionsSchema, aeoCreateActionSchema } from "@/app/api/authority/_schemas";
import { authorityTablesReady } from "@/lib/authority/db";
import {
  createAction, generateActionsFromImpacts, GEO16_PILLARS, type Geo16Pillar,
} from "@/lib/authority/aeo/act";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ actions: [], tablesReady: false });
  }
  const q = new URL(req.url).searchParams;
  const status = q.get("status")?.trim();
  const kind = q.get("kind")?.trim();
  const actions = await prisma.aeoAction.findMany({
    where: {
      workspaceId: gate.workspaceId,
      ...(status ? { status: status as never } : {}),
      ...(kind ? { kind: kind as never } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return Response.json({ actions });
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
  const body = await req.json().catch(() => ({}));

  // Generate mode: rank sources → owned fixes + third-party plans.
  if (body && typeof body === "object" && (body as Record<string, unknown>).generate === true) {
    const parsed = aeoGenerateActionsSchema.safeParse(body);
    if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
    try {
      const result = await generateActionsFromImpacts({
        workspaceId: gate.workspaceId,
        ownedDomains: parsed.data.ownedDomains,
        pageUrls: parsed.data.pageUrls,
        brand: parsed.data.brand,
        createdBy: gate.userId,
        minLift: parsed.data.minLift,
      });
      return Response.json({ generated: result }, { status: 201 });
    } catch (err) {
      return safetyError(err);
    }
  }

  const parsed = aeoCreateActionSchema.safeParse(body);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const { kind, sourceRef, geo16Pillars, fixProposal, actionPlan, expectedLift } = parsed.data;
  const pillars = geo16Pillars.filter((p): p is Geo16Pillar =>
    (GEO16_PILLARS as readonly string[]).includes(p),
  );
  try {
    const action = await createAction({
      workspaceId: gate.workspaceId,
      kind,
      sourceRef,
      geo16Pillars: pillars,
      fixProposal: (fixProposal ?? null) as never,
      actionPlan: (actionPlan ?? null) as never,
      expectedLift: expectedLift ?? null,
      createdBy: gate.userId,
    });
    return Response.json({ action }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
