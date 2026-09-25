// Marketr — Phase 6 deliverability & outreach guards (pure).
// SPEC-PHASE6.md §9 invariants 2–5. Fail closed: any violation throws.
// These are structural — not configurable, not skippable.

export class DeliverabilityBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeliverabilityBlockedError";
    this.code = code;
  }
}

export interface SendingDomainChecklistInput {
  domain: string;
  isPrimary: boolean;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcPolicy: string | null;
  warmupStartedAt: Date | null;
  warmupStage: number; // days elapsed
  trackingCnameOk: boolean;
  isGmailFree: boolean;
}

export interface ChecklistFailure {
  code: string;
  message: string;
}

export const MIN_WARMUP_DAYS = 30;
export const MAX_DAILY_PER_MAILBOX = 50;
export const DEFAULT_DAILY_PER_MAILBOX = 30;
export const BOUNCE_PAUSE_PCT = 3;
export const BOUNCE_STOP_PCT = 5;
export const SPAM_CEILING_PCT = 0.3;

/** Depth-3 enablement checklist. Returns failures (empty = may activate). */
export function depth3Checklist(d: SendingDomainChecklistInput): ChecklistFailure[] {
  const failures: ChecklistFailure[] = [];
  if (d.isPrimary) {
    failures.push({ code: "primary_domain", message: `Primary domain "${d.domain}" may never cold-send. Use a secondary domain.` });
  }
  if (d.isGmailFree) {
    failures.push({ code: "gmail_free", message: "Gmail free accounts are blocked. Use Workspace/M365 or a sending-partner inbox." });
  }
  if (!d.warmupStartedAt || d.warmupStage < MIN_WARMUP_DAYS) {
    failures.push({
      code: "warmup_incomplete",
      message: `Domain warmup is ${d.warmupStage}d; ${MIN_WARMUP_DAYS}+ days with ramp history are required.`,
    });
  }
  if (!d.spfOk || !d.dkimOk) {
    failures.push({ code: "auth_missing", message: "SPF and DKIM must both verify before sending." });
  }
  const dmarc = (d.dmarcPolicy ?? "").toLowerCase();
  if (dmarc !== "quarantine" && dmarc !== "reject") {
    failures.push({ code: "dmarc_weak", message: "DMARC policy must be p=quarantine or p=reject." });
  }
  if (!d.trackingCnameOk) {
    failures.push({ code: "tracking_cname", message: "Custom tracking CNAME must be set (shared tracking domains burn reputation)." });
  }
  return failures;
}

/** Assert depth-3 activation is allowed; throws naming the specific missing items. */
export function assertDepth3Enabled(d: SendingDomainChecklistInput): void {
  const failures = depth3Checklist(d);
  if (failures.length > 0) {
    throw new DeliverabilityBlockedError(
      "depth3_checklist_failed",
      `Depth-3 activation blocked: ${failures.map((f) => f.message).join(" ")}`,
    );
  }
}

/** CASL: Canada cold pitching is a hard block, not a warning. */
const CA_TLDS = new Set([".ca"]);
export function assertNotCanadaCold(email: string, country?: string): void {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  if (country?.toUpperCase() === "CA" || [...CA_TLDS].some((t) => domain.endsWith(t))) {
    throw new DeliverabilityBlockedError("casl_block", `Cold pitching ${email} is blocked (CASL consent requirement).`);
  }
}

/** Daily cap enforcement: 30–50/day/mailbox (strict default 30). */
export function assertDailyCap(sentToday: number, cap: number): void {
  const effective = Math.min(Math.max(cap, 1), MAX_DAILY_PER_MAILBOX);
  if (sentToday >= effective) {
    throw new DeliverabilityBlockedError("daily_cap", `Daily cap reached (${sentToday}/${effective} for this mailbox).`);
  }
}

/** Bounce circuit-breaker: <2% healthy, pause 3–5%, hard stop >5%. */
export function bounceAction(bouncePct: number): "ok" | "pause" | "stop" {
  if (bouncePct > BOUNCE_STOP_PCT) return "stop";
  if (bouncePct >= BOUNCE_PAUSE_PCT) return "pause";
  return "ok";
}

/** Spam-rate ceiling: hard ceiling 0.30% (Google/Yahoo bulk rules). */
export function assertSpamCeiling(spamPct: number): void {
  if (spamPct >= SPAM_CEILING_PCT) {
    throw new DeliverabilityBlockedError("spam_ceiling", `Spam complaint rate ${spamPct}% hit the ${SPAM_CEILING_PCT}% ceiling — sending halted.`);
  }
}

/** Suppression check: hashed-email set. Instant enforcement, same-cycle. */
export function isSuppressed(hashedEmail: string, entries: Set<string>): boolean {
  return entries.has(hashedEmail);
}

/** Journalist rules (O2): max 2 follow-ups at 48h+ cadence, 1:1 sends, no attachments. */
export function assertJournalistSendAllowed(opts: {
  followUpCount: number;
  lastSentAt: Date | null;
  hasAttachment: boolean;
  isBcc: boolean;
  subject: string;
  now?: Date;
}): void {
  const now = opts.now ?? new Date();
  if (opts.hasAttachment) {
    throw new DeliverabilityBlockedError("journalist_attachment", "Journalist pitches must not include attachments — paste text, link a Drive kit.");
  }
  if (opts.isBcc) {
    throw new DeliverabilityBlockedError("journalist_bcc", "Journalist pitches are 1:1 sends only — BCC breaks embargoes.");
  }
  if (opts.subject.length > 49) {
    throw new DeliverabilityBlockedError("journalist_subject", `Subject is ${opts.subject.length} chars; keep ≤49.`);
  }
  if (opts.followUpCount >= 2) {
    throw new DeliverabilityBlockedError("journalist_followup_cap", "Max 2 follow-ups per journalist — further contact is manual.");
  }
  if (opts.lastSentAt && now.getTime() - opts.lastSentAt.getTime() < 48 * 3600 * 1000) {
    throw new DeliverabilityBlockedError("journalist_cadence", "Follow-ups require 48h+ cadence.");
  }
}
