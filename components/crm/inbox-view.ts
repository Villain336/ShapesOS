// ShapesOS CRM inbox — view rules (pure; unit-tested in __tests__).
//
// How a ledger row reads in the conversation: an outbound reply waiting on a
// human approval is a "needs you" state (yellow triangle); a send that went
// out is done; a send the dispatcher blocked or the provider rejected is
// failed. Everything else (scheduled, sending, inbound) is neutral.

export type MessageMark = "needs" | "done" | "failed" | "queued" | null;

export interface ViewMessage {
  direction: "inbound" | "outbound";
  status: string;
  approvalStatus: string | null;
  suppressionReason: string | null;
}

export function messageMark(m: ViewMessage): { mark: MessageMark; label: string } {
  if (m.direction === "inbound") return { mark: null, label: "Received" };
  switch (m.status) {
    case "queued":
      if (m.approvalStatus === "pending") return { mark: "needs", label: "Waiting for approval" };
      if (m.approvalStatus === "rejected") return { mark: "failed", label: "Approval denied" };
      return { mark: "queued", label: "Scheduled" };
    case "sending":
      return { mark: "queued", label: "Sending" };
    case "sent":
      return { mark: "done", label: "Sent" };
    case "delivered":
      return { mark: "done", label: "Delivered" };
    case "suppressed":
      return { mark: "failed", label: "Not sent" };
    case "failed":
      return { mark: "failed", label: "Failed" };
    default:
      return { mark: null, label: m.status.replace(/_/g, " ") };
  }
}

/** Compact age for thread rows: "now", "5m", "3h", "2d", then a date. */
export function shortAge(iso: string, now: Date = new Date()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const CHANNEL_LABEL: Record<string, string> = { sms: "SMS", email: "Email" };

export type ConsentStatus = "unknown" | "pending" | "opted_in" | "opted_out";

/** Composer hint for the lead's consent on a channel (null = nothing to say). */
export function consentHint(channel: "sms" | "email", status: ConsentStatus | undefined): string | null {
  const what = channel === "sms" ? "texts" : "email";
  if (status === "opted_out") return `This lead opted out of ${what}. The reply will be logged as not sent.`;
  if (status !== "opted_in") return `No ${what} consent on file. The reply will be logged as not sent until consent is recorded.`;
  return null;
}

/** Which channel a reply should default to: the newest inbound message's channel, else the newest message's. */
export function defaultReplyChannel(
  messages: Array<{ channel: string; direction: string }>,
  available: { sms: boolean; email: boolean },
): "sms" | "email" | null {
  const pick = (c: string | undefined) => (c === "sms" && available.sms) || (c === "email" && available.email);
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  if (lastInbound && pick(lastInbound.channel)) return lastInbound.channel as "sms" | "email";
  const last = messages[messages.length - 1];
  if (last && pick(last.channel)) return last.channel as "sms" | "email";
  return available.sms ? "sms" : available.email ? "email" : null;
}

/** Newest message time in a thread (what "mark read" acknowledges). */
export function newestAt(messages: Array<{ createdAt: string }>): string | null {
  let best: string | null = null;
  for (const m of messages) if (!best || m.createdAt > best) best = m.createdAt;
  return best;
}
