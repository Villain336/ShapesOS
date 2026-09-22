// Marketr — scheduler event bus (Phase B, W2).
// (Threat model T5: event payload spoofing.)
//
// Five initial sources (spec W2.1). Detectors are stubs in this track — they
// accept injected payloads (editor+ or CRON_SECRET at the API layer) and the
// bus itself is real: zod payload validation, per-source fire conditions,
// workspace/project scoping, trigger lineage for cycle detection, and audit.

import { z } from "zod";

export const EVENT_SOURCES = [
  "rank_drop",
  "new_backlink",
  "connector_error",
  "content_decay",
  "content_published",
] as const;

export type EventSource = (typeof EVENT_SOURCES)[number];

export function isEventSource(s: unknown): s is EventSource {
  return typeof s === "string" && (EVENT_SOURCES as readonly string[]).includes(s);
}

// --- Per-source payload schemas (unknown fields stripped by zod) -------------

const RankDropPayload = z.object({
  domain: z.string().trim().min(1).max(255),
  keyword: z.string().trim().min(1).max(500),
  previousRank: z.number().int().min(1).max(1000),
  currentRank: z.number().int().min(1).max(1000),
});

const NewBacklinkPayload = z.object({
  domain: z.string().trim().min(1).max(255),
  fromUrl: z.string().trim().min(1).max(2000),
  toUrl: z.string().trim().min(1).max(2000),
  domainRating: z.number().int().min(0).max(100).optional(),
});

const ConnectorErrorPayload = z.object({
  connectionId: z.string().trim().min(1).max(120),
  connectorKind: z.string().trim().max(120).optional(),
  error: z.string().trim().min(1).max(200),
  message: z.string().trim().max(1000).optional(),
});

const ContentDecayPayload = z.object({
  url: z.string().trim().min(1).max(2000),
  contentItemId: z.string().trim().max(120).optional(),
  trafficDropPct: z.number().min(0).max(100).optional(),
  decayScore: z.number().min(0).max(100).optional(),
});

const ContentPublishedPayload = z.object({
  url: z.string().trim().min(1).max(2000),
  title: z.string().trim().max(500).optional(),
  contentItemId: z.string().trim().max(120).optional(),
});

const PAYLOAD_SCHEMAS: Record<EventSource, z.ZodTypeAny> = {
  rank_drop: RankDropPayload,
  new_backlink: NewBacklinkPayload,
  connector_error: ConnectorErrorPayload,
  content_decay: ContentDecayPayload,
  content_published: ContentPublishedPayload,
};

export type EventPayload = Record<string, unknown>;

/** Validate a raw payload against the source's schema. Returns stripped payload or null. */
export function validateEventPayload(source: EventSource, raw: unknown): EventPayload | null {
  const parsed = PAYLOAD_SCHEMAS[source].safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data as EventPayload;
}

// --- Per-source config schemas (what the schedule wizard stores) -------------

const RankDropConfig = z.object({
  dropThreshold: z.number().int().min(1).max(100).default(3),
  keyword: z.string().trim().max(500).optional(), // limit to one keyword
});

const DomainFilterConfig = z.object({
  domain: z.string().trim().max(255).optional(),
});

const ConnectionFilterConfig = z.object({
  connectionId: z.string().trim().max(120).optional(),
});

const DecayConfig = z.object({
  minDropPct: z.number().min(0).max(100).default(20),
});

const PublishedConfig = z.object({}).passthrough();

const CONFIG_SCHEMAS: Record<EventSource, z.ZodTypeAny> = {
  rank_drop: RankDropConfig,
  new_backlink: DomainFilterConfig,
  connector_error: ConnectionFilterConfig,
  content_decay: DecayConfig,
  content_published: PublishedConfig,
};

/** Validate + normalize an event config for a source. Null when invalid. */
export function validateEventConfig(source: EventSource, raw: unknown): Record<string, unknown> | null {
  const parsed = CONFIG_SCHEMAS[source].safeParse(raw ?? {});
  if (!parsed.success) return null;
  return parsed.data as Record<string, unknown>;
}

// --- Fire conditions --------------------------------------------------------

/**
 * Does this payload satisfy the schedule's config? E.g. rank_drop fires only
 * when the drop meets the threshold; optional domain/connection filters narrow it.
 */
export function shouldFire(source: EventSource, config: Record<string, unknown>, payload: EventPayload): boolean {
  switch (source) {
    case "rank_drop": {
      const drop = (payload.currentRank as number) - (payload.previousRank as number);
      if (drop < Number(config.dropThreshold ?? 3)) return false;
      if (config.keyword && payload.keyword !== config.keyword) return false;
      return true;
    }
    case "new_backlink": {
      if (config.domain && payload.domain !== config.domain) return false;
      return true;
    }
    case "connector_error": {
      if (config.connectionId && payload.connectionId !== config.connectionId) return false;
      return true;
    }
    case "content_decay": {
      const dropPct = Number(payload.trafficDropPct ?? 100);
      if (dropPct < Number(config.minDropPct ?? 20)) return false;
      return true;
    }
    case "content_published":
      return true;
  }
}

/** Human-readable one-liner for a firing event (used in audit + UI). */
export function describeEvent(source: EventSource, payload: EventPayload): string {
  switch (source) {
    case "rank_drop":
      return `Rank drop: "${payload.keyword}" on ${payload.domain} fell from #${payload.previousRank} to #${payload.currentRank}`;
    case "new_backlink":
      return `New backlink to ${payload.domain} from ${payload.fromUrl}`;
    case "connector_error":
      return `Connector error (${payload.connectorKind ?? "unknown"}): ${payload.error}`;
    case "content_decay":
      return `Content decay flagged for ${payload.url}`;
    case "content_published":
      return `Content published: ${payload.title ?? payload.url}`;
  }
}

/** Public catalog for the schedule wizard (source → label + description). */
export const EVENT_SOURCE_CATALOG: { source: EventSource; label: string; description: string }[] = [
  { source: "rank_drop", label: "Rank drop", description: "A tracked keyword falls more than N positions." },
  { source: "new_backlink", label: "New backlink", description: "A new backlink to the domain is detected." },
  { source: "connector_error", label: "Connector error", description: "A connector sync or refresh fails." },
  { source: "content_decay", label: "Content decay", description: "A page's traffic decay flag is raised." },
  { source: "content_published", label: "Content published", description: "A content item is published." },
];
