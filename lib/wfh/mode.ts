// Marketr — Wave 2 WFH mode slice 1: WorkMode domain rules.
//
// The mode switch is per-user (workspaceId + userId), never per-workspace.
// Enabling wfh/hybrid for the first time requires the mandatory 60-second
// setup interstitial (wfh days, focus hours, standup cadence) — enabling
// without it fails closed with SETUP_REQUIRED so the user understands what
// changed before the OS starts batching notifications and proposing focus
// blocks. Disabling back to office never requires the gate.

export type WfhMode = "wfh" | "office" | "hybrid";
export type WfhStandupCadence = "daily" | "none";
export type WfhNotificationProfile = "realtime" | "batched";

export const WFH_MODES: WfhMode[] = ["wfh", "office", "hybrid"];
export const WFH_DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WfhDayCode = (typeof WFH_DAY_CODES)[number];

const JS_DAY_TO_CODE: Record<number, WfhDayCode> = {
  0: "sun",
  1: "mon",
  2: "tue",
  3: "wed",
  4: "thu",
  5: "fri",
  6: "sat",
};

export interface SetupInput {
  wfhDays?: unknown;
  focusStartMin?: unknown;
  focusEndMin?: unknown;
  focusBlockMinutes?: unknown;
  standupCadence?: unknown;
  notificationProfile?: unknown;
}

export interface NormalizedSetup {
  wfhDays: WfhDayCode[];
  focusStartMin: number;
  focusEndMin: number;
  focusBlockMinutes: number;
  standupCadence: WfhStandupCadence;
  notificationProfile: WfhNotificationProfile;
}

export interface SetupValidation {
  ok: boolean;
  errors: string[];
  normalized: NormalizedSetup | null;
}

/**
 * Validate the first-enable setup interstitial. Pure — no I/O.
 * Focus hours are minutes since midnight local; start must precede end and
 * the window must fit at least one focus block.
 */
export function validateSetupInput(input: SetupInput): SetupValidation {
  const errors: string[] = [];

  const rawDays = Array.isArray(input.wfhDays) ? input.wfhDays : [];
  const wfhDays = rawDays
    .map((d) => String(d).toLowerCase().trim())
    .filter((d): d is WfhDayCode => (WFH_DAY_CODES as readonly string[]).includes(d));
  const daySet = new Set(wfhDays);
  if (daySet.size === 0) {
    errors.push("Pick at least one WFH day (mon–sun).");
  }

  const start = toInt(input.focusStartMin);
  const end = toInt(input.focusEndMin);
  const blockMin = toInt(input.focusBlockMinutes) ?? 90;
  if (start == null || end == null || start < 0 || end > 1440 || start >= end) {
    errors.push("Focus hours must be a valid window (start before end, within 00:00–24:00).");
  }
  if (blockMin < 15 || blockMin > 480) {
    errors.push("Focus block length must be between 15 and 480 minutes.");
  }
  if (start != null && end != null && blockMin > 0 && end - start < blockMin) {
    errors.push("The focus window must fit at least one focus block.");
  }

  const cadence = String(input.standupCadence ?? "daily").toLowerCase();
  if (cadence !== "daily" && cadence !== "none") {
    errors.push("Standup cadence must be 'daily' or 'none'.");
  }

  const profile = String(input.notificationProfile ?? "batched").toLowerCase();
  if (profile !== "realtime" && profile !== "batched") {
    errors.push("Notification profile must be 'realtime' or 'batched'.");
  }

  if (errors.length > 0) {
    return { ok: false, errors, normalized: null };
  }
  return {
    ok: true,
    errors: [],
    normalized: {
      wfhDays: [...daySet],
      focusStartMin: start as number,
      focusEndMin: end as number,
      focusBlockMinutes: blockMin,
      standupCadence: cadence as WfhStandupCadence,
      notificationProfile: profile as WfhNotificationProfile,
    },
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** Minimal persisted-shape view the transition functions need. */
export interface WorkModeState {
  mode: WfhMode;
  wfhDays: string[];
  setupCompletedAt: Date | null;
}

export class WfhModeError extends Error {
  readonly code: "SETUP_REQUIRED" | "VALIDATION_FAILED" | "NO_MODE_ROW";
  readonly details: string[];
  constructor(code: WfhModeError["code"], message: string, details: string[] = []) {
    super(message);
    this.name = "WfhModeError";
    this.code = code;
    this.details = details;
  }
}

export interface ModeTransition {
  previousMode: WfhMode;
  newMode: WfhMode;
  setup: NormalizedSetup | null;
  reason: string;
}

/**
 * Enable wfh or hybrid. Requires either a completed setup on the current row
 * or valid setup input in this call. Throws WfhModeError(SETUP_REQUIRED /
 * VALIDATION_FAILED). Pure.
 */
export function enableWfhMode(
  current: WorkModeState | null,
  target: "wfh" | "hybrid",
  setupInput?: SetupInput,
  reason = "user_toggle",
): ModeTransition {
  const previousMode = current?.mode ?? "office";
  if (current?.setupCompletedAt) {
    return { previousMode, newMode: target, setup: null, reason };
  }
  const validation = validateSetupInput(setupInput ?? {});
  if (!validation.ok || !validation.normalized) {
    throw new WfhModeError(
      current ? "SETUP_REQUIRED" : "VALIDATION_FAILED",
      current
        ? "Finish the 60-second WFH setup before turning the mode on."
        : "The WFH setup interstitial must be completed before enabling WFH mode.",
      validation.errors,
    );
  }
  return { previousMode, newMode: target, setup: validation.normalized, reason };
}

/**
 * Disable back to office. Always allowed, keeps preferences for next time.
 */
export function disableToOffice(current: WorkModeState | null, reason = "user_toggle"): ModeTransition {
  const previousMode = current?.mode ?? "office";
  return { previousMode, newMode: "office", setup: null, reason };
}

/**
 * Toggle between wfh and office. Enabling wfh requires the setup gate
 * (completed setup or valid setup input); toggling off never does.
 */
export function toggleMode(
  current: WorkModeState | null,
  setupInput?: SetupInput,
): ModeTransition {
  const active = current && current.mode !== "office";
  if (active) return disableToOffice(current);
  return enableWfhMode(current, "wfh", setupInput);
}

/**
 * Is WFH effectively on for the given day? wfh = always; hybrid = only on
 * configured wfh days; office = never.
 */
export function isWfhEffectiveOn(state: WorkModeState | null, at: Date): boolean {
  if (!state || state.mode === "office") return false;
  if (state.mode === "wfh") return true;
  const code = JS_DAY_TO_CODE[at.getDay()];
  return state.wfhDays.map((d) => d.toLowerCase()).includes(code);
}

/** Chrome indicator state: the badge the OS shell shows so the user trusts the mode is real. */
export interface ModeIndicator {
  active: boolean;
  label: string;
  tone: "wfh" | "office";
}

export function modeIndicator(state: WorkModeState | null): ModeIndicator {
  if (!state || state.mode === "office") {
    return { active: false, label: "Office mode", tone: "office" };
  }
  return {
    active: true,
    label: state.mode === "hybrid" ? "Hybrid · WFH days on" : "WFH mode",
    tone: "wfh",
  };
}
