// ShapesOS CRM — lead action rules (pure; unit-tested in __tests__).
//
// Which actions a lead supports, and the request bodies the lead panel sends
// to the existing APIs:
//   email / text → POST /api/messaging/send (queued behind a human approval)
//   call         → tel: link + a "call" activity on the timeline (there is
//                  no outbound-dialing API; nothing is placed for the user)
//   nurture      → POST /api/nurture/sequences/[id]/enroll (Undo = unenroll)
//   invoice      → POST /api/ops/invoices via NewInvoiceModal (customer = lead)
//   delete       → DELETE /api/crm/leads/[id] (confirmed; activities cascade)

export type LeadChannel = "email" | "sms";

export interface LeadContact {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
}

export interface ActionAvailability {
  enabled: boolean;
  /** Why it's disabled, phrased as the fix. */
  reason?: string;
}

export function leadActionAvailability(lead: LeadContact): {
  email: ActionAvailability;
  sms: ActionAvailability;
  call: ActionAvailability;
} {
  const email = lead.email?.trim();
  const phone = lead.phone?.trim();
  const noPhone = "Add a phone number to this lead first.";
  return {
    email: email ? { enabled: true } : { enabled: false, reason: "Add an email address to this lead first." },
    sms: phone ? { enabled: true } : { enabled: false, reason: noPhone },
    call: phone ? { enabled: true } : { enabled: false, reason: noPhone },
  };
}

/** `tel:` href with formatting characters stripped (keeps a leading +). */
export function telHref(phone: string): string | null {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith("+") ? "+" : "";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 3) return null;
  return `tel:${plus}${digits}`;
}

export interface ComposeDraft {
  channel: LeadChannel;
  subject: string;
  body: string;
}

export const SMS_MAX = 1600;
export const EMAIL_SUBJECT_MAX = 200;
export const BODY_MAX = 5000;

/** Validate a draft; returns the first problem, or null when sendable. */
export function validateDraft(d: ComposeDraft): string | null {
  const body = d.body.trim();
  if (!body) return "Write a message first.";
  if (d.channel === "email") {
    if (!d.subject.trim()) return "Add a subject.";
    if (d.subject.trim().length > EMAIL_SUBJECT_MAX) return `Keep the subject under ${EMAIL_SUBJECT_MAX} characters.`;
    if (body.length > BODY_MAX) return `Keep the message under ${BODY_MAX} characters.`;
  } else if (body.length > SMS_MAX) {
    return `Keep texts under ${SMS_MAX} characters.`;
  }
  return null;
}

/** Body for POST /api/messaging/send (manual, approval-gated). */
export function buildSendRequest(leadId: string, d: ComposeDraft) {
  return {
    leadId,
    channel: d.channel,
    kind: "manual" as const,
    ...(d.channel === "email" ? { subject: d.subject.trim() } : {}),
    body: d.body.trim(),
  };
}

const CHANNEL_NOUN: Record<LeadChannel, string> = { email: "email", sms: "texts" };

/**
 * Read the /api/messaging/send response. The dispatcher never sends without
 * opt-in: a lead without consent comes back "suppressed", which must not be
 * reported as queued.
 */
export function interpretSend(
  leadName: string,
  channel: LeadChannel,
  json: { message?: { status?: string; suppressionReason?: string | null } } | null | undefined,
): { queued: boolean; title: string; description: string } {
  const status = json?.message?.status;
  if (status && status !== "suppressed") {
    return {
      queued: true,
      title: channel === "email" ? "Email waiting for approval" : "Text waiting for approval",
      description: "Nothing is sent until someone approves it.",
    };
  }
  const noun = CHANNEL_NOUN[channel];
  const contact = channel === "email" ? "email address" : "phone number";
  const reason = json?.message?.suppressionReason ?? "";
  const description =
    reason === "opt_out"
      ? `${leadName} opted out of ${noun}.`
      : reason === "no_consent"
        ? `${leadName} hasn't opted in to ${noun}. Record their consent in Nurture, then try again.`
        : reason === "cap"
          ? "Today's sending cap is reached. Try again tomorrow."
          : reason === "credit_cap"
            ? "Messaging credits are used up. Add credits in Billing."
            : reason === "invalid_contact"
              ? `The lead's ${contact} looks invalid. Fix it and try again.`
              : "The message was suppressed.";
  return { queued: false, title: "Not sent", description };
}

export interface EnrollResult {
  leadId: string;
  ok: boolean;
  alreadyEnrolled?: boolean;
  error?: string;
}

/**
 * Read the enroll response for one lead. Undo (unenroll) is offered only for
 * a fresh enrollment; unenrolling someone who was already in the sequence
 * would undo more than this click did.
 */
export function interpretEnroll(
  leadId: string,
  json: { results?: EnrollResult[] } | null | undefined,
): { ok: boolean; offerUndo: boolean; message: string } {
  const r = json?.results?.find((x) => x.leadId === leadId);
  if (!r) return { ok: false, offerUndo: false, message: "Enrollment failed." };
  if (!r.ok) return { ok: false, offerUndo: false, message: r.error ?? "Enrollment failed." };
  if (r.alreadyEnrolled) return { ok: true, offerUndo: false, message: "Already enrolled" };
  return { ok: true, offerUndo: true, message: "Enrolled" };
}

/** Sequences a lead can be enrolled in (archived ones refuse enrollment). */
export function enrollableSequences<T extends { status: string }>(sequences: T[]): T[] {
  return sequences.filter((s) => s.status !== "archived");
}
