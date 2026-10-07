// ShapesOS Desktop: local intents in an utterance.
//
// Agent mode: "research our competitors in the background, max $3" or
// "agent: research our competitors, up to 2 dollars" starts a Phase 16
// delegated run with a USER-SET spend cap (POST /api/cursor/agent). The cap
// is money: it is parsed strictly, never above the person's ceiling from
// Settings, and a missing cap falls back to their default (and says so).

export interface AgentIntent {
  goal: string;
  /** The spoken cap, if any. */
  maxUsd: number | null;
}

const BACKGROUND = /\b(?:in the background|as a background (?:task|job|agent)|background agent|agent mode)\b/i;
const AGENT_PREFIX = /^(?:hey\s+)?(?:shapes(?:os)?[,:]?\s+)?agent[,:]?\s+/i;
const CAP =
  /\b(?:max(?:imum)?|up to|budget(?: of)?|cap(?: of| it at)?|spend(?: at most| no more than)?|no more than|limit(?: of)?)\s*(?:\$\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks|usd))\b/i;

export function parseAgentIntent(transcript: string): AgentIntent | null {
  const t = transcript.trim();
  const prefixed = AGENT_PREFIX.test(t);
  if (!prefixed && !BACKGROUND.test(t)) return null;
  const cap = CAP.exec(t);
  const amount = cap ? Number(cap[1] ?? cap[2]) : null;
  let goal = t
    .replace(AGENT_PREFIX, "")
    .replace(BACKGROUND, "")
    .replace(CAP, "")
    .replace(/^(?:shapes(?:os)?[,:]?\s+)/i, "")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/[\s,;]+$/g, "")
    .replace(/^[\s,;]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  goal = goal.replace(/[,.;]+$/, "").trim();
  if (!goal) return null;
  return { goal, maxUsd: amount !== null && Number.isFinite(amount) ? amount : null };
}

export type CapDecision =
  | { ok: true; maxUsd: number; note: string | null }
  | { ok: false; say: string };

/** Apply the person's default and ceiling to a spoken cap. */
export function decideCap(spoken: number | null, defaults: { defaultUsd: number; ceilingUsd: number }): CapDecision {
  if (spoken === null) {
    return {
      ok: true,
      maxUsd: defaults.defaultUsd,
      note: `No cap given, so I'm using your default of ${usd(defaults.defaultUsd)}.`,
    };
  }
  if (!(spoken > 0)) return { ok: false, say: "The spend cap has to be more than $0." };
  if (spoken > defaults.ceilingUsd) {
    return {
      ok: false,
      say: `${usd(spoken)} is above your ${usd(defaults.ceilingUsd)} limit. Raise it in Settings first.`,
    };
  }
  return { ok: true, maxUsd: Math.round(spoken * 100) / 100, note: null };
}

export function usd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}
