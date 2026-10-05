// ShapesOS — analytics home (Phase 4b): one read model for /dashboard/analytics.
//
// Unifies, for one date window:
//   - traffic: GA4 traffic_report + top_pages and Search Console
//     query_performance, through the connector layer (lib/connectors/m21)
//     with the connection's stored credential. Whatever the adapter answers
//     is shown; mock answers carry mock: true and the UI labels them.
//     No active connection → "not_connected" (the UI links to Connectors).
//   - social engagement: lib/social/engagement.ts
//   - attribution by channel and spend: lib/attribution/report.ts (linear)
// Each section fails independently: one broken source never blanks the page.

import { prisma } from "@/lib/prisma";
import { getAdapterForConnection } from "@/lib/connectors/m21";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { getAttributionReport } from "@/lib/attribution/report";
import { getSocialEngagement, type SocialEngagement } from "@/lib/social/engagement";
import { log } from "@/lib/observability/log";

export type SectionStatus = "ok" | "not_connected" | "error";

export interface Ga4Section {
  status: SectionStatus;
  mock: boolean;
  message?: string;
  sessions: number | null;
  users: number | null;
  newUsers: number | null;
  engagementRate: number | null;
  conversions: number | null;
  topPages: Array<{ path: string; title: string | null; sessions: number; conversions: number | null }>;
}

export interface GscSection {
  status: SectionStatus;
  mock: boolean;
  message?: string;
  clicks: number | null;
  impressions: number | null;
  topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>;
}

export interface ChannelRow {
  channel: string;
  leads: number;
  customers: number;
  revenueCents: number;
  spendCents: number;
  roas: number | null;
  cplCents: number | null;
}

export interface AnalyticsOverview {
  window: { from: string; to: string; days: number };
  traffic: { ga4: Ga4Section; gsc: GscSection };
  social: (SocialEngagement & { status: SectionStatus; message?: string }) | { status: "error"; message: string };
  attribution:
    | {
        status: "ok";
        channels: ChannelRow[];
        totals: { leads: number; customers: number; revenueCents: number; spendCents: number; roas: number | null; unattributedRevenueCents: number };
      }
    | { status: "error"; message: string };
}

const GA4_KEY = "ga4";
const GSC_KEY = "google-search-console";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number | null {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : n;
}

