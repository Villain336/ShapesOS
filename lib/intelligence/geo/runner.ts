// Marketr — Phase 10 M3: prompt runner.
//
// Sends frozen panel prompts to the engines' OFFICIAL LLM APIs only —
// OpenAI, Anthropic, Gemini (OpenAI-compatible endpoint), Perplexity
// (OpenAI-compatible endpoint) — with the user's BYO keys. Chat-UI scraping
// is permanently excluded (§2 🚫 boundary): no ChatGPT/Perplexity/Gemini web
// surfaces are ever touched.
//
// Each (prompt × rep × engine) generation is judged (brand mention,
// sentiment, competitors, extracted citation URLs) and stored RAW in
// `geo_observation`. The runner never aggregates into a single score at write
// time — aggregation happens in summary.ts and always carries CI metadata.
//
// Cost: every generation is metered via M6's recordApiMeter contract
// (ai_prompt). Unconfigured engines are SKIPPED and reported, never faked.

import { OpenAiCompatibleLlmProvider } from "@/lib/llm/openai";
import { AnthropicLlmProvider } from "@/lib/llm/anthropic";
import type { LlmProvider } from "@/lib/llm/types";
import { getLlmProviderFor } from "@/lib/llm";
import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";
import { recordApiMeter } from "@/lib/intelligence/providers";
import { NANO_GEN_COST_USD, JUDGE_CALL_COST_USD } from "@/lib/authority/aeo/engines";
import { getPanel, GEO_ENGINES, GEO_ENGINE_KEY_ENV, GEO_ENGINE_MODELS, type GeoEngine, type GeoPanel } from "./panels";

export type { GeoEngine };

const PERPLEXITY_BASE_URL = "https://api.perplexity.ai";
const GEMINI_OPENAI_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export interface EngineResolution {
  engine: GeoEngine;
  configured: boolean;
  model: string;
  /** Why the engine is skipped, when it is. */
  skipReason: string | null;
  provider: LlmProvider | null;
}

/** Resolve an engine to its official-API provider. Never a scraper, never a mock. */
export function resolveGeoEngine(engine: GeoEngine): EngineResolution {
  const model = GEO_ENGINE_MODELS[engine];
  const key = (process.env[GEO_ENGINE_KEY_ENV[engine]] ?? "").trim();
  if (!key) {
    return {
      engine,
      configured: false,
      model,
      skipReason: `BYO key not set (${GEO_ENGINE_KEY_ENV[engine]}). Engine skipped — no mock data is generated.`,
      provider: null,
    };
  }
  const provider: LlmProvider =
    engine === "anthropic"
      ? new AnthropicLlmProvider(key, model)
      : new OpenAiCompatibleLlmProvider(
          key,
          model,
          engine === "perplexity" ? PERPLEXITY_BASE_URL : engine === "gemini" ? GEMINI_OPENAI_COMPAT_URL : "https://api.openai.com/v1",
        );
  return { engine, configured: true, model, skipReason: null, provider };
}

// ---------------------------------------------------------------------------
// Judge: brand mention / sentiment / competitors / citation URLs.
// LLM judge when the bulk workload is live, deterministic heuristic otherwise.
// The judge model name is ALWAYS recorded honestly (heuristic-v1 included).
// ---------------------------------------------------------------------------

