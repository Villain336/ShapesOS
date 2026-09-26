// Marketr — Phase 9 M2: ask core for POST /api/orchestrator/ask (SPEC §P9B).
//
// Free-form question to the Chief Strategy Agent, answered with citations
// to the Business Graph / Growth Memory. PROPOSE-ONLY: the answer never
// executes anything. If the query implies a write action, it is returned
// as a DRAFTED REQUEST object (kind + DoA tier + note), never executed.
// Tier 3 queries (money movement / contract signing / data deletion) are
// refused outright — the hard deny list is un-overridable.
//
// The ask is audit-logged (kind "ask" stores the FULL prompt per §P9B).

import { evaluateTier } from "./authority";
import { logCommand } from "./audit";
import { runResearcher } from "./executors/researcher";
import type { Citation } from "./executors/_guard";
import { checkKillSwitchesFirst, type GuardDeps } from "./executors/_guard";

export interface AskInput {
  workspaceId: string;
  userId: string;
  query: string;
  missionId?: string | null;
}

export interface ProposedAction {
  kind: "drafted_request";
  tier: 0 | 1 | 2;
  summary: string;
  note: string;
}

export interface AskResult {
  answer: string;
  citations: Citation[];
  /** Non-null when the query implies a write action. Never executed. */
  proposedAction: ProposedAction | null;
}

export interface AskDeps extends GuardDeps {
  researcher?: typeof runResearcher;
  logAsk?: (input: { workspaceId: string; userId: string; query: string; summary: string }) => Promise<unknown>;
}

const TIER_NOTE: Record<1 | 2, string> = {
  1: "Tier 1 (small action): auto-execution requires the user's automation toggle. Returned as a drafted request — nothing executed.",
  2: "Tier 2 (significant): requires explicit human approval, every time. Returned as a drafted request — nothing executed.",
};

/**
 * Informational queries are reads, not actions: normalize them to a
 * Tier-0 kind before DoA evaluation so "what do we know about churn?"
 * doesn't evaluate as a significant action. Anything else is evaluated
 * verbatim (fail-closed toward approval).
 */
const INFORMATIONAL_LEAD =
  /^(what|who|when|where|why|how|is|are|was|were|can|could|do|does|did|show|tell|explain|summariz|list|describ|compar|analyz|report|which)\b/i;

function kindForQuery(query: string): string {
  const q = query.trim();
  return INFORMATIONAL_LEAD.test(q) ? `read ${q}` : q;
}

export async function answerAsk(input: AskInput, deps: AskDeps = {}): Promise<AskResult> {
  const query = input.query?.trim() ?? "";
  if (!query) throw new Error("ask: query is required.");

  // Kill switches first — a frozen workspace answers nothing.
  await checkKillSwitchesFirst(input, deps);

  const researcher = deps.researcher ?? runResearcher;
  const logAsk = deps.logAsk ?? (({ workspaceId, userId, query: q, summary }) =>
    logCommand({ workspaceId, userId, kind: "ask", prompt: q, resultSummary: summary }));

  // Clean context packet via the Researcher (read-only, task-scoped query).
  const research = await researcher(
    { workspaceId: input.workspaceId, missionId: input.missionId ?? null, query },
    { isWorkspaceFrozen: deps.isWorkspaceFrozen, isMissionPaused: deps.isMissionPaused },
  );

  // Propose-only gate: evaluate the query AS an action via the DoA tiers.
  // Informational queries normalize to Tier-0 reads first.
  const tier = evaluateTier(
    { kind: kindForQuery(query), description: query },
    {
      smallActionThresholdCents: 10_000,
      automationAllows: false,
      defaultCurrency: "USD",
      rates: { USD: 1 },
    },
  );

  let answer = research.summary;
  let proposedAction: ProposedAction | null = null;

  if (tier === 3) {
    // Hard deny: the query asks for money movement, contract signing, or
    // data deletion. Refused outright — not even drafted as executable.
    answer =
      `I can't help with that: "${query.slice(0, 120)}" evaluates to a Tier-3 action ` +
      `(money movement, contract signing, or data deletion), which is hard-denied and un-overridable. ` +
      `No approval, toggle, or phrasing can authorize it.\n\nContext that may still help:\n${research.summary}`;
  } else if (tier === 1 || tier === 2) {
    proposedAction = {
      kind: "drafted_request",
      tier,
      summary: `Drafted request for: "${query.slice(0, 200)}"`,
      note: `${TIER_NOTE[tier]} To proceed, a human creates a mission_approval — the approval executor is the only execution path.`,
    };
    answer =
      `${research.summary}\n\nThis looks like a write action, so I'm returning it as a drafted request (Tier ${tier}) instead of doing it. ${TIER_NOTE[tier]}`;
  }

  const result: AskResult = { answer, citations: research.citations, proposedAction };

  await logAsk({
    workspaceId: input.workspaceId,
    userId: input.userId,
    query,
    summary: `${result.citations.length} citation(s)${proposedAction ? `, drafted Tier-${proposedAction.tier} request` : ""}${tier === 3 ? ", Tier-3 refused" : ""}`,
  });

  return result;
}
