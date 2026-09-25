// Marketr — Phase 7 F2: trigger-signal ingestion.
//
// Signals flag winning creative from Phases 2–6 data (SPEC §2/F2):
//   attribution_revenue — Phase 2 C2: revenue-influenced content
//   qr_scan_rate        — Phase 5: high QR/pURL scan rates
//   aeo_lift            — Phase 6: high co-occurrence-lift AEO sources
//   mail_response       — Phase 4: winning direct-mail response rates
//
// Every reader sits behind the SignalReader interface. Real readers query the
// repo's actual tables; where the schema is ambiguous the reader is marked
// "fake" and says so in its detail — it never invents signal semantics.

import { prisma } from "@/lib/prisma";
import { createId } from "@/lib/media/ids";
import {
  type ChannelName, type RecyclingSignal, type TriggerSignalKind, type SignalSource,
} from "./types";
import { getContentReport } from "@/lib/attribution/report";

export interface SignalReadOpts {
  /** Lookback window. Defaults: 30 days. */
  since?: Date;
  /** Per-kind minimum metric to flag. Defaults in DEFAULT_THRESHOLDS. */
  thresholds?: Partial<Record<TriggerSignalKind, number>>;
  /** Force fixture readers (UI preview / battery). */
  fake?: boolean;
  now?: Date;
}

export interface SignalReader {
  kind: TriggerSignalKind;
  source: SignalSource;
  describe(): string;
  read(workspaceId: string, opts: SignalReadOpts): Promise<RecyclingSignal[]>;
}

export const DEFAULT_THRESHOLDS: Record<TriggerSignalKind, number> = {
  attribution_revenue: 50_000, // ≥ $500 revenue-influenced (cents)
  qr_scan_rate: 2,             // ≥ 2 scans/day average
  aeo_lift: 0.25,              // ≥ 25% co-occurrence lift
  mail_response: 0.02,         // ≥ 2% QR-engagement response proxy
};

const WINDOW_MS = 30 * 24 * 3600_000;

function thresholdFor(opts: SignalReadOpts, kind: TriggerSignalKind): number {
  return opts.thresholds?.[kind] ?? DEFAULT_THRESHOLDS[kind];
}