export interface GeoJudgment {
  mentioned: boolean;
  sentiment: "positive" | "neutral" | "negative" | "unknown";
  competitors: string[];
  citedSources: string[];
  judgeModel: string;
  judgeConfidence: number;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;

function extractUrls(text: string): string[] {
  const found = text.match(URL_RE) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let u of found) {
    u = u.replace(/[.,;:!?]+$/, "");
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out.slice(0, 25);
}

/** Deterministic heuristic judge. Honest label: judgeModel "heuristic-v1". */
export function heuristicJudge(brand: string, responseText: string): GeoJudgment {
  const lower = responseText.toLowerCase();
  const brandLower = brand.toLowerCase();
  const mentioned = brandLower.length > 1 && lower.includes(brandLower);
  let sentiment: GeoJudgment["sentiment"] = "unknown";
  if (mentioned) {
    const pos = /(best|strongest|excellent|great pick|top choice|highly recommend|wins on)/.test(lower);
    const neg = /(avoid|poor|weak|not recommend|falls short|drawback)/.test(lower);
    sentiment = pos && !neg ? "positive" : neg && !pos ? "negative" : "neutral";
  }
  return {
    mentioned,
    sentiment,
    competitors: [],
    citedSources: extractUrls(responseText),
    judgeModel: "heuristic-v1",
    judgeConfidence: 0.6,
  };
}

const JUDGE_PROMPT = (brand: string, responseText: string) => `You parse AI-assistant answers for brand-visibility measurement.
Brand: "${brand}"
Answer (truncated): """${responseText.slice(0, 4000)}"""
Return ONLY valid JSON: {"mentioned": boolean, "sentiment": "positive"|"neutral"|"negative"|"unknown", "competitors": [brand names mentioned as alternatives], "citedSources": [URLs cited in the answer]}`;

/** LLM judge via the bulk workload provider; degrades to the heuristic judge when not live. */
export async function judgeGeoResponse(
  brand: string,
  responseText: string,
  /** Phase 17 (A4): the workspace the run is for — its key and its metering (generate() records usage). */
  workspaceId?: string,
): Promise<GeoJudgment> {
  const heuristic = heuristicJudge(brand, responseText);
  let provider: LlmProvider;
  try {
    provider = workspaceId
      ? await (await import("@/lib/llm/workspace")).getLlmProviderForWorkspace("bulk", { workspaceId, billing: "included" }) // recorded; charged once, by recordApiMeter("judge") below
      : getLlmProviderFor("bulk");
  } catch {
    return heuristic;
  }
  if (!provider.isLive || !provider.isConfigured()) return heuristic;
  try {
    const raw = await provider.generate(JUDGE_PROMPT(brand, responseText), { maxTokens: 512 });
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return heuristic;
    const parsed = JSON.parse(json) as Partial<GeoJudgment>;
    return {
      mentioned: Boolean(parsed.mentioned),
      sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment ?? "")
        ? (parsed.sentiment as GeoJudgment["sentiment"])
        : mentionedHeuristicSentiment(heuristic, parsed),
      competitors: Array.isArray(parsed.competitors)
        ? parsed.competitors.filter((c): c is string => typeof c === "string").slice(0, 10)
        : [],
      citedSources: Array.from(
        new Set([
          ...extractUrls(responseText),
          ...(Array.isArray(parsed.citedSources)
            ? parsed.citedSources.filter((u): u is string => typeof u === "string")
            : []),
        ]),
      ).slice(0, 25),
      judgeModel: `llm:${provider.name}`,
      judgeConfidence: 0.8,
    };
  } catch {
    return heuristic; // judge failure degrades honestly, never throws the run
  }
}

function mentionedHeuristicSentiment(h: GeoJudgment, parsed: Partial<GeoJudgment>): GeoJudgment["sentiment"] {
  return h.mentioned ? h.sentiment : parsed.sentiment === "unknown" ? "unknown" : "unknown";
}

// ---------------------------------------------------------------------------
// Run orchestration.
// ---------------------------------------------------------------------------

export interface GeoRunJob {
  promptIdx: number;
  rep: number;
  engine: GeoEngine;
}

export function buildGeoRunPlan(promptCount: number, engines: GeoEngine[], reps: number): GeoRunJob[] {
  const plan: GeoRunJob[] = [];
  for (const engine of engines) {
    for (let promptIdx = 0; promptIdx < promptCount; promptIdx += 1) {
      for (let rep = 1; rep <= reps; rep += 1) {
        plan.push({ promptIdx, rep, engine });
      }
    }
  }
  return plan;
}

