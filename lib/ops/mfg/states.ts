// ShapesOS — Phase 12 (mfgpos): manufacturing status tables. Import-free on
// purpose: the entity registry (lib/ops/mfg/entities.ts → lib/ops/entities.ts)
// reads them, and the rules (lib/ops/mfg/rules.ts) re-export them.

export const MO_STATUSES = ["draft", "confirmed", "in_progress", "done", "cancelled"] as const;
export type MoStatus = (typeof MO_STATUSES)[number];

/** Nothing moves (stock, books) before done, so cancel is allowed until then. */
export const MO_TRANSITIONS: Readonly<Record<MoStatus, readonly MoStatus[]>> = {
  draft: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "done", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

export const WO_STATUSES = ["pending", "in_progress", "paused", "done", "cancelled"] as const;

export const WO_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["paused", "done", "cancelled"],
  paused: ["in_progress", "done", "cancelled"],
  done: [],
  cancelled: [],
};
