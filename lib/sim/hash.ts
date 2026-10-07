// ShapesOS — Phase 19B (WS=engine): the event log's fingerprint.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// SHA-256 over the canonical JSON lines of the event log (one event per
// line, keys in the engine's fixed order). Two runs with the same seed and
// the same inputs have the same hash — the determinism proof — and a replay
// can be checked against the original by comparing hashes. Server-only.

import { createHash } from "node:crypto";
import type { TownEvent } from "./engine";

export function hashEvents(events: readonly TownEvent[]): string {
  const h = createHash("sha256");
  for (const e of events) h.update(`${JSON.stringify(e)}\n`);
  return h.digest("hex");
}
