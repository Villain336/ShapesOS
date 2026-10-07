// ShapesOS — Phase 19A (WS=server): the spoken-approval gate (PURE).
//
// Owner rule (money safety): Tier 3 (money and irreversible: TIER3_EXACT_KINDS
// + TIER3_PATTERNS, third-party money tools) and destructive actions are
// NEVER approved by voice — only by a click on the card. Everything else
// (Tier 0–2) may be approved by voice or click; auto-approve rules apply as
// everywhere (executeTool decides those).
//
// The tier is judged the same way the Phase 14 auto-approve gate judges it
// (decideAutoApproval on no rules): the action's intrinsic tier with the
// automation toggle on, the kind AND "<tool>: <description>" scanned for
// Tier-3 wording, external money tools counted as Tier 3. We are stricter
// than the contract in one place: an action in NEVER_AUTO_ACTIONS (e.g.
// browser_act, which can buy or delete things on any site) is not voice-
// approvable either.

import { decideAutoApproval, NEVER_AUTO_ACTIONS } from "@/lib/automation/policy";

export type CursorTier = 0 | 1 | 2 | 3;

export interface CursorActionInput {
  /** Canonical tool name. */
  tool: string;
  description: string;
  /** ToolDef.kind (lib/chat/tools.ts); connector tools pass their own. */
  kind: "safe" | "destructive" | "publish" | "spend" | string;
  /** The automation action the call stands for (toolAction / connectorAction). */
  action: string;
  agentKey?: string;
}

export interface CursorActionPolicy {
  tier: CursorTier;
  destructive: boolean;
  voiceApprovable: boolean;
  /** Plain reason when a voice approval is not allowed. */
  reason: string | null;
}

export function cursorActionPolicy(input: CursorActionInput): CursorActionPolicy {
  const destructive = input.kind === "destructive";
  const d = decideAutoApproval([], {
    agentKey: input.agentKey ?? "lead",
    action: input.action,
    description: `${input.tool}: ${input.description}`,
    destructive,
  });
  const tier = d.tier as CursorTier;
  if (tier === 3) return { tier, destructive, voiceApprovable: false, reason: "Money and irreversible actions need a click on the card, not a spoken yes." };
  if (destructive) return { tier, destructive, voiceApprovable: false, reason: "Deleting or overwriting needs a click on the card, not a spoken yes." };
  if (NEVER_AUTO_ACTIONS.has(input.action)) return { tier, destructive, voiceApprovable: false, reason: `${NEVER_AUTO_ACTIONS.get(input.action)}; click the card to approve it.` };
  return { tier, destructive, voiceApprovable: true, reason: null };
}

/** The approve route's rule: may this decision go through as requested? */
export function voiceDecisionAllowed(p: Pick<CursorActionPolicy, "voiceApprovable">, via: "voice" | "click", decision: "approve" | "reject"): boolean {
  // Saying "no" is always fine; only a spoken approval is gated.
  if (decision === "reject") return true;
  return via === "click" || p.voiceApprovable;
}
