// Marketr — Phase 6 I1 Intelligence Report: shared types.
//
// Hard rule: missing data = labeled partial/unavailable, never fabricated or
// extrapolated. Every audit cites its data source. Report generation is
// human-reviewed before finalizing (status draft → ready).

export type Completeness = "full" | "partial" | "unavailable";

export type AuditId =
  | "company" | "market" | "competitor-map" | "website" | "brand" | "seo"
  | "paid" | "reputation" | "conversion" | "crm" | "content" | "technology";

export const AUDIT_ORDER: AuditId[] = [
  "company", "market", "competitor-map", "website", "brand", "seo",
  "paid", "reputation", "conversion", "crm", "content", "technology",
];

export const AUDIT_NAMES: Record<AuditId, string> = {
  "company": "Company intelligence",
  "market": "Market position",
  "competitor-map": "Competitor map",
  "website": "Website",
  "brand": "Brand",
  "seo": "SEO",
  "paid": "Paid media",
  "reputation": "Reputation",
  "conversion": "Conversion",
  "crm": "CRM",
  "content": "Content",
  "technology": "Technology",
};

export interface AuditFinding {
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  /** The Marketr module/table that produced this finding — never unsourced. */
  dataSource: string;
}

export interface AuditResult {
  id: AuditId;
  name: string;
  /** 0–100, or null when there is no data to score. */
  score: number | null;
  completeness: Completeness;
  findings: AuditFinding[];
  dataSource: string;
  computedAt: string;
}

export type ConnectorMode = "oauth" | "api_key" | "fixture" | "native" | "none";
export type ConnectorStatus = "connected" | "fixture" | "disconnected";

export interface ConnectorState {
  key: ConnectorKey;
  label: string;
  status: ConnectorStatus;
  mode: ConnectorMode;
  /** Human-readable note about what data this connector contributes (or lacks). */
  completenessNote: string;
}

export type ConnectorKey =
  | "website" | "gbp" | "ga4" | "search-console" | "meta" | "google-ads"
  | "crm" | "email" | "shopify" | "social";

export interface AuditContext {
  workspaceId: string;
  /** First SEO project in the workspace (audits are project-scoped where the module is). */
  projectId: string | null;
  projectDomain: string | null;
  connectors: Record<ConnectorKey, ConnectorState>;
  /** Convenience: the connector state object for a single key. */
  isConnected(key: ConnectorKey): boolean;
}

export interface RevenueOpportunity {
  id: string;
  title: string;
  description: string;
  /** Expected annual revenue impact in USD (estimate, labeled as such in UI). */
  impactUsd: number;
  /** 1 (trivial) – 5 (major lift). */
  effort: number;
  impactScore: number;
  confidence: "high" | "medium" | "low";
  /** Marketr module that executes this opportunity. */
  executesIn: string;
  auditId: AuditId;
}

export interface PlanInitiative {
  id: string;
  title: string;
  description: string;
  /** 30 | 60 | 90 — the sprint window it belongs to. */
  sprint: 30 | 60 | 90;
  /** Human-adjustable rank (1 = highest priority). */
  priority: number;
  /** Marketr module that executes this initiative. */
  module: string;
  expectedOutcome: string;
  effort: "low" | "medium" | "high";
  auditId: AuditId;
  /** Present when a human reprioritized this initiative. */
  adjustedByHuman?: boolean;
}

export interface GrowthPlan {
  initiatives: PlanInitiative[];
  generatedAt: string;
}

export interface ReportBundle {
  audits: AuditResult[];
  opportunities: RevenueOpportunity[];
  plan: GrowthPlan;
  completeness: Record<AuditId, Completeness>;
  generatedAt: string;
}
