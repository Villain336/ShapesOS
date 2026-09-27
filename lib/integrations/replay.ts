// Marketr — Phase 12 "embeds": rrweb session replay (MIT) on the public
// share page (/s/[token]). Recording is OPT-IN per share link (a checkbox
// in the share dialog, default off) and events are tenant-scoped by the
// share token hash — the same no-oracle rules as the share page itself.
//
// Privacy posture: the recorder is configured with maskAllInputs + masking
// of text selections; replay sessions never leave the workspace that owns
// the share. Events are rrweb `eventWithTime` payloads.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { hashShareToken } from "@/lib/design/sharing";

/** A single rrweb event as posted by the client recorder. */
export interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

const MAX_EVENTS_PER_SESSION = 5000;
const MAX_BATCH = 500;

/** Validate one batch from the client; returns the sanitized events. */
export function sanitizeReplayBatch(raw: unknown): RrwebEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: RrwebEvent[] = [];
  for (const item of raw.slice(0, MAX_BATCH)) {
    const e = item as Record<string, unknown> | null;
    if (!e || typeof e !== "object") continue;
    if (typeof e["type"] !== "number" || typeof e["timestamp"] !== "number") continue;
    events.push({ type: e["type"], timestamp: e["timestamp"], data: e["data"] });
  }
  return events;
}

/**
 * Resolve a share token to its share row (active, not revoked/expired).
 * Identical no-oracle behavior to the share page: null for anything else.
 */
export async function resolveActiveShare(token: string) {
  const share = await prisma.designShare.findUnique({
    where: { tokenHash: hashShareToken(token) },
    select: {
      id: true,
      designId: true,
      workspaceId: true,
      replayOptIn: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!share) return null;
  if (share.revokedAt) return null;
  if (share.expiresAt && share.expiresAt <= new Date()) return null;
  if (!share.replayOptIn) return null;
  return share;
}

/** Append events to a session (creates the session row on first batch). */
export async function appendReplayEvents(
  shareId: string,
  workspaceId: string,
  designId: string,
  events: RrwebEvent[],
): Promise<{ sessionId: string; eventCount: number }> {
  if (events.length === 0) {
    throw new Error("Empty event batch.");
  }
  // One open session per share — the latest without endedAt.
  let session = await prisma.designReplaySession.findFirst({
    where: { shareId, endedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true, events: true },
  });
  if (!session) {
    session = await prisma.designReplaySession.create({
      data: {
        shareId,
        workspaceId,
        designId,
        events: [],
      },
      select: { id: true, events: true },
    });
  }
  const existing = Array.isArray(session.events) ? (session.events as unknown[]) : [];
  const merged = [...existing, ...events].slice(-MAX_EVENTS_PER_SESSION);
  // Prisma Json columns need an InputJsonValue; rrweb events are
  // plain JSON-serializable objects by construction (sanitized above).
  const jsonEvents = merged as unknown as Prisma.InputJsonArray;
  await prisma.designReplaySession.update({
    where: { id: session.id },
    data: { events: jsonEvents },
  });
  return { sessionId: session.id, eventCount: merged.length };
}

/** List sessions for a share, newest first. Tenant-scoped via shareId. */
export async function listReplaySessions(shareId: string) {
  const rows = await prisma.designReplaySession.findMany({
    where: { shareId },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, endedAt: true },
  });
  return rows;
}

/** Read one session's events; null unless it belongs to this share. */
export async function readReplaySession(
  shareId: string,
  sessionId: string,
): Promise<RrwebEvent[] | null> {
  const session = await prisma.designReplaySession.findFirst({
    where: { id: sessionId, shareId },
    select: { events: true },
  });
  if (!session) return null;
  const events = session.events as unknown;
  return Array.isArray(events) ? (events as RrwebEvent[]) : [];
}

/** Mark the open session(s) for a share as ended (called on page unload is best-effort). */
export async function endReplaySessions(shareId: string): Promise<void> {
  await prisma.designReplaySession.updateMany({
    where: { shareId, endedAt: null },
    data: { endedAt: new Date() },
  });
}
