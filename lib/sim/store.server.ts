// ShapesOS — Phase 19B (WS=engine): town persistence (Postgres, FORCE RLS).
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Every read and write runs under the workspace's own GUC
// (withWorkspaceScope), so RLS scopes it. sim_events is append-only: this
// module only ever INSERTs events (the app role has no UPDATE / DELETE on
// the table — migration 20261024200000_p19b_engine_town). Events are written
// in chunks of EVENT_CHUNK rows.

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { TownEvent, TownSnapshot } from "./engine";
import type { TownLayout } from "./layout";
import type { Resident } from "./residents";
import type { Variant } from "./runner";

export const EVENT_CHUNK = 1_000;

export interface NewWorld {
  name: string;
  source: "generated" | "figma";
  seed?: number | null;
  size?: string | null;
  figmaFileKey?: string | null;
  figmaNodeId?: string | null;
  layout: TownLayout;
  createdBy: string;
}

export async function createWorld(workspaceId: string, w: NewWorld) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.simWorld.create({
      data: { workspaceId, name: w.name, source: w.source, seed: w.seed ?? null, size: w.size ?? null, figmaFileKey: w.figmaFileKey ?? null, figmaNodeId: w.figmaNodeId ?? null, layout: w.layout as unknown as Prisma.InputJsonValue, createdBy: w.createdBy },
    }),
  );
}

export async function insertResidents(workspaceId: string, runId: string, residents: Resident[]): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    for (let i = 0; i < residents.length; i += EVENT_CHUNK) {
      await tx.simResident.createMany({
        data: residents.slice(i, i + EVENT_CHUNK).map((r) => {
          const { id, name, segment, personaId, calibrated, homeLotId, workLotId, routine, ...data } = r;
          return { workspaceId, runId, residentKey: id, name, segment, personaId, calibrated, homeLotId, workLotId, routine, data: data as unknown as Prisma.InputJsonValue };
        }),
        skipDuplicates: true,
      });
    }
  });
}

export async function appendEvents(workspaceId: string, runId: string, variant: Variant, seedIndex: number, events: ReadonlyArray<Omit<TownEvent, "seq"> & { seq: number }>): Promise<void> {
  if (!events.length) return;
  await withWorkspaceScope(workspaceId, async (tx) => {
    for (let i = 0; i < events.length; i += EVENT_CHUNK) {
      await tx.simEvent.createMany({
        data: events.slice(i, i + EVENT_CHUNK).map((e) => ({
          workspaceId,
          runId,
          variant,
          seedIndex,
          seq: e.seq,
          t: e.t,
          type: e.type,
          residentKey: e.r ?? null,
          lotId: e.lot ?? null,
          ...(e.d ? { data: e.d as Prisma.InputJsonValue } : {}),
        })),
        // A re-run after a crash may re-send a chunk: the (run, variant, seed, seq) key keeps it once.
        skipDuplicates: true,
      });
    }
  });
}

export interface StoredEvent extends TownEvent {
  variant: Variant;
  seedIndex: number;
}

function toEvent(row: { seq: number; t: number; type: string; residentKey: string | null; lotId: string | null; data: Prisma.JsonValue | null; variant: string; seedIndex: number }): StoredEvent {
  return {
    seq: row.seq,
    t: row.t,
    type: row.type as TownEvent["type"],
    ...(row.residentKey ? { r: row.residentKey } : {}),
    ...(row.lotId ? { lot: row.lotId } : {}),
    ...(row.data ? { d: row.data as Record<string, unknown> } : {}),
    variant: row.variant as Variant,
    seedIndex: row.seedIndex,
  };
}

/** Events with seq > afterSeq, in order (the SSE cursor). */
export async function eventsAfter(workspaceId: string, runId: string, variant: Variant, seedIndex: number, afterSeq: number, limit: number, opts: { fromT?: number; types?: string[]; residentKey?: string } = {}): Promise<StoredEvent[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    tx.simEvent.findMany({
      where: {
        runId,
        variant,
        seedIndex,
        seq: { gt: afterSeq },
        ...(opts.fromT !== undefined ? { t: { gte: opts.fromT } } : {}),
        ...(opts.types ? { type: { in: opts.types } } : {}),
        ...(opts.residentKey ? { residentKey: opts.residentKey } : {}),
      },
      orderBy: { seq: "asc" },
      take: Math.max(1, Math.min(5_000, limit)),
      select: { seq: true, t: true, type: true, residentKey: true, lotId: true, data: true, variant: true, seedIndex: true },
    }),
  );
  return rows.map(toEvent);
}

export async function insertSnapshots(workspaceId: string, runId: string, variant: Variant, seedIndex: number, snaps: TownSnapshot[]): Promise<void> {
  if (!snaps.length) return;
  await withWorkspaceScope(workspaceId, async (tx) => {
    for (let i = 0; i < snaps.length; i += 200) {
      await tx.simSnapshot.createMany({
        data: snaps.slice(i, i + 200).map((s) => ({ workspaceId, runId, variant, seedIndex, hour: Math.floor(s.t / 60), t: s.t, state: s as unknown as Prisma.InputJsonValue })),
        skipDuplicates: true,
      });
    }
  });
}

/** The latest snapshot at or before `hour` (seeking). */
export async function snapshotAtOrBefore(workspaceId: string, runId: string, variant: Variant, seedIndex: number, hour: number): Promise<{ hour: number; t: number; state: TownSnapshot } | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.simSnapshot.findFirst({ where: { runId, variant, seedIndex, hour: { lte: Math.max(0, Math.floor(hour)) } }, orderBy: { hour: "desc" }, select: { hour: true, t: true, state: true } }),
  );
  return row ? { hour: row.hour, t: row.t, state: row.state as unknown as TownSnapshot } : null;
}

/** The first event at or after minute `t` (its seq is where a seek resumes). */
export async function firstSeqAtOrAfter(workspaceId: string, runId: string, variant: Variant, seedIndex: number, t: number): Promise<number | null> {
  const row = await withWorkspaceScope(workspaceId, (tx) => tx.simEvent.findFirst({ where: { runId, variant, seedIndex, t: { gte: t } }, orderBy: { seq: "asc" }, select: { seq: true } }));
  return row?.seq ?? null;
}

/** Every model / cached decision a run recorded (key → answer): the cache a replay starts from. */
export async function recordedDecisions(workspaceId: string, runId: string): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  let after = BigInt(0);
  for (;;) {
    const rows = await withWorkspaceScope(workspaceId, (tx) =>
      tx.simEvent.findMany({ where: { runId, type: "decision", id: { gt: after } }, orderBy: { id: "asc" }, take: 5_000, select: { id: true, data: true } }),
    );
    if (!rows.length) break;
    for (const r of rows) {
      const d = r.data as { key?: string; value?: unknown; source?: string } | null;
      if (d?.key && d.value !== undefined && d.source !== "rules") out.push([d.key, d.value]);
    }
    after = rows[rows.length - 1]!.id;
  }
  return out;
}
