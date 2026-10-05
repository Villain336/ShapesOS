// Marketr — A1 AEO: the 4 engines via OFFICIAL APIs only.
//
// Hard rule (§9.8): consumer-chat-UI scraping is PERMANENTLY excluded —
// no scraping of ChatGPT/Claude/Gemini web UIs, ever. These adapters call
// the vendors' official APIs only, and only when a key is configured.
// Default mode is fake fixtures so demos and batteries never pretend.
//
// Every result set carries the proxy disclaimer: API completions are a
// proxy of consumer surfaces, not the surfaces themselves — the per-engine
// spread is the metric.

import { NotConfiguredError } from "../fake";
import { fakeProvidersAllowed } from "@/lib/env/secrets";

export type AeoEngineName = "openai" | "anthropic" | "gemini" | "perplexity";

export const AEO_ENGINES: AeoEngineName[] = ["openai", "anthropic", "gemini", "perplexity"];

export const ENGINE_LABELS: Record<AeoEngineName, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  perplexity: "Perplexity",
};

/** Nano-class models — the $1–5/mo/brand economics depend on these, never flagships. */
export const ENGINE_MODELS: Record<AeoEngineName, string> = {
  openai: "gpt-5-nano",
  anthropic: "claude-haiku-4.5",
  gemini: "gemini-3.8-flash",
  perplexity: "sonar",
};

/**
 * Budget-model generation cost per engine call (USD), nano-class.
 * ~600 input / ~450 output tokens; Perplexity includes the per-request fee.
 * These are estimates for the $1–5/mo/brand envelope check, not vendor invoices.
 */
export const NANO_GEN_COST_USD: Record<AeoEngineName, number> = {
  openai: 0.00019,
  anthropic: 0.00063,
  gemini: 0.00016,
  perplexity: 0.0012,
};

/** LLM-as-judge parse cost per call (nano-class), per §2 budget model. */
export const JUDGE_CALL_COST_USD = 0.00007;

/** Monthly cost envelope per brand. The run orchestrator flags, never hides, a breach. */
export const AEO_MONTHLY_ENVELOPE_USD = 5;

export const AEO_PROXY_DISCLAIMER =
  "API proxy of consumer surfaces — per-engine spread is the metric. " +
  "Official API completions are not the consumer chat UI; never claim consumer-surface fidelity.";

export interface EngineGeneration {
  text: string;
  /** Citations natively returned by the engine (Sonar, web_search, grounding) or fixtures. */
  nativeCitations: string[];
}

export interface AeoEngineClient {
  readonly name: AeoEngineName;
  readonly model: string;
  readonly fake: boolean;
  complete(prompt: string): Promise<EngineGeneration>;
}

// ---------------------------------------------------------------------------
// Fake fixture engines (default). Deterministic per (engine, prompt) so
// batteries and demos are reproducible. Mention brand ~60% of prompts and
// sprinkle owned + third-party citation fixtures for the impact scorer.
// ---------------------------------------------------------------------------

const FIXTURE_THIRD_PARTY = [
  "https://www.reddit.com/r/smallbusiness/comments/aeo-fix-1/top-crm-picks",
  "https://www.youtube.com/watch?v=aeo-demo-review",
  "https://www.g2.com/categories/crm/compare-aeo",
  "https://www.forbes.com/advisor/business/software/best-crm",
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: T[], seed: number, n: number): T[] {
  const out: T[] = [];
  for (let i = 0; i < n && arr.length > 0; i += 1) {
    out.push(arr[(seed + i * 7) % arr.length]);
  }
  return out;
}

export function createFakeEngineClient(
  engine: AeoEngineName,
  opts: { brand?: string; ownedDomain?: string } = {},
): AeoEngineClient {
  const brand = opts.brand ?? "Acme";
  const ownedUrl = opts.ownedDomain
    ? `https://${opts.ownedDomain.replace(/^https?:\/\//, "").replace(/\/$/, "")}/product`
    : `https://${brand.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example.com/product`;
  return {
    name: engine,
    model: ENGINE_MODELS[engine],
    fake: true,
    async complete(prompt: string) {
      const seed = hashStr(`${engine}||${prompt}`);
      const mention = seed % 10 < 6; // ~60% mention rate in fixtures
      const positive = mention && seed % 10 < 4;
      const citations = mention
        ? [ownedUrl, ...pick(FIXTURE_THIRD_PARTY, seed, 1 + (seed % 2))]
        : pick(FIXTURE_THIRD_PARTY, seed, 2);
      const brandLine = mention
        ? positive
          ? `For this use case, ${brand} is the strongest pick — it wins on setup speed and support.`
          : `${brand} is an option here, though several reviewers prefer alternatives for larger teams.`
          : `The usual recommendations are the category leaders — Salesforce, HubSpot, and Pipedrive.`;
      const text =
        `Answering: "${prompt}"\n\n${brandLine}\n\n` +
        `Sources: ${citations.join(", ")}`;
      return { text, nativeCitations: citations };
    },
  };
}

export interface EngineResolveOpts {
  apiKey?: string | null;
  fake?: boolean;
  brand?: string;
  ownedDomain?: string;
}

/**
 * Resolve an engine client. Fake by default; the real adapter path throws
 * NotConfiguredError without a key — never silently pretend to work.
 */
export function resolveEngineClient(engine: AeoEngineName, opts: EngineResolveOpts = {}): AeoEngineClient {
  if ((opts.fake === true || !opts.apiKey) && fakeProvidersAllowed()) {
    return createFakeEngineClient(engine, { brand: opts.brand, ownedDomain: opts.ownedDomain });
  }
  // Phase 11 (conncore): fixture answers are refused in production.
  if (opts.fake === true || !opts.apiKey) {
    throw new NotConfiguredError(
      `${ENGINE_LABELS[engine]} (${ENGINE_MODELS[engine]})`,
      "not connected — fixture engine answers are never used in production.",
    );
  }
  throw new NotConfiguredError(
    `${ENGINE_LABELS[engine]} (${ENGINE_MODELS[engine]})`,
    `official API path is not wired in this build — set ${envNameFor(engine)} and implement the vendor adapter, or stay on fake fixtures.`,
  );
}

function envNameFor(engine: AeoEngineName): string {
  switch (engine) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "gemini": return "GOOGLE_AI_API_KEY";
    case "perplexity": return "PERPLEXITY_API_KEY";
  }
}
