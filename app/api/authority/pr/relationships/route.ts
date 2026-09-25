// Marketr — GET/POST /api/authority/pr/relationships
// Relationship CRM-lite: per-journalist history, declination reasons,
// 90-day re-engagement windows, follow-up counts. GET is viewer+; POST is editor+.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import {
  listRelationships, recordRelationshipEvent,
} from "@/lib/authority/pr/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ relationships: [], tablesReady: false });
  }
  const relationships = await listRelationships(gate.workspaceId);
  return Response.json({ relationships, tablesReady: true });
}

const eventSchema = z.object({
  journalist: z.string().min(1),
  outlet: z.string().min(1),
  kind: z.enum(["pitched", "followed_up", "placed", "declined", "note"]),
  detail: z.string().min(1).max(2000),
  declinationReason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const parsed = eventSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const rel = await recordRelationshipEvent({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      ...parsed.data,
    });
    return Response.json({ relationship: rel }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
