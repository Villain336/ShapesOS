// Marketr — POST /api/authority/pr/opportunities/:id/draft
// Build the draft workspace: research brief + pitch-the-gap + quote skeleton
// + pre-send checklist + de-AI pass. Drafts are working documents — they
// never send themselves. Editor+.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorityGuard, badRequest, safetyError, readJson } from "@/app/api/authority/_lib";
import { authorityTablesReady } from "@/lib/authority/db";
import { createDraft } from "@/lib/authority/pr/service";

export const dynamic = "force-dynamic";

const draftSchema = z.object({
  expertiseSummary: z.string().min(1).max(500),
  subject: z.string().min(1).max(120),
  bodyText: z.string().max(8000).optional(),
  guidelinesChecked: z.boolean().optional(),
  audienceFit: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const gate = await authorityGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await authorityTablesReady())) {
    return Response.json({ error: "Authority tables not provisioned yet." }, { status: 503 });
  }
  const parsed = draftSchema.safeParse(await readJson(req));
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { id } = await params;
    const result = await createDraft({
      workspaceId: gate.workspaceId,
      opportunityId: id,
      actor: gate.userId,
      draft: parsed.data,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
