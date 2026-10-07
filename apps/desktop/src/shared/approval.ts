// ShapesOS Desktop: proposal cards and the approval gate.
//
// MONEY SAFETY (owner law): Tier 3 and destructive actions are NEVER approved
// by voice. A spoken "yes" for such a proposal is ignored here, the card says
// "Click to approve; voice can't approve this", and the server refuses
// via=voice for it too (403 voice_not_allowed). Only a click on the card's
// Approve button sends via=click.

import type { ApproveRequest, ProposalEvent } from "./contract";

export type VoiceAnswer = "yes" | "no" | null;

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|approve|approved|do it|go ahead|confirm|confirmed|send it|paste|paste it)$/;
const NO = /^(no|nope|nah|reject|rejected|cancel|deny|denied|stop|don't|do not|never mind|nevermind)$/;

/** A short spoken reply → yes / no / not an answer (anything longer is a new question). */
export function parseVoiceAnswer(transcript: string): VoiceAnswer {
  const t = transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(uh|um|hmm|well|so|and|oh) /, "")
    .replace(/ (please|thanks|thank you)$/, "")
    .trim();
  if (!t || t.split(" ").length > 4) return null;
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return null;
}

/** Whether a proposal may be decided by voice at all. Belt and braces: never Tier 3, never destructive. */
export function voiceCanApprove(p: Pick<ProposalEvent, "tier" | "destructive" | "voiceApprovable">): boolean {
  return p.voiceApprovable === true && p.tier !== 3 && p.destructive !== true;
}

export type GateResult =
  | { action: "send"; request: ApproveRequest; say: string }
  | { action: "ignore"; say: string };

/**
 * A spoken answer to a pending proposal. "no" always rejects (rejecting is
 * safe). "yes" approves only when voice may approve; otherwise it is ignored
 * and the card keeps waiting for a click.
 */
export function gateVoice(p: ProposalEvent, answer: Exclude<VoiceAnswer, null>): GateResult {
  if (answer === "no") {
    return {
      action: "send",
      request: { approvalId: p.approvalId, decision: "reject", via: "voice" },
      say: "Rejected.",
    };
  }
  if (!voiceCanApprove(p)) {
    return { action: "ignore", say: "Click to approve; voice can't approve this." };
  }
  return {
    action: "send",
    request: { approvalId: p.approvalId, decision: "approve", via: "voice" },
    say: "Approved.",
  };
}

/** A click on the card (the only path for Tier 3 and destructive actions). */
export function gateClick(p: ProposalEvent, decision: "approve" | "reject"): ApproveRequest {
  return { approvalId: p.approvalId, decision, via: "click" };
}

/** What the proposal card shows under the summary. */
export function proposalHint(p: ProposalEvent): string {
  return voiceCanApprove(p) ? "Say yes or no, or click." : "Click to approve; voice can't approve this.";
}

/** The tier label shown on the card (sentence case). */
export function tierLabel(p: Pick<ProposalEvent, "tier" | "destructive">): string {
  if (p.destructive) return "Destructive";
  return ["Tier 0", "Tier 1", "Tier 2", "Tier 3 (money)"][p.tier] ?? `Tier ${p.tier}`;
}
