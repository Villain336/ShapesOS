// ShapesOS — Phase 19B (WS=engine): the five decision points — the ONLY
// places a model is asked anything during a town run.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
//   ad        a resident sees your ad (billboard on the way, social feed, search, event flyer)
//   enter     a resident walks into your store
//   mention   a friend or family member tells them about you
//   purchase  they decide whether to buy, at the shelf
//   reflect   nightly reflection and plan for tomorrow (generative-agents pattern)
// Everything else — schedules, travel, meals, groceries, wages — is rules.
//
// A model decision goes through the panel's PanelModel seam (lib/panel/model.ts):
// the ShapesOS router, structured output (one forced tool whose input is a zod
// schema), metered via meter(), reserved on the run's PanelLedger first — the
// hard per-run credit cap. Decisions are CACHED by (resident state hash,
// stimulus): a hit is never sent and costs 0 credits, so a seeded replay (and
// the shared start of an A/B pair) doesn't pay twice. The cache key leaves
// out the memories in the prompt on purpose — a cached answer can reuse a
// decision made with slightly different recollections; that is the cost
// trade-off, stated in the report.
//
// RulesDecider answers every point from the same facts with plain rules (no
// model, 0 credits): the rules-only mode, the free estimate dry run, and the
// fallback when a model answer fails its schema twice.

import { z } from "zod";
import { runPool } from "@/lib/panel/estimate";
import { PanelModelOutputError, type PanelModel, type StructuredTool } from "@/lib/panel/model";
import { hash32 } from "./rng";
import type { ResidentTraits } from "./residents";

export const DECISION_POINTS = ["ad", "enter", "mention", "purchase", "reflect"] as const;
export type DecisionPoint = (typeof DECISION_POINTS)[number];

const thought = z.string().max(400);
export const AttentionSchema = z.object({ attention: z.enum(["ignore", "curious", "plan_visit"]), thought });
export const EnterSchema = z.object({ impression: z.enum(["positive", "neutral", "negative"]), thought });
export const PurchaseSchema = z.object({ buy: z.boolean(), thought, objection: z.string().max(300).nullable() });
export const ReflectSchema = z.object({ summary: z.string().max(600), plan: z.enum(["visit_store", "tell_friend", "nothing"]) });
export type AttentionDecision = z.infer<typeof AttentionSchema>;
export type EnterDecision = z.infer<typeof EnterSchema>;
export type PurchaseDecision = z.infer<typeof PurchaseSchema>;
export type ReflectDecision = z.infer<typeof ReflectSchema>;

export interface DecisionValues {
  ad: AttentionDecision;
  mention: AttentionDecision;
  enter: EnterDecision;
  purchase: PurchaseDecision;
  reflect: ReflectDecision;
}
export type AnyDecisionValue = DecisionValues[DecisionPoint];

export const DECISION_TOOLS: { [P in DecisionPoint]: StructuredTool<DecisionValues[P]> } = {
  ad: { name: "react_to_ad", description: "How this resident reacts to the ad they just saw.", schema: AttentionSchema },
  mention: { name: "react_to_mention", description: "How this resident reacts to what they were just told.", schema: AttentionSchema },
  enter: { name: "first_impression", description: "This resident's impression on walking into the store.", schema: EnterSchema },
  purchase: { name: "purchase_decision", description: "Whether this resident buys the product now.", schema: PurchaseSchema },
  reflect: { name: "nightly_reflection", description: "This resident's reflection on today and plan for tomorrow.", schema: ReflectSchema },
};

/** Output ceiling per point (the provider enforces it; the cap reserves it). */
export const DECISION_MAX_TOKENS: Record<DecisionPoint, number> = { ad: 200, mention: 200, enter: 200, purchase: 260, reflect: 360 };
/** Upper bound on a decision prompt's characters (system + user + tool schema), for the estimate. */
export const DECISION_PROMPT_CHARS = 3_200;
/** A resident's model decisions per sim-day, per point (more are answered by rules). */
export const DAILY_DECISION_CAP: Record<DecisionPoint, number> = { ad: 2, mention: 1, enter: 1, purchase: 1, reflect: 1 };

