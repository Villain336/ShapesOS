// Marketr — /api/flywheel/recycling client helpers.

export interface ApiSignal {
  id: string;
  workspaceId: string;
  kind: string;
  sourceAssetId: string;
  sourceChannel: string;
  metricValue: number;
  metricUnit: string;
  observedAt: string;
  source: "real" | "fake";
  detail: Record<string, unknown>;
}

export interface VariantSpecView {
  targetChannel: string;
  aspectRatio: string;
  copyDensityCeiling: { maxWords: number; maxLines: number };
  ctaFormats: string[];
  notes: string[];
  supervisedRewrite: { headline: boolean; cta: boolean };
  rulesVersion: string;
}

export interface LineageEntryView {
  hash: string;
  assetRef: string;
  stage: "source" | "variant" | "regenerated";
  channel: string;
  at: string;
}

export interface BriefView {
  id: string;
  sourceAssetId: string;
  sourceChannel: string;
  triggerSignal: {
    kind: string;
    signalId: string;
    metricValue: number;
    metricUnit: string;
    observedAt: string;
    source: "real" | "fake";
  };
  targetChannels: string[];
  variantSpecs: Record<string, VariantSpecView>;
  creativeHashLineage: LineageEntryView[];
  status: "draft" | "approved" | "regenerating" | "ready";
  approvalId: string | null;
  studioRouting: Array<{
    variantChannel: string;
    studioRef: string;
    receipt: string;
    routedAt: string;
    routedBy: string;
    provider: "fake" | "live";
  }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const api = {
  signals: (fake = false) =>
    req<{ signals: ApiSignal[]; readers: Array<{ kind: string; source: string; description: string }> }>(
      `/api/flywheel/recycling/signals${fake ? "?fake=1" : ""}`,
    ),
  listBriefs: (status?: string) =>
    req<{ briefs: BriefView[]; tablesReady: boolean }>(
      `/api/flywheel/recycling/briefs${status ? `?status=${status}` : ""}`,
    ),
  createBrief: (signal: ApiSignal, targetChannels: string[]) =>
    req<{ brief: BriefView }>(`/api/flywheel/recycling/briefs`, {
      method: "POST",
      body: JSON.stringify({ signal, targetChannels }),
    }),
  getBrief: (id: string) =>
    req<{
      brief: BriefView;
      lineage: { ok: true } | { ok: false; brokenAt: number };
      audit: { events: Array<{ id: string; ts: string; actor: string; action: string; detail: unknown }>; chain: { ok: boolean } };
    }>(`/api/flywheel/recycling/briefs/${id}`),
  approveBrief: (id: string, note?: string) =>
    req<{ brief: BriefView; receipts: BriefView["studioRouting"]; note: string }>(
      `/api/flywheel/recycling/briefs/${id}/approve`,
      { method: "POST", body: JSON.stringify({ note }) },
    ),
};

export function hashShort(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

export function formatMetric(kind: string, value: number, unit: string): string {
  if (unit === "revenue_cents") return `$${(value / 100).toLocaleString()}`;
  if (unit === "response_rate") return `${(value * 100).toFixed(2)}%`;
  if (unit === "scans_per_day") return `${value}/day`;
  if (unit === "cooccurrence_lift") return `+${(value * 100).toFixed(0)}% lift`;
  return `${value} ${unit}`;
}

export const SIGNAL_LABELS: Record<string, string> = {
  attribution_revenue: "Revenue-influenced content",
  qr_scan_rate: "QR / pURL scan rate",
  aeo_lift: "AEO co-occurrence lift",
  mail_response: "Direct-mail response",
};

export const SUPPORTED_TARGET_SUGGESTIONS: Record<string, string[]> = {
  mail: ["billboard", "dooh", "email", "social", "sms"],
  ad: ["email", "landing", "social", "dooh"],
  social: ["email", "ad", "landing"],
  email: ["ad", "landing", "social"],
  landing: ["ad", "social", "email"],
  video: ["ad", "social", "ctv"],
  dooh: [],
  billboard: [],
  ctv: [],
  sms: [],
};
