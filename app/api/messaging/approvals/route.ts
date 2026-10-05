// Marketr — /api/messaging/approvals
//
// GET  → list approval items (?status=pending default, ?kind=, ?limit=)
// POST → open a new approval item { kind, payload, requestedBy? }

import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { messagingGuard, badRequest } from "../_lib";
import { requestApproval } from "@/lib/messaging/dispatcher";
import { intQuery, parseQuery } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await messagingGuard("viewer");
  if (gate instanceof Response) return gate;

  const q = req.nextUrl.searchParams;
  const limitQuery = parseQuery(z.object({ limit: intQuery(50, 1, 200) }), q);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;
  const where: Record<string, unknown> = { workspaceId: gate.workspaceId };
  const status = q.get("status")?.trim();
  if (status) where.status = status;
  else where.status = "pending";
  const kind = q.get("kind")?.trim();
  if (kind) where.kind = kind;

  const items = await prisma.approvalItem.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return Response.json({ approvals: items, workspaceId: gate.workspaceId });
}

const CreateSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  payload: z.unknown(),
  requestedBy: z.string().trim().max(120).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await messagingGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const item = await requestApproval({
      workspaceId: gate.workspaceId,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
      requestedBy: parsed.data.requestedBy,
    });
    return Response.json({ approval: item }, { status: 201 });
  } catch (e) {
    return badRequest(e instanceof Error ? e.message : "Could not create approval");
  }
}
