// ShapesOS — status page store (beta readiness, WS=legal).
//
// status_components holds an operator's MANUAL state per component (the live
// state is derived in ./derive.ts); status_incidents is the incident log with
// its timeline in `updates`. Platform-wide tables: no workspace scope, no
// RLS, no GUC needed to read. Callers gate writes with
// requirePlatformOperator (the routes under app/api/status).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ComponentDef, ComponentState, ManualOverride } from "./derive";
import { COMPONENT_KEYS, type IncidentCreateBody, type IncidentUpdateBody } from "./schema";

export type ComponentKey = ComponentDef["key"];
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";
export type IncidentImpact = "none" | "minor" | "major" | "critical";

export interface IncidentUpdate {
  at: string;
  status: IncidentStatus;
  message: string;
  /** Operator id — stripped before anything leaves the server (toPublic). */
  by: string;
}

export interface StatusIncident {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  componentKeys: ComponentKey[];
  startedAt: string;
  resolvedAt: string | null;
  updates: IncidentUpdate[];
}

/** What the public page and route see: the timeline without operator ids. */
export type PublicIncident = Omit<StatusIncident, "updates"> & { updates: Array<Omit<IncidentUpdate, "by">> };

/** Resolved incidents stay on the page this long. */
export const INCIDENT_HISTORY_DAYS = 90;
export const INCIDENT_HISTORY_LIMIT = 20;

export function isComponentKey(v: unknown): v is ComponentKey {
  return typeof v === "string" && (COMPONENT_KEYS as readonly string[]).includes(v);
}

function parseUpdates(raw: unknown): IncidentUpdate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is IncidentUpdate => !!u && typeof u === "object" && typeof (u as IncidentUpdate).message === "string");
}

function toIncident(row: {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: IncidentImpact;
  componentKeys: string[];
  startedAt: Date;
  resolvedAt: Date | null;
  updates: unknown;
}): StatusIncident {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    impact: row.impact,
    componentKeys: row.componentKeys.filter(isComponentKey),
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    updates: parseUpdates(row.updates),
  };
}

export function toPublic(i: StatusIncident): PublicIncident {
  return { ...i, updates: i.updates.map(({ at, status, message }) => ({ at, status, message })) };
}

// ── Components ─────────────────────────────────────────────────────────────

export async function listComponentOverrides(): Promise<Partial<Record<ComponentKey, ManualOverride>>> {
  const rows = await prisma.statusComponentOverride.findMany();
  const out: Partial<Record<ComponentKey, ManualOverride>> = {};
  for (const r of rows) if (isComponentKey(r.key)) out[r.key] = { state: r.state as ComponentState, note: r.note };
  return out;
}

/** Set (upsert) or clear (null) an operator override. */
export async function setComponentOverride(key: ComponentKey, override: ManualOverride | null, by: string): Promise<void> {
  if (!override) {
    await prisma.statusComponentOverride.deleteMany({ where: { key } });
    return;
  }
  if (override.state === "unknown") throw new Error("unknown is a derived state, not a manual one");
  const state = override.state;
  await prisma.statusComponentOverride.upsert({
    where: { key },
    create: { key, state, note: override.note, setBy: by },
    update: { state, note: override.note, setBy: by },
  });
}

// ── Incidents ──────────────────────────────────────────────────────────────

export async function createIncident(input: IncidentCreateBody, by: string, now = new Date()): Promise<StatusIncident> {
  const first: IncidentUpdate = { at: now.toISOString(), status: input.status, message: input.message, by };
  const row = await prisma.statusIncident.create({
    data: {
      title: input.title,
      status: input.status,
      impact: input.impact,
      componentKeys: [...new Set(input.componentKeys)],
      updates: [first] as unknown as Prisma.InputJsonValue,
      startedAt: now,
      resolvedAt: input.status === "resolved" ? now : null,
      createdBy: by,
    },
  });
  return toIncident(row);
}

/** Append an update; "resolved" closes the incident. Null when the id is unknown. */
export async function updateIncident(id: string, input: IncidentUpdateBody, by: string, now = new Date()): Promise<StatusIncident | null> {
  const existing = await prisma.statusIncident.findUnique({ where: { id } });
  if (!existing) return null;
  const updates = [...parseUpdates(existing.updates), { at: now.toISOString(), status: input.status, message: input.message, by }];
  const row = await prisma.statusIncident.update({
    where: { id },
    data: {
      status: input.status,
      ...(input.impact ? { impact: input.impact } : {}),
      updates: updates as unknown as Prisma.InputJsonValue,
      resolvedAt: input.status === "resolved" ? (existing.resolvedAt ?? now) : null,
    },
  });
  return toIncident(row);
}

export async function getIncident(id: string): Promise<StatusIncident | null> {
  const row = await prisma.statusIncident.findUnique({ where: { id } });
  return row ? toIncident(row) : null;
}

/** Open incidents (newest first) and the resolved ones of the last 90 days (newest first, capped). */
export async function listIncidents(now = new Date()): Promise<{ open: StatusIncident[]; recent: StatusIncident[] }> {
  const since = new Date(now.getTime() - INCIDENT_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  const [open, recent] = await Promise.all([
    prisma.statusIncident.findMany({ where: { resolvedAt: null }, orderBy: { startedAt: "desc" }, take: INCIDENT_HISTORY_LIMIT }),
    prisma.statusIncident.findMany({ where: { resolvedAt: { not: null, gte: since } }, orderBy: { resolvedAt: "desc" }, take: INCIDENT_HISTORY_LIMIT }),
  ]);
  return { open: open.map(toIncident), recent: recent.map(toIncident) };
}
