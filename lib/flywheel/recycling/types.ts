// Marketr — Phase 7 F2: creative recycling pipeline, domain types.
//
// The recycling pipeline turns winning creative into cross-channel briefs:
// attribution/QR/AEO/mail signals flag a winner → a recycling brief is
// generated (source asset + creative-hash lineage → target channels with
// deterministic variant specs) → a human approves → variants are routed into
// the existing studio approval flows → regenerated assets re-enter per-buy
// creative-hash binding.
//
// Structural invariant (SPEC-PHASE7 §9.9): recycling proposes, humans approve.
// Nothing auto-publishes; nothing enters a buy without its own approval object.
// The status union below deliberately has no "published" state.

import { canonicalize } from "@/lib/media/approvals";
import { sha256Hex } from "@/lib/media/safety";

/** Channels the recycling pipeline understands. */
export type ChannelName =
  | "mail" | "ad" | "social" | "email" | "landing"
  | "video" | "ctv" | "dooh" | "billboard" | "sms";

/** Trigger-signal kinds, one per Phase 2–6 data source (SPEC §2/F2). */
export type TriggerSignalKind =
  | "attribution_revenue" // Phase 2 C2: revenue-influenced content
  | "qr_scan_rate"        // Phase 5: high QR/pURL scan rates
  | "aeo_lift"            // Phase 6: high co-occurrence-lift AEO sources
  | "mail_response";      // Phase 4: winning direct-mail response rates

export type SignalSource = "real" | "fake";

export interface RecyclingSignal {
  id: string;
  workspaceId: string;
  kind: TriggerSignalKind;
  /** Opaque source ref, e.g. "content_item:<id>", "tracking_link:<id>", "mail_campaign:<id>", "aeo:chatgpt:example.com". */
  sourceAssetId: string;
  sourceChannel: ChannelName;
  metricValue: number;
  /** "revenue_cents" | "scans_per_day" | "cooccurrence_lift" | "response_rate" */
  metricUnit: string;
  observedAt: string; // ISO
  /** "real" = read from repo tables; "fake" = fixture/proxy where ambiguous. */
  source: SignalSource;
  detail: Record<string, unknown>;
}

/** Deterministic variant spec for one source→target channel pair. */
export interface CopyDensityCeiling {
  maxWords: number;
  maxLines: number;
}

export interface VariantSpec {
  targetChannel: ChannelName;
  /** e.g. "16:9", "1:1", "9:16", "48:14", "600px-email" */
  aspectRatio: string;
  copyDensityCeiling: CopyDensityCeiling;
  /** Allowed CTA mechanics for the target: "qr" | "purl" | "button" | "platform_cta" | "link_sticker" | "shortlink" | "end_card" | "voice". */
  ctaFormats: string[];
  /** Human-readable deterministic notes (legibility, safe-area, legal). */
  notes: string[];
  /** Supervised LLM may rewrite these copy fields — only when a human
   *  approved the variant. Never body copy, never art direction. */
  supervisedRewrite: { headline: boolean; cta: boolean };
  rulesVersion: string;
}

/** One link in the creative-hash lineage chain. */
export interface LineageEntry {
  /** sha256(canonical(payload)) — tamper-evident. */
  hash: string;
  assetRef: string;
  stage: "source" | "variant" | "regenerated";
  channel: ChannelName;
  at: string; // ISO
}

export type RecyclingBriefStatus = "draft" | "approved" | "regenerating" | "ready";

export interface TriggerSignalRef {
  kind: TriggerSignalKind;
  signalId: string;
  metricValue: number;
  metricUnit: string;
  observedAt: string;
  source: SignalSource;
}

export interface RecyclingBrief {
  id: string;
  workspaceId: string;
  sourceAssetId: string;
  sourceChannel: ChannelName;
  triggerSignal: TriggerSignalRef;
  targetChannels: ChannelName[];
  /** Keyed by target channel. */
  variantSpecs: Record<string, VariantSpec>;
  creativeHashLineage: LineageEntry[];
  status: RecyclingBriefStatus;
  /** Routing receipts into studio approval flows (one per variant). Null until approved. */
  approvalId: string | null;
  studioRouting: StudioRouteReceipt[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Receipt from routing a variant into the studio approval flow. */
export interface StudioRouteReceipt {
  variantChannel: ChannelName;
  /** e.g. "studio_pending:<briefId>:<channel>" — a studio review queue ref, never a publish. */
  studioRef: string;
  receipt: string;
  routedAt: string; // ISO
  routedBy: string;
  /** The fake router marks provenance loudly; a live router would too. */
  provider: "fake" | "live";
}

/** Rewrite provenance — shown in the UI so mocked copy can never be mistaken for real. */
export interface RewriteProvenance {
  provider: "mock" | "live";
  model: string;
  labeled: boolean;
  at: string; // ISO
}

export interface VariantRewrite {
  variantChannel: ChannelName;
  headline: string;
  cta: string;
  provenance: RewriteProvenance;
}

/** Hash a lineage payload (source snapshot or variant spec). */
export function lineageHash(payload: Record<string, unknown>): string {
  return sha256Hex(canonicalize(payload));
}

/** Recompute every lineage hash and confirm the chain is intact.
 *
 *  - source: hash commits to { assetRef, stage, channel, signal }.
 *  - variant: hash commits to { assetRef, stage, channel, spec } — editing a
 *    variant spec after minting breaks the chain (tamper-evident).
 *  - regenerated: the hash is the studio's attestation of the produced
 *    creative bytes; we verify it is a well-formed 64-hex sha256 AND that a
 *    studio routing receipt exists for that channel (no phantom regenerations). */
export function verifyLineage(brief: RecyclingBrief): { ok: true } | { ok: false; brokenAt: number } {
  const routed = new Set(brief.studioRouting.map((r) => r.variantChannel));
  for (let i = 0; i < brief.creativeHashLineage.length; i++) {
    const entry = brief.creativeHashLineage[i];
    if (entry.stage === "source") {
      const expected = lineageHash({
        assetRef: entry.assetRef, stage: entry.stage, channel: entry.channel,
        signal: brief.triggerSignal,
      });
      if (expected !== entry.hash) return { ok: false, brokenAt: i };
    } else if (entry.stage === "variant") {
      const expected = lineageHash({
        assetRef: entry.assetRef, stage: entry.stage, channel: entry.channel,
        spec: brief.variantSpecs[entry.channel] ?? null,
      });
      if (expected !== entry.hash) return { ok: false, brokenAt: i };
    } else {
      if (!/^[0-9a-f]{64}$/.test(entry.hash)) return { ok: false, brokenAt: i };
      if (!routed.has(entry.channel)) return { ok: false, brokenAt: i };
    }
  }
  return { ok: true };
}

export const CHANNELS: ChannelName[] = [
  "mail", "ad", "social", "email", "landing",
  "video", "ctv", "dooh", "billboard", "sms",
];

export function isChannelName(v: string): v is ChannelName {
  return (CHANNELS as string[]).includes(v);
}