function sig(partial: Omit<RecyclingSignal, "id" | "observedAt">, now: Date): RecyclingSignal {
  return {
    id: createId(),
    observedAt: now.toISOString(),
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Real readers (repo tables)
// ---------------------------------------------------------------------------

/** Phase 2 C2 — revenue-influenced content (lib/attribution/report). */
export const attributionRevenueReader: SignalReader = {
  kind: "attribution_revenue",
  source: "real",
  describe() {
    return "Phase 2 C2 attribution: content items with model-attributed revenue ≥ threshold (30d window).";
  },
  async read(workspaceId, opts) {
    const now = opts.now ?? new Date();
    const from = opts.since ?? new Date(now.getTime() - WINDOW_MS);
    const threshold = thresholdFor(opts, "attribution_revenue");
    let items: { contentId: string; revenueCents: number; publishedUrl?: string | null }[];
    try {
      items = await getContentReport(workspaceId, { from, to: now }, "linear");
    } catch {
      return []; // attribution tables unhealthy → no signals, not fake signals
    }
    return items
      .filter((i) => i.revenueCents >= threshold)
      .map((i) =>
        sig({
          workspaceId,
          kind: "attribution_revenue",
          sourceAssetId: `content_item:${i.contentId}`,
          sourceChannel: "landing" as ChannelName,
          metricValue: i.revenueCents,
          metricUnit: "revenue_cents",
          source: "real",
          detail: { model: "linear", publishedUrl: i.publishedUrl ?? null, windowDays: 30 },
        }, now),
      );
  },
};

/** Phase 5 — high QR/pURL scan rates (tracking_links + scans_count). */
export const qrScanRateReader: SignalReader = {
  kind: "qr_scan_rate",
  source: "real",
  describe() {
    return "Phase 5 QR/pURL engine: tracking links whose average scans/day ≥ threshold over their lifetime.";
  },
  async read(workspaceId, opts) {
    const now = opts.now ?? new Date();
    const threshold = thresholdFor(opts, "qr_scan_rate");
    let links: { id: string; slug: string; placementRef: string; scansCount: number; createdAt: Date; destinationUrl: string }[];
    try {
      links = await prisma.trackingLink.findMany({
        where: { workspaceId, status: "active" },
        select: { id: true, slug: true, placementRef: true, scansCount: true, createdAt: true, destinationUrl: true },
        orderBy: { scansCount: "desc" },
        take: 100,
      });
    } catch {
      return [];
    }
    return links
      .map((l) => {
        const days = Math.max(1, (now.getTime() - l.createdAt.getTime()) / 86400_000);
        return { link: l, rate: l.scansCount / days };
      })
      .filter(({ rate }) => rate >= threshold)
      .map(({ link, rate }) =>
        sig({
          workspaceId,
          kind: "qr_scan_rate",
          sourceAssetId: `tracking_link:${link.id}`,
          sourceChannel: "dooh" as ChannelName,
          metricValue: Math.round(rate * 100) / 100,
          metricUnit: "scans_per_day",
          source: "real",
          detail: {
            slug: link.slug,
            placementRef: link.placementRef,
            totalScans: link.scansCount,
            destinationUrl: link.destinationUrl,
            // The scan rate is measured on the QR placement; the "winner" is
            // the creative behind it. The brief's source snapshot should name it.
            note: "scan rate measured at the QR placement; attribute to the creative behind the QR when briefing",
          },
        }, now),
      );
  },
};

/** Phase 6 — high co-occurrence-lift AEO sources (aeo_source_impact). */
export const aeoLiftReader: SignalReader = {
  kind: "aeo_lift",
  source: "real",
  describe() {
    return "Phase 6 AEO: cited domains with co-occurrence lift ≥ threshold — the content engines lift most.";
  },
  async read(workspaceId, opts) {
    const now = opts.now ?? new Date();
    const threshold = thresholdFor(opts, "aeo_lift");
    let rows: { engine: string; domain: string; cooccurrenceLift: number; citationFrequency: number }[];
    try {
      rows = await prisma.aeoSourceImpact.findMany({
        where: { workspaceId, cooccurrenceLift: { gte: threshold } },
        select: { engine: true, domain: true, cooccurrenceLift: true, citationFrequency: true },
        orderBy: { cooccurrenceLift: "desc" },
        take: 50,
      });
    } catch {
      return [];
    }
    return rows.map((r) =>
      sig({
        workspaceId,
        kind: "aeo_lift",
        sourceAssetId: `aeo:${r.engine}:${r.domain}`,
        sourceChannel: "landing" as ChannelName,
        metricValue: Math.round(r.cooccurrenceLift * 1000) / 1000,
        metricUnit: "cooccurrence_lift",
        source: "real",
        detail: {
          engine: r.engine,
          domain: r.domain,
          citationFrequency: r.citationFrequency,
          note: "signal is at domain level; the winning asset is the cited page on that domain",
        },
      }, now),
    );
  },
};

/**
 * Phase 4 — winning direct-mail response rates.
 *
 * A "response" is measured through the piece's QR: mail pieces carry a
 * qrSlug (MailPiece.qrSlug); where that slug maps to a Phase 5 tracking
 * link, scan engagement is the deterministic response proxy. Campaigns
 * whose scanned-piece rate ≥ threshold flag.
 *
 * Marked "real" because it reads the repo's actual mail + tracking tables;
 * detail.responseProxy says exactly what the number is.
 */
export const mailResponseReader: SignalReader = {
  kind: "mail_response",
  source: "real",
  describe() {
    return "Phase 4 mail × Phase 5 QR: completed campaigns with piece-QR scan-engagement rate ≥ threshold.";
  },
  async read(workspaceId, opts) {
    const now = opts.now ?? new Date();
    const threshold = thresholdFor(opts, "mail_response");
    let campaigns: { id: string; name: string; creativeId: string | null }[];
    try {
      campaigns = await prisma.mailCampaign.findMany({
        where: { workspaceId, status: { in: ["complete", "sending"] } },
        select: { id: true, name: true, creativeId: true },
        take: 50,
      });
    } catch {
      return [];
    }
    const out: RecyclingSignal[] = [];
    for (const c of campaigns) {
      try {
        const pieces = await prisma.mailPiece.findMany({
          where: { campaignId: c.id, status: { in: ["delivered", "sent"] }, qrSlug: { not: null } },
          select: { qrSlug: true },
          take: 2000,
        });
        const slugs = pieces.map((p) => p.qrSlug!).filter(Boolean);
        if (slugs.length === 0) continue;
        const links = await prisma.trackingLink.findMany({
          where: { workspaceId, slug: { in: slugs } },
          select: { scansCount: true },
        });
        const engaged = links.filter((l) => l.scansCount > 0).length;
        const rate = engaged / slugs.length;
        if (rate >= threshold) {
          out.push(
            sig({
              workspaceId,
              kind: "mail_response",
              sourceAssetId: `mail_campaign:${c.id}`,
              sourceChannel: "mail" as ChannelName,
              metricValue: Math.round(rate * 10000) / 10000,
              metricUnit: "response_rate",
              source: "real",
              detail: {
                campaignName: c.name,
                creativeId: c.creativeId,
                responseProxy: "piece_qr_scan_engagement",
                piecesWithQr: slugs.length,
                piecesEngaged: engaged,
                note: "response = piece QR scanned (deterministic slice). True conversion response needs CRM/order join — not claimed here.",
              },
            }, now),
          );
        }
      } catch {
        continue; // one unhealthy campaign must not kill the whole scan
      }
    }
    return out.sort((a, b) => b.metricValue - a.metricValue);
  },
};

// ---------------------------------------------------------------------------
// Fake reader (fixtures / UI preview — loudly labeled)
// ---------------------------------------------------------------------------

const FIXTURE_SIGNALS: Array<Omit<RecyclingSignal, "id" | "workspaceId" | "observedAt">> = [
  {
    kind: "attribution_revenue",
    sourceAssetId: "content_item:fixture_pricing_guide",
    sourceChannel: "landing",
    metricValue: 184_200,
    metricUnit: "revenue_cents",
    source: "fake",
    detail: { fixture: true, note: "fixture — connect real attribution data to replace" },
  },
  {
    kind: "qr_scan_rate",
    sourceAssetId: "tracking_link:fixture_billboard_qr",
    sourceChannel: "dooh",
    metricValue: 14.5,
    metricUnit: "scans_per_day",
    source: "fake",
    detail: { fixture: true, placementRef: "I-40 billboard #7" },
  },
  {
    kind: "aeo_lift",
    sourceAssetId: "aeo:chatgpt:fixture-domain.com",
    sourceChannel: "landing",
    metricValue: 0.62,
    metricUnit: "cooccurrence_lift",
    source: "fake",
    detail: { fixture: true },
  },
  {
    kind: "mail_response",
    sourceAssetId: "mail_campaign:fixture_spring_drop",
    sourceChannel: "mail",
    metricValue: 0.041,
    metricUnit: "response_rate",
    source: "fake",
    detail: { fixture: true, responseProxy: "piece_qr_scan_engagement" },
  },
];

export const fixtureSignalReader: SignalReader = {
  kind: "attribution_revenue",
  source: "fake",
  describe() {
    return "Fixture reader: one labeled fake signal per kind, for UI preview and batteries.";
  },
  async read(workspaceId, opts) {
    const now = opts.now ?? new Date();
    return FIXTURE_SIGNALS
      .filter((f) => f.metricValue >= thresholdFor(opts, f.kind))
      .map((f) => sig({ workspaceId, ...f }, now));
  },
};

export const DEFAULT_READERS: SignalReader[] = [
  attributionRevenueReader,
  qrScanRateReader,
  aeoLiftReader,
  mailResponseReader,
];

/** Collect + dedupe signals across readers (keep the max per kind+asset). */
export async function collectSignals(
  workspaceId: string,
  opts: SignalReadOpts & { readers?: SignalReader[] } = {},
): Promise<RecyclingSignal[]> {
  const readers = opts.fake ? [fixtureSignalReader] : (opts.readers ?? DEFAULT_READERS);
  const batches = await Promise.all(
    readers.map((r) => r.read(workspaceId, opts).catch(() => [] as RecyclingSignal[])),
  );
  const best = new Map<string, RecyclingSignal>();
  for (const s of batches.flat()) {
    const key = `${s.kind}:${s.sourceAssetId}`;
    const cur = best.get(key);
    if (!cur || s.metricValue > cur.metricValue) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => b.metricValue - a.metricValue);
}
