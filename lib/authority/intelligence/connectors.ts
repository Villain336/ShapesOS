// Marketr — Phase 6 I1: stack connector registry.
//
// Connects the client's stack (OAuth where available) using the vault
// pattern (ConnectorConnection rows). Fake OAuth/vault fixtures are the
// default: fixtures make the demo compile without live credentials while
// being honestly labeled "fixture" everywhere they surface.

import { prisma } from "@/lib/prisma";
import { deleteConnection } from "@/lib/vault/apikey";
import type {
  AuditContext, ConnectorKey, ConnectorMode, ConnectorState, ConnectorStatus,
} from "./types";

export interface ConnectorDef {
  key: ConnectorKey;
  label: string;
  /** Vault connectorKey for OAuth/API-key connectors; "native:<name>" for built-ins. */
  vaultKey: string;
  mode: "oauth" | "api_key" | "native" | "fixture";
  contributesTo: string[];
  description: string;
}

/** The ten stack connectors from SPEC-PHASE6 §2/I1. */
export const CONNECTOR_DEFS: ConnectorDef[] = [
  { key: "website", label: "Website", vaultKey: "native:website", mode: "native",
    contributesTo: ["company", "website", "technology"],
    description: "Primary domain from the SEO project + site crawl data." },
  { key: "gbp", label: "Google Business Profile", vaultKey: "google-business-profile", mode: "oauth",
    contributesTo: ["company", "market", "reputation"],
    description: "GBP profile data, ratings, and local competitor snapshots." },
  { key: "ga4", label: "Google Analytics 4", vaultKey: "ga4", mode: "oauth",
    contributesTo: ["website", "conversion"],
    description: "Traffic, engagement, and conversion event data." },
  { key: "search-console", label: "Search Console", vaultKey: "google-search-console", mode: "oauth",
    contributesTo: ["seo", "content"],
    description: "Impressions, clicks, and query-level ranking coverage." },
  { key: "meta", label: "Meta Ads", vaultKey: "meta-ads", mode: "oauth",
    contributesTo: ["paid", "brand"],
    description: "Meta ad spend, delivery, and creative performance." },
  { key: "google-ads", label: "Google Ads", vaultKey: "google-ads", mode: "api_key",
    contributesTo: ["paid"],
    description: "Search/display spend and auction performance." },
  { key: "crm", label: "CRM", vaultKey: "native:crm", mode: "native",
    contributesTo: ["conversion", "crm"],
    description: "ShapesOS's own lead pipeline CRM — always available in-workspace." },
  { key: "email", label: "Email platform", vaultKey: "email-platform", mode: "api_key",
    contributesTo: ["crm", "content"],
    description: "Newsletter lists, broadcasts, and nurture sequence coverage." },
  { key: "shopify", label: "Shopify", vaultKey: "shopify", mode: "oauth",
    contributesTo: ["conversion"],
    description: "Store revenue and product-level conversion data." },
  { key: "social", label: "Social accounts", vaultKey: "buffer", mode: "oauth",
    contributesTo: ["brand", "reputation"],
    description: "Social channels and scheduled-post inventory." },
];

/**
 * Install a fixture connection for a connector: a ConnectorConnection row with
 * no credential, marked fixture in meta. Fixtures are the default so the
 * Intelligence Report can compile on day one without live OAuth.
 */
export async function installFixture(
  workspaceId: string, userId: string, key: ConnectorKey, label?: string,
) {
  const def = CONNECTOR_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown connector: ${key}`);
  return prisma.connectorConnection.upsert({
    where: {
      // composite key may not exist; fall back to findFirst + create/update
      id: `fixture:${workspaceId}:${def.vaultKey}`,
    },
    create: {
      id: `fixture:${workspaceId}:${def.vaultKey}`,
      connectorKey: def.vaultKey,
      workspaceId,
      userId,
      status: "active",
      scopes: [],
      meta: { mode: "fixture", label: label ?? def.label, source: "intelligence-connect" },
    },
    update: {
      status: "active",
      meta: { mode: "fixture", label: label ?? def.label, source: "intelligence-connect" },
    },
  });
}

/**
 * Remove this workspace's connection(s) for a connector (fixture or real).
 * Phase 15.1 (BUG B): looked up by (workspaceId, connectorKey = vaultKey) and
 * each deleted through the vault's deleteConnection(connectionId,
 * workspaceId) — credential first, then the connection, workspace-scoped.
 * A vault KEY is not a connection id. Returns how many were removed.
 */
export async function disconnectConnector(workspaceId: string, key: ConnectorKey): Promise<number> {
  const def = CONNECTOR_DEFS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown connector: ${key}`);
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId, connectorKey: def.vaultKey },
    select: { id: true },
  });
  for (const row of rows) await deleteConnection(row.id, workspaceId);
  return rows.length;
}

/** Resolve per-connection status + completeness labels for the whole stack. */
export async function stackStatus(
  workspaceId: string,
  projectDomain: string | null,
): Promise<Record<ConnectorKey, ConnectorState>> {
  const rows = await prisma.connectorConnection.findMany({
    where: { workspaceId },
    select: { connectorKey: true, status: true, meta: true },
  });
  const byKey = new Map(rows.map((r) => [r.connectorKey, r]));

  const out = {} as Record<ConnectorKey, ConnectorState>;
  for (const def of CONNECTOR_DEFS) {
    out[def.key] = resolveOne(def, byKey.get(def.vaultKey), projectDomain);
  }
  return out;
}

function resolveOne(
  def: ConnectorDef,
  row: { status: string; meta: unknown } | undefined,
  projectDomain: string | null,
): ConnectorState {
  const meta = (row?.meta ?? {}) as Record<string, unknown>;
  const metaMode = typeof meta.mode === "string" ? meta.mode : undefined;

  if (def.mode === "native") {
    if (def.key === "website") {
      return {
        key: def.key, label: def.label,
        status: projectDomain ? "connected" : "disconnected",
        mode: "native",
        completenessNote: projectDomain
          ? `Connected — domain ${projectDomain} from the SEO project.`
          : "Not connected — create an SEO project to supply the website domain.",
      };
    }
    // CRM: native to Marketr — always connected.
    return {
      key: def.key, label: def.label, status: "connected", mode: "native",
      completenessNote: "Connected — ShapesOS's own pipeline CRM, always available.",
    };
  }

  if (!row || row.status !== "active") {
    return {
      key: def.key, label: def.label, status: "disconnected", mode: "none",
      completenessNote: `Not connected — ${def.label} data will be labeled unavailable in the report.`,
    };
  }
  const mode: ConnectorMode = metaMode === "fixture" ? "fixture" : def.mode;
  const status: ConnectorStatus = mode === "fixture" ? "fixture" : "connected";
  return {
    key: def.key, label: def.label, status, mode,
    completenessNote: status === "fixture"
      ? `Fixture — demo-mode ${def.label} connection; underlying data is a labeled fixture, not live.`
      : `Connected — live ${def.label} data via the credential vault.`,
  };
}

/** Build the audit context (workspace + project + connector states). */
export async function buildAuditContext(
  workspaceId: string,
  userId: string,
): Promise<AuditContext> {
  const project = await prisma.project.findFirst({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: { id: true, domain: true },
  });
  const connectors = await stackStatus(workspaceId, project?.domain ?? null);
  return {
    workspaceId,
    projectId: project?.id ?? null,
    projectDomain: project?.domain ?? null,
    connectors,
    isConnected(key: ConnectorKey) {
      const s = connectors[key];
      return s.status === "connected" || s.status === "fixture";
    },
  };
}
