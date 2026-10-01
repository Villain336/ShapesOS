// Marketr — Legal/Compliance slice 5 API.
// GET /api/legal/digital-properties — the tenant's registered digital
// properties (websites/apps) with open-finding counts.
// POST /api/legal/digital-properties — register a property (editor).
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import {
  LEGAL_DISCLAIMER,
  LegalError,
} from "@/lib/legal/types";
import type { DigitalPropertyKind } from "@/lib/legal/digital";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaLegalStore(prisma);
    const properties = await store.listDigitalProperties(workspace.id);
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, properties });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      name?: unknown;
      url?: unknown;
      kind?: unknown;
      notes?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    const property = await store.createDigitalProperty(workspace.id, {
      name: typeof body.name === "string" ? body.name : "",
      url: typeof body.url === "string" ? body.url : null,
      kind: body.kind as DigitalPropertyKind,
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    return Response.json(
      { disclaimer: LEGAL_DISCLAIMER, property },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof LegalError) {
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status: 400 },
      );
    }
    return httpErrorResponse(e);
  }
}