export interface DecisionFacts {
  residentId: string;
  residentName: string;
  segment: string;
  persona: { name: string; occupation: string; goals: string[]; knownObjections: string[] } | null;
  calibrated: boolean;
  traits: ResidentTraits;
  moneyCents: number;
  productBudgetLeftCents: number;
  interest: number;
  adopted: boolean;
  product: { name: string; category: string; priceCents: number; description: string };
  effectivePriceCents: number;
  discountPct: number;
  weather: string;
  when: string;
  stimulus: {
    channel?: string;
    creative?: string;
    from?: string;
    relation?: "friend" | "family";
    said?: string;
    store?: string;
    impression?: string;
    experiences?: string[];
  };
  memories: string[];
}

export interface DecisionRequest<P extends DecisionPoint = DecisionPoint> {
  point: P;
  residentId: string;
  key: string;
  facts: DecisionFacts;
}

export type DecisionSource = "model" | "cache" | "rules";

export interface Decision<P extends DecisionPoint = DecisionPoint> {
  point: P;
  key: string;
  value: DecisionValues[P];
  source: DecisionSource;
  credits: number;
  /** Why rules answered where a model was asked (schema failed twice). */
  note?: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

function hex64(s: string): string {
  return hash32(s).toString(16).padStart(8, "0") + hash32(`~${s}`).toString(16).padStart(8, "0");
}

/** The cache key: resident × state bucket × stimulus. Memories are deliberately not in it. */
export function decisionKey(point: DecisionPoint, f: DecisionFacts): string {
  const state = [Math.round(f.interest * 10), f.adopted ? 1 : 0, f.moneyCents >= f.effectivePriceCents ? 1 : 0, Math.floor(f.moneyCents / 5_000), Math.floor(f.productBudgetLeftCents / 1_000)].join(",");
  const s = f.stimulus;
  const stimulus =
    point === "ad"
      ? [s.channel, s.creative, f.product.name, f.effectivePriceCents]
      : point === "mention"
        ? [s.from, s.relation, s.said]
        : point === "enter"
          ? [s.store, f.product.name, f.effectivePriceCents, f.discountPct]
          : point === "purchase"
            ? [s.store, f.product.name, f.effectivePriceCents, f.discountPct, s.impression]
            : [(s.experiences ?? []).join("|")];
  return `${f.residentId}:${point}:${hex64(`${state}#${JSON.stringify(stimulus)}`)}`;
}

/** The prompts a model sees for one decision. */
export function decisionPrompt(point: DecisionPoint, f: DecisionFacts): { system: string; user: string } {
  const p = f.persona;
  const system = [
    `You are simulating ${f.residentName}, a resident of a small town, in a launch rehearsal. You are a person going about your day, not an assistant. Stay in character and decide as this person would; it is fine to be uninterested.`,
    p ? `You are like ${p.name}, ${p.occupation}. Goals: ${p.goals.slice(0, 3).join("; ") || "none stated"}.` : `You belong to the "${f.segment}" group of residents.`,
    p && p.knownObjections.length ? `Objections you hold from past experience: ${p.knownObjections.slice(0, 3).join(" | ")}` : "",
    `Price sensitivity ${r2(f.traits.priceSensitivity)}, openness to ads ${r2(f.traits.adOpenness)}, sociability ${r2(f.traits.sociability)}, scepticism ${r2(f.traits.skepticism)} (0 = low, 1 = high).`,
  ]
    .filter(Boolean)
    .join("\n");
  const s = f.stimulus;
  const situation =
    point === "ad"
      ? `You just saw an ad (${s.channel}): "${s.creative}".`
      : point === "mention"
        ? `Your ${s.relation} ${s.from} just told you: "${s.said}".`
        : point === "enter"
          ? `You just walked into ${s.store}.`
          : point === "purchase"
            ? `You are at the shelf in ${s.store}. Your first impression was ${s.impression}.`
            : `It is the end of the day. Today: ${(s.experiences ?? []).join(" ") || "nothing special"}.`;
  const user = [
    `${f.when}, ${f.weather}.`,
    `The product: ${f.product.name} (${f.product.category}) — ${f.product.description || "no description"}. Price ${usd(f.effectivePriceCents)}${f.discountPct ? ` (${f.discountPct}% off ${usd(f.product.priceCents)})` : ""}.`,
    `You have ${usd(f.moneyCents)}. You'd spend at most ${usd(f.productBudgetLeftCents)} more on this kind of thing this month. Your interest so far: ${r2(f.interest)}${f.adopted ? " (you have bought it before)" : ""}.`,
    f.memories.length ? `What you remember:\n${f.memories.map((m) => `- ${m}`).join("\n")}` : "",
    situation,
    `FACTS ${JSON.stringify({ point, product: f.product.name, price: f.effectivePriceCents, budgetLeft: f.productBudgetLeftCents, money: f.moneyCents, interest: r2(f.interest), adopted: f.adopted, discount: f.discountPct, traits: f.traits, relation: s.relation ?? null, impression: s.impression ?? null, objection: p?.knownObjections[0] ?? null })}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { system, user };
}

/** Deterministic uniform in [0, 1) from a key. */
function u(key: string): number {
  return hash32(`u:${key}`) / 4294967296;
}

/** The rules answer (no model): the same facts, plain arithmetic. */
export function ruleDecision<P extends DecisionPoint>(point: P, f: DecisionFacts, key: string): DecisionValues[P] {
  const t = f.traits;
  const noise = (u(key) - 0.5) * 0.3;
  const priceRatio = f.effectivePriceCents / Math.max(1, f.productBudgetLeftCents);
  const objection = f.persona?.knownObjections[0] ?? null;
  switch (point) {
    case "ad":
    case "mention": {
      const tie = point === "mention" ? (f.stimulus.relation === "family" ? 0.3 : 0.15) : 0;
      const score = 0.15 + t.adOpenness * 0.6 + f.interest * 0.5 + tie - t.skepticism * 0.25 + noise * 1.3;
      const attention = !f.adopted && score > 0.6 ? "plan_visit" : score > 0.35 ? "curious" : "ignore";
      const thought = attention === "plan_visit" ? `I might drop by and see ${f.product.name} for myself.` : attention === "curious" ? `Huh, ${f.product.name}. Maybe.` : "Not for me.";
      return { attention, thought } as DecisionValues[P];
    }
    case "enter": {
      const score = f.interest * 0.6 + (1 - Math.min(1, t.priceSensitivity * priceRatio)) * 0.4 + noise;
      const impression = score > 0.5 ? "positive" : score < 0.2 ? "negative" : "neutral";
      return { impression, thought: impression === "negative" ? "This isn't what I hoped." : impression === "positive" ? "Nice place." : "Let's see." } as DecisionValues[P];
    }
    case "purchase": {
      const affordable = f.moneyCents >= f.effectivePriceCents && f.effectivePriceCents <= f.productBudgetLeftCents;
      const will = f.interest * 0.6 + (1 - Math.min(1, t.priceSensitivity * priceRatio * 2)) * 0.4 - t.skepticism * 0.2 + (f.discountPct / 100) * 0.3 + (f.stimulus.impression === "positive" ? 0.1 : 0) + noise;
      const buy = affordable && will > 0.4;
      const why = buy ? null : !affordable ? "It's more than I can spend right now." : priceRatio > 0.5 ? (objection ?? "Too expensive for what it is.") : "Not sure I need it yet.";
      return { buy, thought: buy ? `I'll take one ${f.product.name}.` : why!, objection: why } as DecisionValues[P];
    }
    case "reflect": {
      const plan = f.adopted ? (t.sociability > 0.5 ? "tell_friend" : "nothing") : f.interest >= 0.5 ? "visit_store" : "nothing";
      return { summary: (f.stimulus.experiences ?? []).slice(0, 3).join(" ") || "A normal day.", plan } as DecisionValues[P];
    }
  }
  throw new Error(`unknown decision point ${String(point)}`);
}

