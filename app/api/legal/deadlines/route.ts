// Marketr — Legal/Compliance slice 2 API.
// GET /api/legal/deadlines — the tenant's deadlines with computed escalation
// tiers, plus open obligations that still need a due date ("date needed").
// POST /api/legal/deadlines — tenant sets/confirms the due date for one
// obligation (editor). The date must come from the tenant's request — the
// API never invents one.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import {
  LEGAL_DISCLAIMER,
  LegalError,
} from "@/lib/legal/types";
import type { DeadlineRecurrence } from "@/lib/legal/deadlines";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaLegalStore(prisma);
    const [deadlines, obligations] = await Promise.all([
      store.listDeadlines(workspace.id),
      store.listObligations(workspace.id),
    ]);
    const withOpenDeadline = new Set(
      deadlines.filter((d) => d.status === "open").map((d) => d.templateKey),
    );
    // Obligations the tenant owns but has not put on the calendar yet.
    const needsDate = obligations
      .filter((o) => o.status === "open" && !withOpenDeadline.has(o.key))
      .map((o) => ({
        templateKey: o.key,
        title: o.title,
        category: o.category,
        renewalCadence: o.renewalCadence,
      }));
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      deadlines,
      needsDate,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      templateKey?: unknown;
      dueDate?: unknown;
      recurrence?: unknown;
      note?: unknown;
    };
    if (typeof body.templateKey !== "string" || !body.templateKey.trim()) {
      throw new LegalError("INVALID_TEMPLATE", "templateKey is required.");
    }
    const store = new PrismaLegalStore(prisma);
    const deadline = await store.upsertDeadline(
      workspace.id,
      body.templateKey,
      {
        dueDate:
          body.dueDate === undefined || body.dueDate === null
            ? null
            : typeof body.dueDate === "string"
              ? body.dueDate
              : undefined,
        recurrence:
          typeof body.recurrence === "string"
            ? (body.recurrence as DeadlineRecurrence)
            : undefined,
        note: typeof body.note === "string" ? body.note : null,
      },
    );
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, deadline });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_TEMPLATE" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}
