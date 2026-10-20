// ShapesOS — Deploy PR (WS=state): the live-watch frame relay across
// processes.
//
// lib/agents/runs/watch.ts fans JPEG frames out to subscribers IN ONE
// PROCESS. In production the recording runs on the worker while the
// dashboard's SSE (GET /api/agent-runs/[runId]/watch) is served by any web
// replica, so frames also pass through Postgres (agent_run_watch_frames,
// UNLOGGED, FORCE RLS — see its migration):
//
//   producer (worker)                          consumer (any web replica)
//   open()      row: seq 0, not ended          poll(afterSeq) every ~300 ms:
//   heartbeat() every 2 s → "is anyone            marks watched_until = now+10 s
//               watching?" (watched_until)        and returns the newest frame
//   publish()   only while watched, at most       when seq > afterSeq
//               every 250 ms (latest-wins)     stale (no heartbeat for 15 s)
//   end()       deletes the row                   or missing → ended
//
// So an unwatched run never ships a frame to the database, a watched run
// ships at most four frames a second, and frames never outlive the stream.
// All timestamps are the database's own now() (no clock skew between
// replicas). Every call is workspace-scoped (withWorkspaceScope).

import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

/** Producer heartbeat (and how quickly a new viewer gets frames). */
export const WATCH_RELAY_HEARTBEAT_MS = 2_000;
/** Minimum spacing between frame uploads (latest-wins in between). */
export const WATCH_RELAY_FLUSH_MS = 250;
/** Consumer poll interval. */
export const WATCH_RELAY_POLL_MS = 300;
/** A stream with no producer heartbeat for this long is over (crashed producer). */
export const WATCH_RELAY_STALE_MS = 15_000;
/** How long one consumer poll keeps the producer uploading. */
export const WATCH_RELAY_WATCHED_MS = 10_000;

export type RelayPoll =
  | { state: "live"; frame: { seq: number; jpeg: Buffer } | null }
  | { state: "ended" };

export interface WatchRelay {
  /** Claim (or reset) the run's relay row. */
  open(workspaceId: string, runId: string): Promise<void>;
  /** Producer keep-alive; true while at least one viewer polled recently. */
  heartbeat(workspaceId: string, runId: string): Promise<{ watched: boolean; exists: boolean }>;
  /** Upload the latest frame; returns its seq and whether it is still watched. */
  publish(workspaceId: string, runId: string, jpeg: Buffer): Promise<{ seq: number; watched: boolean } | null>;
  /** Stream over: drop the row (frames are transient). */
  end(workspaceId: string, runId: string): Promise<void>;
  /** Consumer: register interest and fetch the newest frame after `afterSeq`. */
  poll(workspaceId: string, runId: string, afterSeq: number): Promise<RelayPoll>;
  /** Is a producer streaming this run anywhere? */
  isLive(workspaceId: string, runId: string): Promise<boolean>;
}

async function scope<T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  return withWorkspaceScope(workspaceId, fn);
}

const staleSec = WATCH_RELAY_STALE_MS / 1000;
const watchedSec = WATCH_RELAY_WATCHED_MS / 1000;

export function postgresWatchRelay(): WatchRelay {
  return {
    async open(workspaceId, runId) {
      await scope(workspaceId, (tx) =>
        tx.$executeRaw`
          INSERT INTO "agent_run_watch_frames" ("run_id", "workspace_id", "seq", "jpeg", "ended", "updated_at", "watched_until")
          VALUES (${runId}, ${workspaceId}, 0, NULL, false, now(), NULL)
          ON CONFLICT ("run_id") DO UPDATE
            SET "seq" = 0, "jpeg" = NULL, "ended" = false, "updated_at" = now()`,
      );
    },
    async heartbeat(workspaceId, runId) {
      const rows = await scope(workspaceId, (tx) =>
        tx.$queryRaw<Array<{ watched: boolean }>>`
          UPDATE "agent_run_watch_frames" SET "updated_at" = now()
           WHERE "run_id" = ${runId} AND NOT "ended"
       RETURNING COALESCE("watched_until" > now(), false) AS "watched"`,
      );
      return { exists: rows.length > 0, watched: rows[0]?.watched === true };
    },
    async publish(workspaceId, runId, jpeg) {
      const rows = await scope(workspaceId, (tx) =>
        tx.$queryRaw<Array<{ seq: number; watched: boolean }>>`
          UPDATE "agent_run_watch_frames"
             SET "seq" = "seq" + 1, "jpeg" = ${jpeg}, "updated_at" = now()
           WHERE "run_id" = ${runId} AND NOT "ended"
       RETURNING "seq", COALESCE("watched_until" > now(), false) AS "watched"`,
      );
      const r = rows[0];
      return r ? { seq: Number(r.seq), watched: r.watched === true } : null;
    },
    async end(workspaceId, runId) {
      await scope(workspaceId, (tx) => tx.$executeRaw`DELETE FROM "agent_run_watch_frames" WHERE "run_id" = ${runId}`);
    },
    async poll(workspaceId, runId, afterSeq) {
      const rows = await scope(workspaceId, (tx) =>
        tx.$queryRaw<Array<{ seq: number; ended: boolean; stale: boolean; jpeg: Uint8Array | null }>>`
          UPDATE "agent_run_watch_frames"
             SET "watched_until" = now() + make_interval(secs => ${watchedSec}::double precision)
           WHERE "run_id" = ${runId}
       RETURNING "seq", "ended",
                 "updated_at" < now() - make_interval(secs => ${staleSec}::double precision) AS "stale",
                 CASE WHEN "seq" > ${Math.floor(afterSeq)}::int THEN "jpeg" END AS "jpeg"`,
      );
      const r = rows[0];
      if (!r || r.ended || r.stale) return { state: "ended" };
      return { state: "live", frame: r.jpeg ? { seq: Number(r.seq), jpeg: Buffer.from(r.jpeg) } : null };
    },
    async isLive(workspaceId, runId) {
      const rows = await scope(workspaceId, (tx) =>
        tx.$queryRaw<Array<{ live: boolean }>>`
          SELECT true AS "live" FROM "agent_run_watch_frames"
           WHERE "run_id" = ${runId} AND NOT "ended"
             AND "updated_at" >= now() - make_interval(secs => ${staleSec}::double precision)`,
      );
      return rows.length > 0;
    },
  };
}
