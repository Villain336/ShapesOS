// Marketr — Wave 2 Insurance slice 4: renewals API.
// GET /api/insurance/renewals[?alert=critical|warning|info] — list the
// workspace's renewals with their remarket status, premium deltas, and the
// linked remarket submission + quotes (so the UI can show delta flags before
// any renewal approval). Workspace-scoped.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace } from "@/lib/enrichment/guard";
import { toRenewalRecord } from "@/lib/insurance/renewals";
import {
  serializeRenewal,
  renewalErrorResponse,
} from "./_shared";

export const dynamic = "force-dynamic";

const AlertFilter = z.enum(["none", "info", "warning", "critical"]);

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const { searchParams } = new URL(req.url);
    const alertRaw = searchParams.get("alert");
    const alert = alertRaw ? AlertFilter.parse(alertRaw) : undefined;

    const rows = await prisma.insuranceRenewal.findMany({
      where: { workspaceId: workspace.id },
      include: {
        policy: { include: { carrier: { select: { name: true } } } },
        submissions: {
          include: { quotes: { orderBy: { createdAt: "asc" } } },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { renewalDate: "asc" },
    });

    const renewals = rows.map((row) => {
      const record = toRenewalRecord(row);
      const serialized = serializeRenewal(record);
      const submission = row.submissions[0] ?? null;
      return {
        ...serialized,
        submission: submission
          ? {
              id: submission.id,
              status: submission.status,
              vendorRef: submission.vendorRef,
              quotes: submission.quotes.map((q) => ({
                id: q.id,
                carrierName: q.carrierName,
                quotedPremiumCents: q.quotedPremiumCents,
                limitPerOccurrenceCents: q.limitPerOccurrenceCents,
                limitAggregateCents: q.limitAggregateCents,
                status: q.status,
              })),
            }
          : null,
      };
    });

    return Response.json({
      renewals: alert
        ? renewals.filter((r) => r.alertLevel === alert)
        : renewals,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        {
          error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        { status: 400 },
      );
    }
    return renewalErrorResponse(e);
  }
}