/** The decision cache (resident state hash × stimulus → answer). Seedable from a past run's decisions. */
export class DecisionCache {
  private map = new Map<string, AnyDecisionValue>();
  hits = 0;
  misses = 0;
  constructor(seed?: Iterable<[string, AnyDecisionValue]>) {
    if (seed) for (const [k, v] of seed) this.map.set(k, v);
  }
  get size(): number {
    return this.map.size;
  }
  get(key: string): AnyDecisionValue | undefined {
    return this.map.get(key);
  }
  set(key: string, value: AnyDecisionValue): void {
    this.map.set(key, value);
  }
  entries(): IterableIterator<[string, AnyDecisionValue]> {
    return this.map.entries();
  }
}

export interface TownDecider {
  /** "live" (router model), "fake" (the labelled test model), "rules" (no model). */
  readonly kind: "live" | "fake" | "rules";
  /** Answers in request order. A cap stop (PanelCapReachedError) propagates. */
  decideMany(runId: string, reqs: DecisionRequest[]): Promise<Decision[]>;
}

/** Rules only: no model, no credits. */
export class RulesDecider implements TownDecider {
  readonly kind = "rules" as const;
  async decideMany(_runId: string, reqs: DecisionRequest[]): Promise<Decision[]> {
    return reqs.map((r) => ({ point: r.point, key: r.key, value: ruleDecision(r.point, r.facts, r.key), source: "rules" as const, credits: 0 }));
  }
}

