// Marketr — Phase 8 G1: Business Graph substrate types (SPEC-PHASE8.md §2 G1).
//
// The substrate is read/compute only — it never touches spend (§3.1 money
// rules are structural). Every node/edge carries as_of + source freshness
// labels; the UI must never imply real-time where the platform only offers
// daily pulls.

import type { GraphEntityType } from "@prisma/client";

/** All 19 entity types from spec §4. */
export const ENTITY_TYPES: GraphEntityType[] = [
  "customer",
  "competitor",
  "product",
  "service",
  "price",
  "brand",
  "employee",
  "location",
  "campaign_ref",
  "review",
  "website",
  "crm_record",
  "creative_asset",
  "keyword",
  "content",
  "channel",
  "offer",
  "audience",
  "landing_page",
  "form_cta",
];

/** Edge types used by the projection + ER layers. Free text in the DB so
 *  new relationship kinds never need a migration. */
export const EDGE_TYPES = [
  "WORKS_AT", // employee -> brand
  "COMPETES_WITH", // brand -> competitor
  "RAN_ON", // campaign_ref -> channel
  "TARGETS", // campaign_ref/content -> audience | keyword
  "VARIANT_OF", // creative_asset -> creative_asset
  "SAME_AS", // node -> node (reversible merge provenance)
  "NOT_SAME", // node -> node (rejected merge — negative matcher signal)
  "HAS_PRICE", // product/service -> price
  "MENTIONS", // review/content -> brand|product|competitor
  "LOCATED_AT", // brand/location hierarchy
  "REVIEWED", // review -> product|service|location
  "PUBLISHED_ON", // content -> channel|website
  "LINKS_TO", // landing_page/form_cta -> website|offer
  "OWNS", // brand -> website|product|service
  "SUPERSEDES", // edge-era links for contradictions (B9)
  "DERIVED_FROM", // node -> fact lineage helper
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Deterministic dedupe key per entity type (spec §2 G1). */
export function dedupeKeyFor(
  entityType: GraphEntityType,
  core: Record<string, unknown>,
): string {
  const norm = (v: unknown) =>
    String(v ?? "").trim().toLowerCase();
  switch (entityType) {
    case "customer":
    case "employee":
      return norm(core.email) || norm(core.phone) || norm(core.name);
    case "competitor":
    case "website":
    case "brand":
      return norm(core.domain) || norm(core.name);
    case "product":
    case "service":
      return norm(core.sku) || norm(core.url) || norm(core.name);
    case "price":
      return norm(core.sku ?? core.productRef) || norm(core.label);
    case "location":
      return (
        norm(core.placeId) ||
        [core.street, core.city, core.region, core.postal].map(norm).filter(Boolean).join("|") ||
        norm(core.name)
      );
    case "review":
      return norm(core.externalId) || norm(core.url) || `${norm(core.author)}|${norm(core.publishedAt)}`;
    case "campaign_ref":
      return norm(core.platformRef) || norm(core.utmCampaign) || norm(core.name);
    case "crm_record":
      return norm(core.externalId) || norm(core.email) || norm(core.name);
    case "creative_asset":
      return norm(core.contentHash) || norm(core.url) || norm(core.name);
    case "keyword":
      return norm(core.term);
    case "content":
      return norm(core.url) || norm(core.externalId) || norm(core.title);
    case "channel":
      return norm(core.platform) || norm(core.name);
    case "offer":
      return norm(core.code) || norm(core.name);
    case "audience":
      return norm(core.externalId) || norm(core.name);
    case "landing_page":
      return norm(core.url) || norm(core.slug) || norm(core.name);
    case "form_cta":
      return norm(core.externalId) || norm(core.selector) || norm(core.name);
  }
}

/** Canonical node key: "<entityType>:<normalized dedupe key>". */
export function canonicalKeyFor(
  entityType: GraphEntityType,
  core: Record<string, unknown>,
): string {
  return `${entityType}:${dedupeKeyFor(entityType, core)}`;
}

/** Parse an entity_ref ("customer:email:amy@x.com") into type + canonical key.
 *  Refs of the form "type:key..." map straight to the canonical key; bare
 *  "type:raw" refs are normalized through the same path. */
export function parseEntityRef(entityRef: string): {
  entityType: GraphEntityType;
  canonicalKey: string;
} {
  const [type, ...rest] = entityRef.split(":");
  const entityType = (ENTITY_TYPES as string[]).includes(type)
    ? (type as GraphEntityType)
    : ("crm_record" as GraphEntityType);
  const raw = rest.join(":").trim().toLowerCase();
  return { entityType, canonicalKey: `${entityType}:${raw}` };
}

/** Fact payload shape. `relationships` drives edge projection; everything
 *  else lands in node core/properties. */
export interface FactRelationships {
  to: string; // entity_ref of the target
  edgeType: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  validAt?: string; // ISO; defaults to the fact's observedAt
}

export interface FactPayload {
  displayName?: string;
  core?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  relationships?: FactRelationships[];
  [k: string]: unknown;
}

/** Freshness label contract (spec §2 G1): never imply real-time. */
export type FreshnessBucket = "fresh" | "aging" | "stale" | "unknown";
export interface Freshness {
  asOf: Date;
  source: string;
  label: string;
  bucket: FreshnessBucket;
}

/** ER matcher signal — one piece of evidence for/against a merge. */
export interface MatcherSignal {
  matcher: string; // "email_exact" | "phone_exact" | "domain_exact" | "sku_exact" | "name_trgm" | ...
  field: string;
  valueA: unknown;
  valueB: unknown;
  weight: number; // +1 strong match … -1 strong mismatch
  detail?: string;
}
