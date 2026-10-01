// Marketr — Wave 2 WFH mode slice 5 (SPEC-WFH-MODE.md): team rituals.
//
// Rituals are the remote culture layer: wins, kudos, virtual coffee, demo
// Friday. All rituals are OPT-IN (subscriptions), run on a cadence engine,
// keep participation history, and surface dead rituals for retirement instead
// of letting them rot silently.
//
// A ritual is workspace-level; participation is per-user. Nothing here gates
// anything — rituals are invitations, never obligations.

export type RitualType = "wins" | "kudos" | "virtual-coffee" | "demo-friday";
export type RitualCadence = "daily" | "weekly" | "biweekly" | "monthly";

export const RITUAL_TYPES = ["wins", "kudos", "virtual-coffee", "demo-friday"] as const;
export const RITUAL_CADENCES = ["daily", "weekly", "biweekly", "monthly"] as const;

export interface RitualTypeMeta {
  type: RitualType;
  name: string;
  description: string;
  defaultCadence: RitualCadence;
  prompt: string;
}

export const RITUAL_TYPE_META: Record<RitualType, RitualTypeMeta> = {
  wins: {
    type: "wins",
    name: "Wins",
    description: "Share a win from the week — big or small. Momentum is a team sport.",
    defaultCadence: "weekly",
    prompt: "What did you win this week?",
  },
  kudos: {
    type: "kudos",
    name: "Kudos",
    description: "Thank a teammate publicly. Recognition compounds.",
    defaultCadence: "weekly",
    prompt: "Who deserves kudos this week, and for what?",
  },
  "virtual-coffee": {
    type: "virtual-coffee",
    name: "Virtual coffee",
    description: "Random pairing for a 15-minute no-agenda chat. Cameras optional, humans required.",
    defaultCadence: "weekly",
    prompt: "Grab a coffee with your pair — no agenda, just talk.",
  },
  "demo-friday": {
    type: "demo-friday",
    name: "Demo Friday",
    description: "Show what you shipped. Working software only — slides optional.",
    defaultCadence: "weekly",
    prompt: "What did you ship this week? Show us.",
  },
};

export class WfhRitualError extends Error {
  code: string;
  details: string[];
  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = "WfhRitualError";
    this.code = code;
    this.details = details;
  }
}

export interface RitualDraft {
  type: RitualType;
  title?: string | null;
  description?: string | null;
  cadence?: RitualCadence;
  anchorDate?: Date | null; // first occurrence; defaults to next Monday 12:00 UTC
}

export interface ValidatedRitual {
  type: RitualType;
  title: string;
  description: string;
  cadence: RitualCadence;
  anchorDate: Date;
}

function nextMondayNoonUTC(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  const delta = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

export function validateRitual(draft: Partial<RitualDraft>, now = new Date()): {
  ok: boolean;
  errors: string[];
  normalized?: ValidatedRitual;
} {
  const errors: string[] = [];
  const meta = draft.type ? RITUAL_TYPE_META[draft.type as RitualType] : null;
  if (!meta) errors.push(`type: must be one of ${RITUAL_TYPES.join(", ")}`);

  const cadence = (draft.cadence ?? meta?.defaultCadence ?? "weekly") as RitualCadence;
  if (!(RITUAL_CADENCES as readonly string[]).includes(cadence)) {
    errors.push(`cadence: must be one of ${RITUAL_CADENCES.join(", ")}`);
  }

  const title = (draft.title ?? "").trim() || meta?.name || "";
  const description = (draft.description ?? "").trim() || meta?.description || "";
  if (title.length > 120) errors.push("title: max 120 characters");
  if (description.length > 500) errors.push("description: max 500 characters");

  let anchorDate: Date | null = null;
  if (draft.anchorDate instanceof Date && !isNaN(draft.anchorDate.getTime())) {
    anchorDate = draft.anchorDate;
  } else if (typeof draft.anchorDate === "string" && draft.anchorDate) {
    const d = new Date(draft.anchorDate);
    if (!isNaN(d.getTime())) anchorDate = d;
  }
  if (anchorDate == null) anchorDate = nextMondayNoonUTC(now);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    normalized: { type: draft.type as RitualType, title, description, cadence, anchorDate },
  };
}

// ── Cadence engine ──────────────────────────────────────────────────────────
// A ritual "fires" on each cadence step from its anchor date. nextOccurrence
// returns the next fire at-or-after `now`; isDue says whether one fired since
// the last recorded occurrence (i.e. the ritual is waiting on this round).

const CADENCE_DAYS: Record<RitualCadence, number> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
  monthly: 30,
};

export function nextOccurrence(anchorDate: Date, cadence: RitualCadence, now: Date): Date {
  const stepMs = CADENCE_DAYS[cadence] * 24 * 3600 * 1000;
  const anchor = anchorDate.getTime();
  if (anchor >= now.getTime()) return new Date(anchor);
  const elapsed = now.getTime() - anchor;
  const steps = Math.ceil(elapsed / stepMs);
  return new Date(anchor + steps * stepMs);
}

export function occurrencesSince(
  anchorDate: Date,
  cadence: RitualCadence,
  from: Date,
  to: Date,
): Date[] {
  const stepMs = CADENCE_DAYS[cadence] * 24 * 3600 * 1000;
  const out: Date[] = [];
  let t = nextOccurrence(anchorDate, cadence, from).getTime();
  const end = to.getTime();
  while (t <= end) {
    out.push(new Date(t));
    t += stepMs;
  }
  return out;
}

// ── Dead-ritual surfacing ───────────────────────────────────────────────────
// A ritual is "dead" when recent rounds had no participation: over the last
// `windowRounds` scheduled occurrences, fewer than `minParticipation` total
// participation events. The UI surfaces it with a retirement suggestion; the
// OS never auto-deletes a ritual — the team decides.

export interface DeadRitualInput {
  ritualId: string;
  anchorDate: Date;
  cadence: RitualCadence;
  active: boolean;
  recentOccurrences: Date[];
  participationCount: number; // participations across recentOccurrences
  subscriberCount: number;
}

export interface DeadRitualVerdict {
  dead: boolean;
  reason: string | null;
  suggestion: string | null;
}

export function assessRitualHealth(
  input: DeadRitualInput,
  windowRounds = 4,
  minParticipation = 1,
): DeadRitualVerdict {
  if (!input.active) {
    return { dead: false, reason: null, suggestion: null };
  }
  if (input.subscriberCount === 0) {
    return {
      dead: true,
      reason: "Nobody is subscribed — this ritual has no audience.",
      suggestion: "Retire it, or relaunch with a smaller, invited group.",
    };
  }
  const rounds = Math.min(windowRounds, input.recentOccurrences.length);
  if (rounds < windowRounds) {
    return { dead: false, reason: null, suggestion: null }; // too young to judge
  }
  if (input.participationCount < minParticipation) {
    return {
      dead: true,
      reason: `No participation in the last ${windowRounds} rounds.`,
      suggestion: "Retire it, or shrink the cadence and relaunch.",
    };
  }
  return { dead: false, reason: null, suggestion: null };
}