/**
 * The model at decision points (through PanelModel: router, structured
 * output, meter(), the run's hard cap), behind the decision cache. Requests
 * with the same key in one batch are asked once.
 */
export class ModelDecider implements TownDecider {
  readonly kind: "live" | "fake";
  constructor(
    private readonly model: PanelModel,
    readonly cache: DecisionCache,
    private readonly opts: { parallel?: number } = {},
  ) {
    this.kind = model.kind;
  }

  async decideMany(runId: string, reqs: DecisionRequest[]): Promise<Decision[]> {
    const fresh = new Map<string, DecisionRequest>();
    for (const r of reqs) if (!this.cache.get(r.key) && !fresh.has(r.key)) fresh.set(r.key, r);
    const answered = new Map<string, { value: AnyDecisionValue; credits: number; source: DecisionSource; note?: string }>();
    await runPool([...fresh.values()], this.opts.parallel ?? 4, async (r) => {
      const { system, user } = decisionPrompt(r.point, r.facts);
      try {
        const res = await this.model.structured(runId, { purpose: r.point, system, user, tool: DECISION_TOOLS[r.point] as StructuredTool<AnyDecisionValue>, maxTokens: DECISION_MAX_TOKENS[r.point] });
        answered.set(r.key, { value: res.value, credits: res.credits, source: "model" });
      } catch (err) {
        if (!(err instanceof PanelModelOutputError)) throw err;
        answered.set(r.key, { value: ruleDecision(r.point, r.facts, r.key), credits: 0, source: "rules", note: `model answer invalid twice (${err.reason.slice(0, 120)})` });
      }
    });
    // Cache only after every call settled, in request order (deterministic fill).
    for (const r of fresh.values()) {
      const a = answered.get(r.key)!;
      if (a.source === "model") this.cache.set(r.key, a.value);
    }
    const out: Decision[] = [];
    const firstUse = new Set<string>();
    for (const r of reqs) {
      const a = answered.get(r.key);
      if (a && !firstUse.has(r.key)) {
        firstUse.add(r.key);
        this.cache.misses += 1;
        out.push({ point: r.point, key: r.key, value: a.value, source: a.source, credits: a.credits, ...(a.note ? { note: a.note } : {}) });
      } else {
        this.cache.hits += 1;
        out.push({ point: r.point, key: r.key, value: (this.cache.get(r.key) ?? a!.value) as AnyDecisionValue, source: "cache", credits: 0 });
      }
    }
    return out;
  }
}
