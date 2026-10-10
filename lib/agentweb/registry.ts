// ShapesOS — Phase 21A (WS=agentweb): the site capability registry.
//
// Per workspace and origin: what the site DECLARED to agents (from a probe) and
// what actually WORKED for our agents (per channel: ok / failed counts). Shared
// by every agent in the workspace, so the second agent to visit a site does not
// repeat the first one's failed attempt. FORCE RLS: another workspace never sees
// it. Declared tools are advisory (a site can claim anything); `worked` is ours.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Prisma } from "@prisma/client";
import type { ChannelId, ChannelReport } from "./channels";

export interface WorkedStat {
  ok: number;
  failed: number;
  lastAt: string;
}
export type WorkedMap = Partial<Record<ChannelId, WorkedStat>>;

export interface SiteCapability {
  origin: string;
  declared: { tools: Array<{ source: string; name: string }>; apis: number; actions: number; entities: number; llmsTxt: boolean };
  worked: WorkedMap;
  flows: Array<{ intent: string; channel: ChannelId; at: string }>;
  probedAt: Date | null;
}

const tx = (t: unknown) => t as Prisma.TransactionClient;

export function declaredSummary(r: ChannelReport): SiteCapability["declared"] {
  return {
    tools: r.declaredTools.map((t) => ({ source: t.source, name: t.name })).slice(0, 30),
    apis: r.apis.reduce((n, a) => n + a.operations.length, 0),
    actions: r.structured.actions.length,
    entities: r.structured.entities.length,
    llmsTxt: r.llmsTxt,
  };
}

export async function recordProbe(workspaceId: string, report: ChannelReport): Promise<void> {
  const declared = declaredSummary(report);
  await withWorkspaceScope(workspaceId, (t) =>
    tx(t).agentwebSiteCapability.upsert({
      where: { workspaceId_origin: { workspaceId, origin: report.origin } },
      create: { workspaceId, origin: report.origin, declared, probedAt: new Date() },
      update: { declared, probedAt: new Date() },
    }),
  );
}

/** Record that a channel worked (or failed) for an origin. */
export async function recordOutcome(workspaceId: string, origin: string, channel: ChannelId, ok: boolean, flow?: { intent: string }): Promise<void> {
  await withWorkspaceScope(workspaceId, async (t) => {
    const row = await tx(t).agentwebSiteCapability.findUnique({ where: { workspaceId_origin: { workspaceId, origin } } });
    const worked = ((row?.worked ?? {}) as WorkedMap) ?? {};
    const prev = worked[channel] ?? { ok: 0, failed: 0, lastAt: "" };
    worked[channel] = { ok: prev.ok + (ok ? 1 : 0), failed: prev.failed + (ok ? 0 : 1), lastAt: new Date().toISOString() };
    const flows = ((row?.flows ?? []) as SiteCapability["flows"]).slice(-19);
    if (ok && flow) flows.push({ intent: flow.intent.slice(0, 120), channel, at: new Date().toISOString() });
    await tx(t).agentwebSiteCapability.upsert({
      where: { workspaceId_origin: { workspaceId, origin } },
      create: { workspaceId, origin, worked: worked as Prisma.InputJsonValue, flows: flows as Prisma.InputJsonValue },
      update: { worked: worked as Prisma.InputJsonValue, flows: flows as Prisma.InputJsonValue },
    });
  });
}

export async function getSiteCapability(workspaceId: string, origin: string): Promise<SiteCapability | null> {
  const row = await withWorkspaceScope(workspaceId, (t) => tx(t).agentwebSiteCapability.findUnique({ where: { workspaceId_origin: { workspaceId, origin } } }));
  if (!row) return null;
  return { origin: row.origin, declared: row.declared as SiteCapability["declared"], worked: row.worked as WorkedMap, flows: row.flows as SiteCapability["flows"], probedAt: row.probedAt };
}

export async function listSiteCapabilities(workspaceId: string, limit = 100): Promise<SiteCapability[]> {
  const rows = await withWorkspaceScope(workspaceId, (t) => tx(t).agentwebSiteCapability.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" }, take: limit }));
  return rows.map((row) => ({ origin: row.origin, declared: row.declared as SiteCapability["declared"], worked: row.worked as WorkedMap, flows: row.flows as SiteCapability["flows"], probedAt: row.probedAt }));
}

/** Channels that failed here at least twice and never worked: the selector skips them. */
export function failedChannels(cap: SiteCapability | null): ChannelId[] {
  if (!cap) return [];
  return (Object.entries(cap.worked) as Array<[ChannelId, WorkedStat]>).filter(([, s]) => s.failed >= 2 && s.ok === 0).map(([c]) => c);
}
