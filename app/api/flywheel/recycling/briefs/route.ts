// Marketr — /api/flywheel/recycling/briefs
// GET  → list recycling briefs (workspace-scoped, optional ?status=)
// POST → generate a recycling brief from a trigger signal (editor).
//        Deterministic variant specs via the channel-pair rule table; the
//        brief is born "draft" — nothing auto-publishes, ever.

import type { NextRequest } from "next/server";
import { recyclingGuard, badRequest, notProvisioned, recyclingError } from "../_lib";
import { CreateBriefSchema } from "../_schemas";
import {
  recyclingTablesReady, prismaRecyclingBriefStore, prismaRecyclingAuditStore,
} from "@/lib/flywheel/recycling/db";
import {
  buildBrief, createBrief,
} from "@/lib/flywheel/recycling/briefs";
import type { RecyclingBriefStatus } from "@/lib/flywheel/recycling/types";

export const dynamic = "force-dynamic";

const STATUSES: RecyclingBriefStatus[] = ["draft", "approved", "regenerating", "ready"];

export async function GET(req: NextRequest) {
  const gate = await recyclingGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await recyclingTablesReady())) return notProvisioned();

  const q = new URL(req.url).searchParams;
  const status = q.get("status");
  if (status !== null && !(STATUSES as string[]).includes(status)) {
    return badRequest(`Invalid status (one of ${STATUSES.join(", ")}).`);
  }
  const store = prismaRecyclingBriefStore();
  const briefs = await store.list(gate.workspaceId, (status as RecyclingBriefStatus) ?? undefined, 100);
  return Response.json({ briefs, tablesReady: true });
}

export async function POST(req: NextRequest) {
  const gate = await recyclingGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await recyclingTablesReady())) return notProvisioned();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateBriefSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  const { signal, targetChannels } = parsed.data;
  // The signal must belong to the caller's workspace — a foreign signal is
  // a cross-workspace smuggle attempt, not a brief.
  if (signal.workspaceId !== gate.workspaceId) {
    return badRequest("Signal does not belong to this workspace.");
  }

  try {
    const payload = buildBrief({ signal, targetChannels, createdBy: gate.userId });
    const brief = await createBrief(
      prismaRecyclingBriefStore(),
      prismaRecyclingAuditStore(),
      payload,
    );
    return Response.json({ brief }, { status: 201 });
  } catch (err) {
    return recyclingError(err);
  }
}
