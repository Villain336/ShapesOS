// Marketr — Legal/Compliance slice 5 API.
// GET /api/legal/digital-properties/[id]/findings — findings for one property.
// POST /api/legal/digital-properties/[id]/findings — record one finding by
// hand (body.finding, source manual_import) OR import a DigitalScan
// (body.scan — self_assessment / manual_import only; hullcheck_engine is
// rejected until the real scan engine is connected). Editor.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import type {
  DigitalFindingSeverity,
  HullcheckLayer,
} from "@/lib/legal/digital";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaLegalStore(prisma);
    const findings = await store.listDigitalFindings(workspace.id, id);
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, findings });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_PROPERTY" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as {
      finding?: {
        itemKey?: unknown;
        hullcheckLayer?: unknown;
        title?: unknown;
        plainEnglishSummary?: unknown;
        severity?: unknown;
        obligationKey?: unknown;
      };
      scan?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    if (body.scan !== undefined) {
      const { imported } = await store.importDigitalScan(workspace.id, body.scan as never);
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, imported },
        { status: 201 },
      );
    }
    const f = body.finding ?? {};
    const finding = await store.createDigitalFinding(workspace.id, id, {
      itemKey: typeof f.itemKey === "string" ? f.itemKey : null,
      hullcheckLayer: f.hullcheckLayer as HullcheckLayer,
      title: typeof f.title === "string" ? f.title : "",
      plainEnglishSummary:
        typeof f.plainEnglishSummary === "string" ? f.plainEnglishSummary : "",
      severity: f.severity as DigitalFindingSeverity,
      obligationKey: typeof f.obligationKey === "string" ? f.obligationKey : null,
    });
    return Response.json(
      { disclaimer: LEGAL_DISCLAIMER, finding },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof LegalError) {
      const status =
        e.code === "UNKNOWN_PROPERTY" || e.code === "UNKNOWN_FINDING" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}
