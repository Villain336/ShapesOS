// ShapesOS — Phase 19B (WS=engine): the event log's fingerprint.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// SHA-256 over the canonical JSON lines of the event log (one event per
// line, object keys sorted at every level — a decision answered from a
// cache that went through Postgres JSONB, which reorders keys, hashes like
// the model's own answer). Two runs with the same seed and
// the same inputs have the same hash — the determinism proof — and a replay
// is checked against the original by comparing hashes. The fingerprint
// covers WHAT happened, not who answered a decision: a decision event's
// provenance (`source`: model / cache, and its `credits`) is left out, so a
// replay answered entirely from the recorded cache hashes like the original.
// Server-only.

import { createHash, type Hash } from "node:crypto";
import type { TownEvent } from "./engine";

/** JSON with object keys sorted at every level. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

function line(e: TownEvent): string {
  if (e.type !== "decision" || !e.d) return canonicalJson(e);
  const { source: _s, credits: _c, ...d } = e.d as Record<string, unknown>;
  return canonicalJson({ ...e, d });
}

export function hashEvents(events: readonly TownEvent[]): string {
  const h = createHash("sha256");
  for (const e of events) h.update(`${line(e)}\n`);
  return h.digest("hex");
}

/** Incremental form (the worker hashes as events stream, without keeping them). */
export class EventHasher {
  private readonly h: Hash = createHash("sha256");
  add(e: TownEvent): void {
    this.h.update(`${line(e)}\n`);
  }
  digest(): string {
    return this.h.digest("hex");
  }
}
