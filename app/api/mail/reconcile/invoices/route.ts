// Marketr — cost reconciliation: manual invoice import + invoice listing.
//
// Invoices are stored as MailWebhookEvent rows with provider =
// "manual-invoice" (no schema change; the payload carries the invoice).
// The reconcile report picks them up automatically by scope.
//
// GET  /api/mail/reconcile/invoices?campaignId=<id>|?month=YYYY-MM → invoices
// POST /api/mail/reconcile/invoices (editor+) → import an invoice

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";

export const dynamic = "force-dynamic";

export const INVOICE_PROVIDER = "manual-invoice";

const InvoiceSchema = z.object({
  vendor: z.string().trim().min(1).max(120),
  invoiceNo: z.string().trim().max(80).optional(),
  date: z.string().trim().optional(),
  scopeType: z.enum(["campaign", "month"]),
  campaignId: z.string().trim().min(1).optional(),
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, 'month must be "YYYY-MM"')
    .optional(),
  totalCents: z.number().int().min(0),
  lines: z
    .array(z.object({ label: z.string().trim().min(1).max(160), cents: z.number().int().min(0) }))
    .max(100)
    .optional(),
  notes: z.string().trim().max(500).optional(),
});

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const campaignId = url.searchParams.get("campaignId");
    const month = url.searchParams.get("month");
    const rows = await prisma.mailWebhookEvent.findMany({
      where: { workspaceId: workspace.id, provider: INVOICE_PROVIDER },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const invoices = rows
      .map((r) => ({ row: r, p: (r.payload ?? {}) as Record<string, unknown> }))
      .filter(({ p }) => p.kind === "invoice")
      .filter(({ p }) => {
        const sc = p.scope as { type?: string; campaignId?: string; month?: string } | undefined;
        if (campaignId) return sc?.type === "campaign" && sc.campaignId === campaignId;
        if (month) return sc?.type === "month" && sc.month === month;
        return true;
      })
      .map(({ row, p }) => ({
        id: row.id,
        eventId: row.eventId,
        vendor: p.vendor,
        invoiceNo: p.invoiceNo,
        date: p.date,
        scope: p.scope,
        totalCents: p.totalCents,
        lines: p.lines,
        notes: p.notes,
        createdAt: row.createdAt,
      }));
    return Response.json({ invoices });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = InvoiceSchema.parse(await readJson(req));
    if (body.scopeType === "campaign" && !body.campaignId) {
      return Response.json({ error: "campaignId is required for campaign scope." }, { status: 400 });
    }
    if (body.scopeType === "month" && !body.month) {
      return Response.json({ error: "month is required for month scope." }, { status: 400 });
    }
    if (body.campaignId) {
      const campaign = await prisma.mailCampaign.findFirst({
        where: { id: body.campaignId, workspaceId: workspace.id },
        select: { id: true },
      });
      if (!campaign) return Response.json({ error: "Mail campaign not found" }, { status: 404 });
    }
    let date: string | null = null;
    if (body.date) {
      const d = new Date(body.date);
      if (Number.isNaN(d.getTime())) return Response.json({ error: "Invalid date." }, { status: 400 });
      date = d.toISOString().slice(0, 10);
    }
    const eventId = `inv-${randomBytes(6).toString("hex")}`;
    const row = await prisma.mailWebhookEvent.create({
      data: {
        workspaceId: workspace.id,
        provider: INVOICE_PROVIDER,
        eventId,
        eventType: "invoice.imported",
        payload: {
          kind: "invoice",
          vendor: body.vendor,
          invoiceNo: body.invoiceNo ?? null,
          date,
          scope:
            body.scopeType === "campaign"
              ? { type: "campaign", campaignId: body.campaignId }
              : { type: "month", month: body.month },
          totalCents: body.totalCents,
          lines: body.lines ?? [],
          notes: body.notes ?? null,
          importedBy: user.id,
        },
        processedAt: new Date(),
      },
    });
    return Response.json({ invoice: { id: row.id, eventId: row.eventId } }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
