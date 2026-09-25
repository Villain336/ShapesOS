// Marketr — A1 AEO: LLM-as-judge parsing.
// Nano-class judge behind the abstracted interface (spec §12.3): parses a
// raw engine response into {mentioned, position, sentiment, competitors,
// cited_sources} JSON plus a derived recommendation flag.
// Default is the fake nano-judge; the real path throws NotConfiguredError.

import { resolveLlmJudge, type LlmJudge, type JudgeInput, type JudgeOutput } from "../fake";

export type { JudgeInput, JudgeOutput, LlmJudge };

export type Sentiment = "positive" | "neutral" | "negative";

export interface AeoJudgment extends JudgeOutput {
  /** Derived: recommended == mentioned && positive && (position 1 or unknown). */
  recommended: boolean;
}

/**
 * Recommendation heuristic, shared by the scorer and the impact engine so
 * both agree on what "brand recommended" means.
 */
export function isRecommended(
  mentioned: boolean,
  position: number | null,
  sentiment: Sentiment | null,
): boolean {
  return mentioned && sentiment === "positive" && (position === 1 || position === null);
}

/** Run the judge and derive the recommendation flag. Never throws on parse — degrades honestly. */
export async function judgeResponse(judge: LlmJudge, input: JudgeInput): Promise<AeoJudgment> {
  const out = await judge.judge(input);
  const sentiment = (out.sentiment ?? null) as Sentiment | null;
  return { ...out, sentiment, recommended: isRecommended(out.mentioned, out.position, sentiment) };
}

/** Resolve the judge: fake nano-judge by default; real throws without a key. */
export function resolveJudge(opts: { apiKey?: string | null; fake?: boolean } = {}): LlmJudge {
  return resolveLlmJudge({ apiKey: opts.apiKey, fake: opts.fake });
}

/** The judge model name recorded on each aeo_mentions row. */
export function judgeModelName(judge: LlmJudge): string {
  return judge.name;
}
