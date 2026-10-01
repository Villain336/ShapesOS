// Marketr — Legal/Compliance slice 1 API.
// GET /api/legal/templates — all seed obligation templates (read-only).
// POST /api/legal/seed — idempotent seed of the obligation templates
// (editor role). Coverage expands as data: new industries/jurisdictions are
// new rows, never code changes.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER } from "@/lib/legal/types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    void workspace;
    const store = new PrismaLegalStore(prisma);
    const templates = await store.listTemplates();
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, templates });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST() {
  try {
    await guardWorkspace({ editor: true });
    const store = new PrismaLegalStore(prisma);
    const { seeded } = await store.seedTemplates();
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, seeded });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
