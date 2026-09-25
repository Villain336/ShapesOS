// Marketr — Phase 8 G2: fragment-table registry.
//
// READ-ONLY adapters over the eight fragment tables the campaign object
// links to (link-not-replace: their rows and schemas are never touched).
// Each entry knows how to (a) scope the table to a workspace, (b) extract
// the signals the backfill proposer needs (display name, created date,
// utm_campaign when the fragment carries one), and (c) render the labeled
// metrics the roll-up report needs — with per-fragment provenance.
//
// §3.1 money rule: these adapters read reporting fields (spend reported by
// the platform, mail cost estimates). They create no spending paths.

import type { Prisma } from "@prisma/client";
import {
  CAMPAIGN_STAGES,
  DEFAULT_STAGE_FOR_FRAGMENT,
  LINKED_TYPE_LABELS,
  type CampaignLinkedType,
  type CampaignStageKey,
  type FragmentMetric,
  type FragmentProvenance,
} from "./types";

export interface FragmentSummary {
  linkedType: CampaignLinkedType;
  linkedId: string;
  displayName: string;
  status: string | null;
  createdAt: Date;
  /** Normalised utm_campaign when the fragment carries one (null otherwise). */
  utmCampaign: string | null;
  metrics: FragmentMetric[];
  provenance: FragmentProvenance;
}

/** Canonical workspace-scoped read of one fragment row. Null when missing
 * or not in this workspace. */
export async function readFragment(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  linkedType: CampaignLinkedType,
  linkedId: string,
): Promise<FragmentSummary | null> {
  switch (linkedType) {
    case "mail_campaign": {
      const r = await tx.mailCampaign.findFirst({
        where: { id: linkedId, workspaceId },
      });
      if (!r) return null;
      const cost = r.actualCostCents ?? r.estCostCents ?? null;
      return {
        linkedType, linkedId: r.id,
        displayName: r.name, status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [
          { key: "spend_cents", value: cost, label: "direct-mail cost (actual, else estimate)" },
          { key: "pieces", value: r.pieceCount, label: "mail pieces" },
        ],
        provenance: prov(workspaceId, "mail_campaign", r.id, [
          r.actualCostCents != null ? "actual cost from mail run" : "estimate only — not yet mailed/billed",
        ]),
      };
    }
    case "outreach_campaign": {
      const r = await tx.outreachCampaign.findFirst({
        where: { id: linkedId, workspaceId },
        include: {
          sequences: { select: { id: true } },
          _count: { select: { prospects: true } },
        },
      });
      if (!r) return null;
      const events = r.sequences.length
        ? await tx.outreachEvent.groupBy({
            by: ["event"],
            where: { sequenceId: { in: r.sequences.map((s) => s.id) } },
            _count: { event: true },
          })
        : [];
      const ev = (k: string) => events.find((e) => e.event === k)?._count.event ?? 0;
      return {
        linkedType, linkedId: r.id,
        displayName: r.name, status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [
          { key: "prospects", value: r._count.prospects, label: "prospects in campaign" },
          { key: "sequences", value: r.sequences.length, label: "sequences (depth ladder)" },
          { key: "sends", value: ev("sent"), label: "emails sent (outreach engine)" },
          { key: "opens", value: ev("opened"), label: "opens (outreach tracking pixel)" },
          { key: "clicks", value: ev("clicked"), label: "clicks (outreach tracking)" },
          { key: "replies", value: ev("replied"), label: "replies (outreach)" },
        ],
        provenance: prov(workspaceId, "outreach_campaigns", r.id, [
          "event counts from outreach_events — cold-outreach semantics, not newsletter sends",
        ]),
      };
    }
    case "media_buy": {
      const r = await tx.mediaBuy.findFirst({
        where: { id: linkedId, workspaceId },
      });
      if (!r) return null;
      return {
        linkedType, linkedId: r.id,
        displayName: `Media buy · ${r.platform}${r.platformCampaignRef ? ` (${r.platformCampaignRef})` : ""}`,
        status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [
          { key: "spend_cents", value: r.actualSpendCents ?? null, label: `platform-reported spend (${r.platform}) — null until executed` },
        ],
        provenance: prov(workspaceId, "media_buys", r.id, [
          "spend is platform-reported; the campaign object never reconciles it against CRM revenue",
          r.status === "draft" ? "draft — not executed, no spend" : `status ${r.status}`,
        ]),
      };
    }
    case "ctv_campaign": {
      const r = await tx.ctvCampaign.findFirst({
        where: { id: linkedId, workspaceId },
      });
      if (!r) return null;
      return {
        linkedType, linkedId: r.id,
        displayName: r.name, status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [
          { key: "spend_cents", value: r.budgetCents ?? null, label: `CTV budget (${r.platform})${r.vibeTestMode ? " — test mode, not billed" : ""}` },
        ],
        provenance: prov(workspaceId, "ctv_campaigns", r.id, [
          "budget, not spend — CTV settlement happens off-platform",
          r.vibeTestMode ? "Vibe test mode: no real money moves" : "live platform campaign",
        ]),
      };
    }
    case "newsletter_broadcast": {
      const r = await tx.newsletterBroadcast.findFirst({
        where: { id: linkedId, project: { workspaceId } },
        include: { project: { select: { workspaceId: true } } },
      });
      if (!r) return null;
      const s = (r.stats ?? {}) as Record<string, number>;
      return {
        linkedType, linkedId: r.id,
        displayName: r.subject, status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [
          { key: "sends", value: s.sent ?? null, label: "newsletter sends (Resend)" },
          { key: "opens", value: s.opened ?? null, label: "newsletter opens (best-effort pixel)" },
          { key: "clicks", value: s.clicked ?? null, label: "newsletter clicks (best-effort)" },
        ],
        provenance: prov(workspaceId, "newsletter_broadcasts", r.id, [
          "stats are best-effort provider callbacks — not reconciled",
        ]),
      };
    }
    case "social_post": {
      const r = await tx.socialPost.findFirst({
        where: { id: linkedId, project: { workspaceId } },
        include: { project: { select: { workspaceId: true } } },
      });
      if (!r) return null;
      const content = (r.content ?? {}) as { text?: string; utm?: { campaign?: string } };
      const stats = (r.stats ?? {}) as { totals?: Record<string, number> };
      const totals = stats.totals ?? {};
      return {
        linkedType, linkedId: r.id,
        displayName: (content.text ?? "").slice(0, 80) || "Social post",
        status: r.status, createdAt: r.createdAt,
        utmCampaign: content.utm?.campaign?.trim() || null,
        metrics: [
          { key: "impressions", value: totals.impressions ?? null, label: "impressions (Buffer-cached, per-channel)" },
          { key: "clicks", value: totals.clicks ?? null, label: "clicks (Buffer-cached, per-channel)" },
        ],
        provenance: prov(workspaceId, "social_posts", r.id, [
          "stats are Buffer-cached snapshots, not live platform numbers",
        ]),
      };
    }
    case "experiment": {
      const r = await tx.experiment.findFirst({
        where: { id: linkedId, workspaceId },
      });
      if (!r) return null;
      return {
        linkedType, linkedId: r.id,
        displayName: r.name, status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [
          { key: "verdict", value: r.verdict ?? "undecided", label: "test verdict (honesty-gated)" },
        ],
        provenance: prov(workspaceId, "experiments", r.id, [
          "experiment outcomes only — no spend or revenue attribution here",
        ]),
      };
    }
    case "recycling_brief": {
      const r = await tx.recyclingBrief.findFirst({
        where: { id: linkedId, workspaceId },
      });
      if (!r) return null;
      return {
        linkedType, linkedId: r.id,
        displayName: `Recycling brief · ${r.sourceChannel}`,
        status: r.status, createdAt: r.createdAt,
        utmCampaign: null,
        metrics: [],
        provenance: prov(workspaceId, "recycling_briefs", r.id, [
          `source asset ${r.sourceAssetId} — creative lineage, not performance`,
        ]),
      };
    }
  }
}

