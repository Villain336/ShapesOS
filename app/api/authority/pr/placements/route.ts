// Marketr — POST /api/authority/pr/placements (+ GET for the coverage list)
// Coverage attribution: submitted → placed → visibility impact; placements
// feed the AEO-consumable source-domain list. Editor+ for POST, viewer+ for GET.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { recordPlacement, listPlacements } from "@/lib/authority/pr/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ placements: [], aeoSourceDomains: [], tablesReady: false });
  }
  const result = await listPlacements(gate.workspaceId);
  return Response.json({ ...result, tablesReady: true });
}

const placementSchema = z.object({
  opportunityId: z.string().optional(),
  url: z.string().url(),
  outlet: z.string().min(1),
  publishDate: z.string().datetime().optional(),
  signals: z
    .object({
      backlinks: z.number().int().min(0).optional(),
      referralSessions: z.number().int().min(0).optional(),
      socialShares: z.number().int().min(0).optional(),
      quotedAsExpert: z.boolean().optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const parsed = placementSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const result = await recordPlacement({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      ...parsed.data,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
