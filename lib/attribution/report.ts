// Marketr — Revenue attribution (C2): report data assembly.
//
// One place builds the inputs for lib/attribution/models.ts from the DB so
// every API route (summary / channels / campaigns / content / timeline)
// computes from identical, tenant-scoped data.
//
// Window semantics (v1, documented):
// - Touches are filtered to occurredAt ∈ [from, to] (open-ended when absent).
// - A won lead contributes revenue when it has ≥1 touch in the window.
// - Won leads with no touches in the window land in
//   untouchedRevenueCents (the measurement blind spot), not in any channel.
// - Spend rows count when their period overlaps the window.

import { prisma } from "@/lib/prisma";
import { leadRevenueCents } from "./revenue";
import { computeReport, computeContentReport, type ModelTouch, type AttributionModel } from "./models";

export interface ReportWindow {
  from?: Date;
  to?: Date;
  pipelineId?: string;
}

export async function getReportData(workspaceId: string, window: ReportWindow = {}) {
  const touchWhere = {
    workspaceId,
    ...(window.from || window.to
      ? { occurredAt: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } }
      : {}),
    ...(window.pipelineId ? { lead: { pipelineId: window.pipelineId } } : {}),
  };
  const touches = await prisma.attributionTouch.findMany({
    where: touchWhere,
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 20000,
  });

  const leadIds = [...new Set(touches.map((t) => t.leadId))];
  const leads = leadIds.length
    ? await prisma.lead.findMany({
        where: { id: { in: leadIds }, workspaceId },
        select: { id: true, stage: true, valueCents: true },
      })
    : [];
  const revenueByLead = new Map<string, number>();
  for (const l of leads) {
    const r = leadRevenueCents(l);
    if (r > 0) revenueByLead.set(l.id, r);
  }

  // Won leads with no touches in the window (blind spot). Scoped to the same
  // pipeline filter so the numbers reconcile with the touched set.
  const untouched = await prisma.lead.findMany({
    where: {
      workspaceId,
      stage: "won",
      ...(window.pipelineId ? { pipelineId: window.pipelineId } : {}),
      id: { notIn: leadIds },
    },
    select: { valueCents: true },
    take: 20000,
  });
  const untouchedRevenueCents = untouched.reduce((s, l) => s + Math.max(0, l.valueCents ?? 0), 0);

  const spend = await prisma.attributionSpend.findMany({
    where: {
      workspaceId,
      ...(window.to ? { periodStart: { lte: window.to } } : {}),
      ...(window.from ? { periodEnd: { gte: window.from } } : {}),
    },
    take: 5000,
  });
  // Overlap dedupe: rows for the same (channel, campaign) whose periods
  // overlap are the same money entered twice (e.g. monthly rollup + a
  // re-entered invoice). Keep the earliest row, drop the rest, so spend is
  // never double-counted. Different campaigns (or channel-level vs
  // campaign-level rows) are independent and always sum.
  const dedupedSpend: typeof spend = [];
  const byKey = new Map<string, typeof spend>();
  for (const s of spend) {
    const k = `${s.channel}\n${s.campaign ?? ""}`;
    const list = byKey.get(k) ?? [];
    list.push(s);
    byKey.set(k, list);
  }
  for (const rows of byKey.values()) {
    rows.sort(
      (a, b) => a.periodStart.getTime() - b.periodStart.getTime() ||
        a.periodEnd.getTime() - b.periodEnd.getTime(),
    );
    const kept: typeof rows = [];
    for (const r of rows) {
      const overlaps = kept.some(
        (k) => r.periodStart <= k.periodEnd && k.periodStart <= r.periodEnd,
      );
      if (!overlaps) kept.push(r);
    }
    dedupedSpend.push(...kept);
  }
  const spendByChannel = new Map<string, number>();
  const spendByCampaign = new Map<string, number>();
  for (const s of dedupedSpend) {
    spendByChannel.set(s.channel, (spendByChannel.get(s.channel) ?? 0) + s.amountCents);
    if (s.campaign) {
      const k = `${s.channel}::${s.campaign}`;
      spendByCampaign.set(k, (spendByCampaign.get(k) ?? 0) + s.amountCents);
    }
  }

  const modelTouches: ModelTouch[] = touches.map((t) => ({
    id: t.id,
    leadId: t.leadId,
    channel: t.channel,
    campaign: t.campaign,
    contentId: t.contentId,
    occurredAt: t.occurredAt,
  }));

  return { modelTouches, revenueByLead, spendByChannel, spendByCampaign, untouchedRevenueCents, spend };
}

export async function getAttributionReport(
  workspaceId: string,
  window: ReportWindow = {},
) {
  const data = await getReportData(workspaceId, window);
  return {
    report: computeReport({
      touches: data.modelTouches,
      revenueByLead: data.revenueByLead,
      spendByChannel: data.spendByChannel,
      spendByCampaign: data.spendByCampaign,
      untouchedRevenueCents: data.untouchedRevenueCents,
    }),
    window,
  };
}

export async function getContentReport(
  workspaceId: string,
  window: ReportWindow,
  model: AttributionModel,
) {
  const data = await getReportData(workspaceId, window);
  const items = computeContentReport(data.modelTouches, data.revenueByLead, model);
  // Enrich with the linked page (workspace-verified via the project).
  const contentIds = [...new Set(items.map((i) => i.contentId))];
  const pages = contentIds.length
    ? await prisma.contentItem.findMany({
        where: { id: { in: contentIds }, project: { workspaceId } },
        select: { id: true, publishedUrl: true, keyword: { select: { phrase: true } } },
      })
    : [];
  const pageById = new Map(pages.map((p) => [p.id, p]));
  return items.map((i) => ({
    ...i,
    publishedUrl: pageById.get(i.contentId)?.publishedUrl ?? null,
    keywordPhrase: pageById.get(i.contentId)?.keyword?.phrase ?? null,
  }));
}

/** Parse + validate the shared report query params (from/to/pipelineId). */
export async function resolveWindow(
  workspaceId: string,
  sp: URLSearchParams,
): Promise<{ ok: true; window: ReportWindow } | { ok: false; error: string }> {
  const window: ReportWindow = {};
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    const d = new Date(from);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid from date" };
    window.from = d;
  }
  if (to) {
    const d = new Date(to);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid to date" };
    window.to = d;
  }
  if (window.from && window.to && window.from > window.to) {
    return { ok: false, error: "from must be <= to" };
  }
  const pipelineId = sp.get("pipelineId");
  if (pipelineId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, workspaceId },
      select: { id: true },
    });
    if (!pipeline) return { ok: false, error: "Pipeline not found" };
    window.pipelineId = pipelineId;
  }
  return { ok: true, window };
}