export interface GeoRunResult {
  runId: string;
  panelId: string;
  observationsRecorded: number;
  enginesRun: GeoEngine[];
  enginesSkipped: { engine: GeoEngine; reason: string }[];
  estimatedCostUsd: number;
  metered: boolean;
}

export interface GeoRunOptions {
  engines?: GeoEngine[];
  reps?: number;
  brand: string;
  /** Override the generated run id (lets API routes track a background run). */
  runId?: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Execute a panel run: generate → judge → record raw observations.
 * Raw only — aggregation is summary.ts's job and always carries CI.
 */
export async function runPanel(
  workspaceId: string,
  panelId: string,
  opts: GeoRunOptions,
): Promise<GeoRunResult> {
  const panel: GeoPanel | null = await getPanel(workspaceId, panelId);
  if (!panel) throw new Error(`Panel ${panelId} not found in workspace.`);
  // Phase 15.2: prompt runs are charged in credits (4× the engine's USD,
  // recordApiMeter → geo_prompt_run): a capped workspace is refused before
  // any engine is asked.
  {
    const { checkCap } = await import("@/lib/metering/service");
    const cap = await checkCap(workspaceId);
    if (!cap.allowed) {
      throw new Error(
        `Credit cap reached (${cap.used.toLocaleString()} of ${cap.capCredits.toLocaleString()} credits used). Raise the cap or add credits in Settings → Usage.`,
      );
    }
  }
  const engines = (opts.engines ?? [...GEO_ENGINES]).filter((e) => GEO_ENGINES.includes(e));
  const reps = opts.reps ?? panel.nReps;
  const runId = opts.runId ?? `georun_${Date.now().toString(36)}`;
  const runAt = new Date();

  const resolved = engines.map(resolveGeoEngine);
  const live = resolved.filter((r) => r.configured && r.provider);
  const skipped = resolved
    .filter((r) => !r.configured)
    .map((r) => ({ engine: r.engine, reason: r.skipReason ?? "not configured" }));

  const plan = buildGeoRunPlan(panel.prompts.length, live.map((r) => r.engine), reps);
  const providers = new Map(live.map((r) => [r.engine, { provider: r.provider as LlmProvider, model: r.model }]));

  let recorded = 0;
  let estimatedCostUsd = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const job = plan[i];
    const { provider, model } = providers.get(job.engine) as { provider: LlmProvider; model: string };
    const prompt = panel.prompts[job.promptIdx];
    const text = await provider.generate(prompt, { maxTokens: 1024 });
    const judgment = await judgeGeoResponse(opts.brand, text, workspaceId);
    const genCost = NANO_GEN_COST_USD[job.engine] ?? 0.001;
    estimatedCostUsd += genCost + JUDGE_CALL_COST_USD;

    await withWorkspaceScope(workspaceId, (tx: TxClient) =>
      tx.geoObservation.create({
        data: {
          workspaceId,
          panelId: panel.id,
          runAt,
          rep: job.rep,
          brandMentioned: judgment.mentioned,
          citationUrls: judgment.citedSources,
          sentiment: judgment.sentiment,
          stabilityMetadata: {
            engine: job.engine,
            model,
            promptIdx: job.promptIdx,
            judgeModel: judgment.judgeModel,
            judgeConfidence: judgment.judgeConfidence,
            competitors: judgment.competitors,
            runId,
            proxyNote: "Official API completion — a proxy of the consumer surface, not the surface itself.",
          },
        },
      }),
    );
    recorded += 1;
    // Meter the generation + the judge call (M6 contract). Best-effort.
    await recordApiMeter(workspaceId, job.engine, "ai_prompt", 1, genCost);
    await recordApiMeter(workspaceId, "judge", "ai_prompt", 1, JUDGE_CALL_COST_USD);
    opts.onProgress?.(i + 1, plan.length);
  }

  return {
    runId,
    panelId: panel.id,
    observationsRecorded: recorded,
    enginesRun: live.map((r) => r.engine),
    enginesSkipped: skipped,
    estimatedCostUsd,
    metered: true,
  };
}
