// Marketr — GET /api/flywheel/recycling/signals
// Runs the trigger-signal ingestion across Phases 2–6 readers and returns
// the flagged winners. ?fake=1 forces the labeled fixture reader (preview).

import type { NextRequest } from "next/server";
import { recyclingGuard, badRequest } from "../_lib";
import { SignalsQuerySchema } from "../_schemas";
import {
  collectSignals, DEFAULT_READERS, fixtureSignalReader,
} from "@/lib/flywheel/recycling/signals";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await recyclingGuard("viewer");
  if (gate instanceof Response) return gate;

  const q = new URL(req.url).searchParams;
  const parsed = SignalsQuerySchema.safeParse({
    fake: q.get("fake") ?? undefined,
    since: q.get("since") ?? undefined,
  });
  if (!parsed.success) return badRequest("Invalid query", parsed.error.issues);

  const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
  const signals = await collectSignals(gate.workspaceId, {
    fake: parsed.data.fake,
    since,
  });
  return Response.json({
    signals,
    readers: (parsed.data.fake ? [fixtureSignalReader] : DEFAULT_READERS).map((r) => ({
      kind: r.kind,
      source: r.source,
      description: r.describe(),
    })),
  });
}