function prov(workspaceId: string, table: string, fragmentId: string, notes: string[]): FragmentProvenance {
  return {
    table,
    fragmentId,
    workspaceId,
    fetchedAt: new Date().toISOString(),
    notes,
  };
}

/** Scan all fragment rows in a workspace (for the backfill proposer). */
export async function scanWorkspaceFragments(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<FragmentSummary[]> {
  const out: FragmentSummary[] = [];
  const [mail, outreach, media, ctv, experiments, briefs] = await Promise.all([
    tx.mailCampaign.findMany({ where: { workspaceId }, select: { id: true } }),
    tx.outreachCampaign.findMany({ where: { workspaceId }, select: { id: true } }),
    tx.mediaBuy.findMany({ where: { workspaceId }, select: { id: true } }),
    tx.ctvCampaign.findMany({ where: { workspaceId }, select: { id: true } }),
    tx.experiment.findMany({ where: { workspaceId }, select: { id: true } }),
    tx.recyclingBrief.findMany({ where: { workspaceId }, select: { id: true } }),
  ]);
  const projectScoped = await tx.project.findMany({
    where: { workspaceId },
    select: {
      newsletterBroadcasts: { select: { id: true } },
      socialPosts: { select: { id: true } },
    },
  });
  const jobs: Array<Promise<FragmentSummary | null>> = [];
  for (const r of mail) jobs.push(readFragment(tx, workspaceId, "mail_campaign", r.id));
  for (const r of outreach) jobs.push(readFragment(tx, workspaceId, "outreach_campaign", r.id));
  for (const r of media) jobs.push(readFragment(tx, workspaceId, "media_buy", r.id));
  for (const r of ctv) jobs.push(readFragment(tx, workspaceId, "ctv_campaign", r.id));
  for (const r of experiments) jobs.push(readFragment(tx, workspaceId, "experiment", r.id));
  for (const r of briefs) jobs.push(readFragment(tx, workspaceId, "recycling_brief", r.id));
  for (const p of projectScoped) {
    for (const r of p.newsletterBroadcasts) jobs.push(readFragment(tx, workspaceId, "newsletter_broadcast", r.id));
    for (const r of p.socialPosts) jobs.push(readFragment(tx, workspaceId, "social_post", r.id));
  }
  for (const j of jobs) {
    const f = await j;
    if (f) out.push(f);
  }
  return out;
}

export function defaultStageFor(linkedType: CampaignLinkedType): CampaignStageKey {
  return DEFAULT_STAGE_FOR_FRAGMENT[linkedType];
}

export function stageLabel(key: string): string {
  return key in Object.create(null) ? key : key;
}

export function linkedTypeLabel(t: CampaignLinkedType): string {
  return LINKED_TYPE_LABELS[t];
}

export function stageKeys(): CampaignStageKey[] {
  return [...CAMPAIGN_STAGES];
}