interface ConnectionTarget {
  connectionId: string;
  projectId?: string;
  projectConfig?: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** The workspace's first active connection for a connector key (+ its first project binding). */
async function findConnection(workspaceId: string, connectorKey: string): Promise<ConnectionTarget | null> {
  const conn = await prisma.connectorConnection.findFirst({
    where: { workspaceId, connectorKey, status: "active" },
    orderBy: { connectedAt: "desc" },
    include: { projectBindings: { take: 1, orderBy: { createdAt: "asc" } } },
  });
  if (!conn) return null;
  const binding = conn.projectBindings[0];
  return {
    connectionId: conn.id,
    projectId: binding?.projectId,
    projectConfig:
      binding?.projectConfig && typeof binding.projectConfig === "object" && !Array.isArray(binding.projectConfig)
        ? (binding.projectConfig as Record<string, unknown>)
        : undefined,
    meta: conn.meta && typeof conn.meta === "object" && !Array.isArray(conn.meta) ? (conn.meta as Record<string, unknown>) : {},
  };
}

async function invoke(
  workspaceId: string,
  userId: string,
  connectorKey: string,
  target: ConnectionTarget,
  tool: string,
  args: Record<string, unknown>,
) {
  const adapter = await getAdapterForConnection({ connectorKey });
  const credential = await getDecryptedCredential(target.connectionId);
  return adapter.invoke(tool, args, credential, {
    workspaceId,
    projectId: target.projectId,
    userId,
    projectConfig: target.projectConfig,
  });
}

export async function loadGa4(workspaceId: string, userId: string, from: Date, to: Date): Promise<Ga4Section> {
  const empty: Ga4Section = { status: "not_connected", mock: false, sessions: null, users: null, newUsers: null, engagementRate: null, conversions: null, topPages: [] };
  try {
    const target = await findConnection(workspaceId, GA4_KEY);
    if (!target) return empty;
    const propertyId = target.projectConfig?.propertyId ?? target.meta.propertyId;
    const base = { ...(propertyId ? { propertyId } : {}), startDate: ymd(from), endDate: ymd(to) };
    const report = await invoke(workspaceId, userId, GA4_KEY, target, "traffic_report", base);
    if (!report.ok) return { ...empty, status: "error", message: report.error ?? "GA4 request failed." };
    const pages = await invoke(workspaceId, userId, GA4_KEY, target, "top_pages", { ...base, limit: 10 });
    const d = (report.data ?? {}) as Record<string, unknown>;
    const rows = pages.ok && Array.isArray((pages.data as Record<string, unknown> | null)?.rows)
      ? ((pages.data as Record<string, unknown>).rows as Array<Record<string, unknown>>)
      : [];
    return {
      status: "ok",
      mock: Boolean(report.mock || d.mock),
      sessions: num(d.sessions),
      users: num(d.totalUsers ?? d.users),
      newUsers: num(d.newUsers),
      engagementRate: num(d.engagementRate),
      conversions: num(d.conversions),
      topPages: rows.slice(0, 10).map((r) => ({
        path: String(r.pagePath ?? r.path ?? ""),
        title: typeof r.pageTitle === "string" ? r.pageTitle : null,
        sessions: num(r.sessions) ?? 0,
        conversions: num(r.conversions),
      })),
    };
  } catch (e) {
    log.warn("analytics ga4 failed", { workspaceId, error: e instanceof Error ? e.message : String(e) });
    return { ...empty, status: "error", message: "GA4 is unavailable right now." };
  }
}

export async function loadGsc(workspaceId: string, userId: string, from: Date, to: Date): Promise<GscSection> {
  const empty: GscSection = { status: "not_connected", mock: false, clicks: null, impressions: null, topQueries: [] };
  try {
    const target = await findConnection(workspaceId, GSC_KEY);
    if (!target) return empty;
    const property = target.projectConfig?.property ?? target.meta.property;
    const res = await invoke(workspaceId, userId, GSC_KEY, target, "query_performance", {
      ...(property ? { property } : {}),
      startDate: ymd(from),
      endDate: ymd(to),
      limit: 10,
    });
    if (!res.ok) return { ...empty, status: "error", message: res.error ?? "Search Console request failed." };
    const d = (res.data ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(d.rows) ? (d.rows as Array<Record<string, unknown>>) : [];
    const topQueries = rows.map((r) => ({
      query: String(r.query ?? (Array.isArray(r.keys) ? r.keys[0] : "") ?? ""),
      clicks: num(r.clicks) ?? 0,
      impressions: num(r.impressions) ?? 0,
      ctr: num(r.ctr),
      position: num(r.position),
    }));
    return {
      status: "ok",
      mock: Boolean(res.mock || rows.some((r) => r.mock)),
      clicks: topQueries.reduce((s, q) => s + q.clicks, 0),
      impressions: topQueries.reduce((s, q) => s + q.impressions, 0),
      topQueries,
    };
  } catch (e) {
    log.warn("analytics gsc failed", { workspaceId, error: e instanceof Error ? e.message : String(e) });
    return { ...empty, status: "error", message: "Search Console is unavailable right now." };
  }
}

export async function getAnalyticsOverview(
  workspaceId: string,
  userId: string,
  window: { from: Date; to: Date },
): Promise<AnalyticsOverview> {
  const { from, to } = window;
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  const [ga4, gsc, social, attribution] = await Promise.all([
    loadGa4(workspaceId, userId, from, to),
    loadGsc(workspaceId, userId, from, to),
    getSocialEngagement(workspaceId, { from, to })
      .then((s) => ({ ...s, status: "ok" as const }))
      .catch((e: unknown) => {
        log.warn("analytics social failed", { workspaceId, error: e instanceof Error ? e.message : String(e) });
        return { status: "error" as const, message: "Social engagement is unavailable right now." };
      }),
    getAttributionReport(workspaceId, { from, to })
      .then(({ report }) => {
        const r = report.linear;
        return {
          status: "ok" as const,
          channels: r.channels
            .map((c) => ({
              channel: c.channel,
              leads: c.leads,
              customers: c.customers,
              revenueCents: c.revenueCents,
              spendCents: c.spendCents,
              roas: c.roas,
              cplCents: c.cplCents,
            }))
            .sort((a, b) => b.revenueCents - a.revenueCents || b.leads - a.leads),
          totals: {
            leads: r.totals.leads,
            customers: r.totals.customers,
            revenueCents: r.totals.attributedRevenueCents,
            spendCents: r.totals.spendCents,
            roas: r.totals.roas,
            unattributedRevenueCents: r.totals.unattributedRevenueCents,
          },
        };
      })
      .catch((e: unknown) => {
        log.warn("analytics attribution failed", { workspaceId, error: e instanceof Error ? e.message : String(e) });
        return { status: "error" as const, message: "Attribution is unavailable right now." };
      }),
  ]);
  return { window: { from: from.toISOString(), to: to.toISOString(), days }, traffic: { ga4, gsc }, social, attribution };
}

/** ?days=7|30|90|365 or ?from=&to= → a validated window (default 30 days). */
export function parseAnalyticsWindow(sp: URLSearchParams, now: Date = new Date()): { from: Date; to: Date } | { error: string } {
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  if (fromRaw || toRaw) {
    const from = fromRaw ? new Date(fromRaw) : null;
    const to = toRaw ? new Date(toRaw) : now;
    if (!from || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) return { error: "from and to must be valid dates." };
    if (from > to) return { error: "from must be on or before to." };
    if (to.getTime() - from.getTime() > 731 * 86_400_000) return { error: "Pick a range of two years or less." };
    return { from, to };
  }
  const daysRaw = sp.get("days");
  const days = daysRaw ? Number(daysRaw) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 731) return { error: "days must be a whole number from 1 to 731." };
  return { from: new Date(now.getTime() - days * 86_400_000), to: now };
}
