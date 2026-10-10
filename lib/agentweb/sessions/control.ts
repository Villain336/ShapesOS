// ShapesOS — Phase 21A round 2 (WS=agentweb): who may take the next browser step (PURE).
//
// A browsing session is an AgentRun that uses the governed browser. A person supervising it can:
//   pause / resume      the agent does nothing until resumed (reads too);
//   take over / hand back   the person drives; the agent's steps are refused until handed back;
//   review each step    every click, type or navigate the agent proposes waits for approve/reject;
// and the session has caps on steps, time and credits (credits are the same 1.5x model-cost
// credits as everywhere else). A refused step tells the agent exactly why, in words it can act
// on ("wait", "a person is driving"), so it does not hammer the tool.

import { llmTokenCredits } from "@/lib/metering/credits";

export type Control = "agent" | "paused" | "human";
export type StepMode = "auto" | "approve_each";
export type NeedsReason = "cap_steps" | "cap_time" | "cap_credits" | "proposal" | "blocked_by_site" | "teach_check";
export type GateReason = "paused" | "human_control" | "cap_steps" | "cap_time" | "cap_credits" | "proposal" | "note";

export interface Pending {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  proposedAt: string;
}

export interface SessionState {
  control: Control;
  stepMode: StepMode;
  steps: number;
  maxSteps: number;
  /** ms since epoch */
  startedAt: number;
  maxSeconds: number;
  costMicroUsd: number;
  maxCredits: number;
  pending: Pending | null;
  lastNote: string | null;
}

export type Gate =
  | { allow: true }
  | { allow: false; reason: GateReason; message: string; needs?: NeedsReason; propose?: { tool: string; args: Record<string, unknown> }; consumeNote?: true };

/** Tools that only look: a review-each-step session still lets these run. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["browser_snapshot", "browser_tabs", "browser_screenshot", "web_channels"]);

export const creditsOf = (costMicroUsd: number): number => llmTokenCredits(costMicroUsd);

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const SECRETISH = new Set(["text", "value", "password", "secret"]);
/** Typed values never reach the database: a stored proposal keeps the step's shape, not its text. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, SECRETISH.has(k) && typeof v === "string" ? `«${v.length} characters»` : v]));
}

export const fingerprint = (tool: string, args: Record<string, unknown>): string => `${tool}:${canon(args)}`;

export function gate(s: SessionState, tool: string, args: Record<string, unknown>, nowMs: number): Gate {
  if (s.control === "paused") return { allow: false, reason: "paused", message: "The person paused this session. Wait: do nothing and do not retry until they resume it." };
  if (s.control === "human") return { allow: false, reason: "human_control", message: "A person has taken over this session and is driving it. Do not send steps; wait until they hand it back." };
  if (s.steps >= s.maxSteps) return { allow: false, reason: "cap_steps", needs: "cap_steps", message: `This session reached its limit of ${s.maxSteps} steps. A person has to raise the limit or finish it. Stop and report what you have.` };
  if (nowMs - s.startedAt > s.maxSeconds * 1000) return { allow: false, reason: "cap_time", needs: "cap_time", message: `This session reached its time limit (${Math.round(s.maxSeconds / 60)} minutes). A person has to extend it or finish it. Stop and report what you have.` };
  if (creditsOf(s.costMicroUsd) >= s.maxCredits) return { allow: false, reason: "cap_credits", needs: "cap_credits", message: `This session reached its credit limit (${s.maxCredits}). A person has to raise it or finish the work. Stop and report what you have.` };
  const isRead = READ_TOOLS.has(tool);
  if (s.lastNote && !isRead) return { allow: false, reason: "note", message: s.lastNote, consumeNote: true };
  if (s.stepMode === "approve_each" && !isRead) {
    // a stored proposal holds redacted args, so compare against the redacted form of the new step
    const same = s.pending && fingerprint(s.pending.tool, s.pending.args) === fingerprint(tool, redactArgs(args));
    return {
      allow: false,
      reason: "proposal",
      needs: "proposal",
      message: "This session is set to review every step. Your step is waiting for the person to approve or reject it. Do not retry; take a browser_snapshot later to see what happened.",
      ...(same ? {} : { propose: { tool, args } }),
    };
  }
  return { allow: true };
}

export type Action = "pause" | "resume" | "takeover" | "handback";
export function transition(from: Control, action: Action): { ok: true; to: Control } | { ok: false; error: string } {
  const table: Record<Action, [Control[], Control]> = {
    pause: [["agent"], "paused"],
    resume: [["paused"], "agent"],
    takeover: [["agent", "paused"], "human"],
    handback: [["human"], "agent"],
  };
  const [froms, to] = table[action];
  return froms.includes(from) ? { ok: true, to } : { ok: false, error: `Cannot ${action} a session that is ${from === "agent" ? "running" : from === "human" ? "under a person's control" : "paused"}.` };
}
