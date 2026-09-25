// Marketr — POST /api/authority/pr/opportunities/ingest
// Digest parsing + monitoring (fixture-backed in v1): multi-source ingest,
// cross-source de-dupe, expertise matching, deadline triage. Editor+.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { ingestForWorkspace } from "@/lib/authority/pr/service";

export const dynamic = "force-dynamic";

const ingestSchema = z.object({
  sources: z
    .array(z.enum(["haro", "connectively", "qwoted", "sos", "hab2bw", "journo_request"]))
    .optional(),
  expertise: z
    .object({
      keywords: z.array(z.string()).optional(),
      beats: z.array(z.string()).optional(),
      industries: z.array(z.string()).optional(),
      targetOutlets: z.array(z.string()).optional(),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const parsed = ingestSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const result = await ingestForWorkspace({
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      sources: parsed.data.sources,
      expertise: parsed.data.expertise,
    });
    return Response.json(result);
  } catch (err) {
    return safetyError(err);
  }
}
