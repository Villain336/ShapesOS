// Marketr — Legal/Compliance slice 5 API.
// GET /api/legal/digital-properties/[id]/assess — the self-assessment
// checklist for this property's kind (the v1 "scanner": your own answers).
// POST /api/legal/digital-properties/[id]/assess — submit answers
// ({ answers: { itemKey: "yes" | "no" | "unsure" } }); gaps become findings
// (source self_assessment), replacing the previous open self-assessment
// findings. Editor.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import {
  assessmentChecklistForKind,
  type DigitalPropertyKind,
  type SelfAssessmentAnswer,
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
    const property = await store.getDigitalProperty(workspace.id, id);
    if (!property) {
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: `[UNKNOWN_PROPERTY] No digital property: ${id}` },
        { status: 404 },
      );
    }
    const checklist = assessmentChecklistForKind(property.kind as DigitalPropertyKind);
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      property: { id: property.id, name: property.name, kind: property.kind },
      checklist,
    });
  } catch (e) {
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
      answers?: Record<string, SelfAssessmentAnswer>;
    };
    if (typeof body.answers !== "object" || body.answers === null) {
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: "[INVALID_ANSWERS] answers is required." },
        { status: 400 },
      );
    }
    const store = new PrismaLegalStore(prisma);
    const { created, gapCount } = await store.recordSelfAssessment(
      workspace.id,
      id,
      body.answers,
    );
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      gapCount,
      findings: created,
    });
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
