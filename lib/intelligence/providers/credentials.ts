// Marketr — Phase 10 M6: vendor credential + routing-config resolution.
// Credentials come from the data_source registry (encrypted JSON config,
// workspace-scoped, tenant fail-closed via withWorkspaceScope) with env
// fallback for demo mode. Never log credential material.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { secrets } from "@/lib/secrets";
import { DataForSeoAdapter } from "./dataforseo";
import { SerperAdapter } from "./serper";
import { TalorDataAdapter } from "./talordata";
import type { SerpProvider, SerpVendorId } from "./types";

export interface VendorCredentials {
  serper?: { apiKey?: string };
  dataforseo?: { login?: string; password?: string };
  talordata?: { apiKey?: string };
}

const ENV_VARS: Record<SerpVendorId, string[]> = {
  serper: ["SERPER_API_KEY"],
  dataforseo: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
  talordata: ["TALORDATA_API_KEY"],
};

function envCredentials(): VendorCredentials {
  return {
    serper: { apiKey: process.env.SERPER_API_KEY?.trim() || undefined },
    dataforseo: {
      login: process.env.DATAFORSEO_LOGIN?.trim() || undefined,
      password: process.env.DATAFORSEO_PASSWORD?.trim() || undefined,
    },
    talordata: { apiKey: process.env.TALORDATA_API_KEY?.trim() || undefined },
  };
}

interface SerpVendorConfigJson {
  /** Envelope for KMS/env-encrypted blobs: { encrypted: "<envelope>" }. */
  encrypted?: string;
  serper?: { apiKey?: string };
  dataforseo?: { login?: string; password?: string };
  talordata?: { apiKey?: string };
}

function decryptConfig(raw: unknown): SerpVendorConfigJson {
  const cfg = (raw ?? {}) as SerpVendorConfigJson;
  if (typeof cfg.encrypted === "string" && cfg.encrypted.length > 0) {
    try {
      return JSON.parse(secrets().decrypt(cfg.encrypted)) as SerpVendorConfigJson;
    } catch {
      return {};
    }
  }
  return cfg;
}

/**
 * Resolve vendor credentials for a workspace. data_source (serp_vendor,
 * status=active) wins; env vars fill gaps (demo mode).
 */
export async function getVendorCredentials(workspaceId: string): Promise<VendorCredentials> {
  const merged: VendorCredentials = envCredentials();
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.dataSource.findFirst({
      where: { workspaceId, type: "serp_vendor", status: "active" },
      orderBy: { updatedAt: "desc" },
    }),
  );
  if (row) {
    const cfg = decryptConfig(row.config);
    // Registry keys win over env; env only fills gaps.
    if (cfg.serper?.apiKey) merged.serper = { ...merged.serper, apiKey: cfg.serper.apiKey };
    if (cfg.dataforseo?.login) merged.dataforseo = { ...merged.dataforseo, login: cfg.dataforseo.login };
    if (cfg.dataforseo?.password) merged.dataforseo = { ...merged.dataforseo, password: cfg.dataforseo.password };
    if (cfg.talordata?.apiKey) merged.talordata = { ...merged.talordata, apiKey: cfg.talordata.apiKey };
  }
  return merged;
}

/**
 * Phase 15.2: whose key each SERP vendor call uses — the workspace's own
 * (data_source registry; charged 0 credits) or the platform's env key
 * (charged at INTELLIGENCE_VENDOR_MULTIPLIER × its USD cost).
 */
export async function getVendorKeySources(workspaceId: string): Promise<Record<SerpVendorId, "workspace" | "platform">> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.dataSource.findFirst({
      where: { workspaceId, type: "serp_vendor", status: "active" },
      orderBy: { updatedAt: "desc" },
    }),
  );
  const cfg = row ? decryptConfig(row.config) : {};
  return {
    serper: cfg.serper?.apiKey ? "workspace" : "platform",
    dataforseo: cfg.dataforseo?.login && cfg.dataforseo?.password ? "workspace" : "platform",
    talordata: cfg.talordata?.apiKey ? "workspace" : "platform",
  };
}

/** Which env vars back each vendor (for the data-costs UI "how to connect" copy). */
export function vendorEnvVars(): Record<SerpVendorId, string[]> {
  return ENV_VARS;
}

/** Build the live adapter set for a workspace from resolved credentials. */
export async function buildSerpAdapters(workspaceId: string): Promise<Record<SerpVendorId, SerpProvider>> {
  const creds = await getVendorCredentials(workspaceId);
  return {
    serper: new SerperAdapter(creds.serper?.apiKey ?? null),
    dataforseo: new DataForSeoAdapter(creds.dataforseo?.login ?? null, creds.dataforseo?.password ?? null),
    talordata: new TalorDataAdapter(creds.talordata?.apiKey ?? null),
  };
}

export interface RoutingRules {
  /** Default vendor id, e.g. "serper". */
  default?: SerpVendorId;
  /** Vendor used when needAiOverview is set (default "talordata"). */
  aiOverview?: SerpVendorId;
  /** Ordered fallback when the chosen vendor is unconfigured. */
  fallback?: SerpVendorId[];
}

export interface VendorConfigRow {
  vendor: SerpVendorId;
  status: string;
  routingRules: RoutingRules;
  monthlyBudgetCapCents: number | null;
}

export async function getVendorConfigs(workspaceId: string): Promise<VendorConfigRow[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.serpVendorConfig.findMany({ where: { workspaceId }, orderBy: { vendor: "asc" } }),
  );
  return rows.map((r) => ({
    vendor: r.vendor as SerpVendorId,
    status: r.status,
    routingRules: (r.routingRules ?? {}) as RoutingRules,
    monthlyBudgetCapCents: r.monthlyBudgetCapCents,
  }));
}

/** Seed defaults for a workspace (idempotent). Used by consumers, not UI. */
export async function ensureVendorConfigs(workspaceId: string): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    for (const vendor of ["serper", "dataforseo", "talordata"] as const) {
      await tx.serpVendorConfig.upsert({
        where: { workspaceId_vendor: { workspaceId, vendor } },
        update: {},
        create: {
          workspaceId,
          vendor,
          routingRules: { default: "serper", aiOverview: "talordata", fallback: ["dataforseo", "serper", "talordata"] },
          status: "active",
        },
      });
    }
  });
}

// Re-export prisma for consumers that need raw access (tests, scripts).
export { prisma };
