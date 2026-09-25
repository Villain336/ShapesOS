// Marketr — Phase 7 F2: supervised LLM rewrite of headlines/CTAs.
//
// Scope is structural (SPEC §2/F2): ONLY headlines and CTAs may be rewritten,
// and ONLY after a human approved the variant. There is no unsupervised art
// direction in this module — any request outside {headline, cta} throws.
//
// Provider posture (SPEC §7 + repo fake-first convention):
//   - fake (default): deterministic mock provider. Output is loudly labeled
//     ("[FAKE REWRITE]") so it can never be mistaken for real copy.
//   - live: honest not-configured without LLM credentials — never a pretend
//     rewrite. Even WITH credentials the live adapter is a stub in v1 that
//     fails closed: supervised rewrite ships only behind human review wiring.

import {
  type ChannelName, type RewriteProvenance, type VariantRewrite,
} from "./types";

export class RewriteScopeViolationError extends Error {
  constructor(fields: string[]) {
    super(
      `Rewrite scope violation: only "headline" and "cta" may be rewritten ` +
      `(requested: ${fields.join(", ")}). No body copy, no art direction.`,
    );
    this.name = "RewriteScopeViolationError";
  }
}

export class RewriteNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Supervised rewrite not configured: ${reason}`);
    this.name = "RewriteNotConfiguredError";
  }
}

export class RewriteGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewriteGateError";
  }
}

const ALLOWED_REWRITE_FIELDS = new Set(["headline", "cta"]);

/** Structural scope gate: headlines and CTAs only. */
export function assertRewriteScope(fields: string[]): void {
  const bad = fields.filter((f) => !ALLOWED_REWRITE_FIELDS.has(f));
  if (bad.length > 0) throw new RewriteScopeViolationError(bad);
}

export interface RewriteRequest {
  headline: string;
  cta: string;
  channel: ChannelName;
  /** Deterministic adaptation notes — grounding context for the rewrite. */
  ruleNotes: string[];
}

export interface RewriteProvider {
  name: string;
  isLive: boolean;
  rewrite(req: RewriteRequest): Promise<{ headline: string; cta: string; model: string }>;
}

class MockRewriteProvider implements RewriteProvider {
  readonly name = "mock";
  readonly isLive = false;

  async rewrite(req: RewriteRequest) {
    const head = req.headline.trim() || "Your winning headline";
    const cta = req.cta.trim() || "Learn more";
    return {
      headline: `[FAKE REWRITE — ${req.channel}] ${head}`,
      cta: `[FAKE REWRITE — ${req.channel}] ${cta}`,
      model: "mock/f2-rewrite-v1",
    };
  }
}

class UnwiredLiveRewriteProvider implements RewriteProvider {
  readonly name = "live-unwired";
  readonly isLive = true;

  async rewrite(_req: RewriteRequest): Promise<{ headline: string; cta: string; model: string }> {
    // v1 honest gap: the live adapter is intentionally unwired. A real rewrite
    // path must route through the supervised-review queue first (the human
    // sees and edits the draft before it can attach to any variant).
    throw new RewriteNotConfiguredError(
      "live supervised-rewrite adapter is not wired in v1 — the draft must pass through human review before it can be generated",
    );
  }
}

function hasLlmCredentials(): boolean {
  const env = process.env as Record<string, string | undefined>;
  return Boolean(
    env.LLM_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY ||
    env.LLM_MODEL || env.LLM_MODEL_COPY,
  );
}

/** Resolve the rewrite provider. Fake by default; live fails closed. */
export function resolveRewriteProvider(opts: { fake?: boolean } = {}): RewriteProvider {
  if (opts.fake ?? true) return new MockRewriteProvider();
  if (!hasLlmCredentials()) {
    throw new RewriteNotConfiguredError(
      "no LLM credentials configured (LLM_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY) — refusing to pretend",
    );
  }
  return new UnwiredLiveRewriteProvider();
}

/** Proposed rewrite attached to one variant — always provenance-labeled. */
export function proposeVariantRewrite(args: {
  variantChannel: ChannelName;
  sourceCopy: { headline: string; cta: string };
  ruleNotes: string[];
  provider: RewriteProvider;
  briefApproved: boolean;
  now?: Date;
}): Promise<VariantRewrite> {
  assertRewriteScope(["headline", "cta"]);
  if (!args.briefApproved) {
    throw new RewriteGateError(
      "Supervised rewrite requires a human-approved brief — the variant is not approved yet.",
    );
  }
  if (args.sourceCopy.headline.length > 500 || args.sourceCopy.cta.length > 200) {
    throw new RewriteGateError("Source copy exceeds the rewrite input ceiling (headline ≤500, cta ≤200 chars).");
  }
  return args.provider
    .rewrite({
      headline: args.sourceCopy.headline,
      cta: args.sourceCopy.cta,
      channel: args.variantChannel,
      ruleNotes: args.ruleNotes,
    })
    .then((out) => {
      const provenance: RewriteProvenance = {
        provider: args.provider.isLive ? "live" : "mock",
        model: out.model,
        labeled: !args.provider.isLive,
        at: (args.now ?? new Date()).toISOString(),
      };
      return {
        variantChannel: args.variantChannel,
        headline: out.headline,
        cta: out.cta,
        provenance,
      };
    });
}
