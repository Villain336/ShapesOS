// ShapesOS — Phase 12 (mfgpos): till session status table. Import-free: the
// entity registry and the rules both read it.

export const POS_SESSION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  open: ["closing"],
  closing: ["open", "closed"],
  closed: [],
};
