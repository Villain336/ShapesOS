// Marketr — Phase 10 M5: difficulty estimate service.
//
// Orchestrates one estimate end-to-end:
//   M6 fetchSerp  →  M6 lookupVolume  →  authority adapters  →  model
//   →  versioned artifact in difficulty_estimate.
//
// Degradation policy (honest, never fake):
//   - No SERP vendor configured → the estimate is REFUSED ({ ok: false }).
//     There is no difficulty without a SERP — inventing one is a §2 violation.
//   - No volume source → volume = null; the band widens (±8) and provenance
//     records volumeBand: null.
//   - Authority adapters missing/failing → confidence drops; the model still
//     runs on whatever signals exist.
//
// Until the eval bar passes (gate.ts), every successful estimate is flagged
// experimental: true — the UI shows it ALONGSIDE the vendor value, never in
// place of it.

import { auditEvent } from "@/lib/auditlog";
import type { FileChangeAction } from "@prisma/client";
import { fetchSerp, lookupVolume, VendorNotConfigured, VolumeUnavailableError } from "@/lib/intelligence/providers";
import {
  bandToRange,
  blendAuthority,
  computeDifficulty,
  MODEL_VERSION,
  normalizeDomain,
  type DifficultyOutput,
  type ModelInputs,
  type VolumeInput,
} from "./model";
import { resolveAuthority, type ResolveAuthorityOpts } from "./authority";
import { upsertEstimate, type EstimateRow } from "./store";
import { gateStatus, shouldReplaceVendor } from "./gate";

export type EstimateOutcome =
  | {
      ok: true;
      output: DifficultyOutput;
      row: EstimateRow;
      /** True until the eval bar passes — UI marks the value EXPERIMENTAL. */
      experimental: boolean;
    }
  | { ok: false; reason: string; missing: string[] };

export interface EstimateOptions extends ResolveAuthorityOpts {
  /** The user's own domain (authority looked up like any ranking domain). */
  ownDomain?: string;
  /** …or a pre-known 0–100 authority for it (skips the lookup). */
  ownDomainAuthority?: number;
}

const MAX_BATCH = 20;

function summarize(keyword: string, output: DifficultyOutput): string {
  const p = output.inputsProvenance;
  const srcs = p.authoritySources
    .filter((s) => s.domainsCovered > 0)
    .map((s) => `${s.source}(${s.domainsCovered})`)
    .join(",");
  return (
    `Difficulty "${keyword}": KD ${output.estimate} ±${output.uncertainty} ` +
    `[${output.uncertaintyBand[0]}–${output.uncertaintyBand[1]}] ` +
    `(link ${output.components.linkStrength}, gap ${output.components.authorityGap}, ` +
    `crowd ${output.components.serpCrowding}) via ${p.serpVendor}; ` +
    `authority: ${srcs || "none"}; volume ${p.volumeBand ?? "unknown"} (${p.volumeSource ?? "none"}).`
  );
}

export async function estimateKeyword(
  workspaceId: string,
  keyword: string,
  locale: string,
  opts: EstimateOptions = {},
): Promise<EstimateOutcome> {
  const kw = keyword.trim();
  if (!kw) return { ok: false, reason: "keyword is required.", missing: ["keyword"] };
  const loc = (locale || "en-US").trim();

  // 1. SERP — hard requirement. No SERP, no estimate.
  let serp: Awaited<ReturnType<typeof fetchSerp>>;
  try {
    serp = await fetchSerp(workspaceId, kw, loc, { needAiOverview: true, numResults: 10 });
  } catch (e) {
    if (e instanceof VendorNotConfigured) {
      return {
        ok: false,
        reason:
          "No SERP vendor is configured for this workspace — difficulty needs a top-10 SERP. " +
          "Connect one in Intelligence → Data sources.",
        missing: ["serp"],
      };
    }
    return { ok: false, reason: `SERP fetch failed: ${(e as Error).message}`, missing: ["serp"] };
  }
  const top10 = serp.results.slice(0, 10);
  if (top10.length === 0) {
    return { ok: false, reason: "SERP returned no organic results.", missing: ["serp"] };
  }

  // 2. Volume band — soft requirement (missing → wider band).
  let volume: VolumeInput | null = null;
  try {
    const v = await lookupVolume(workspaceId, kw, loc);
    const range = bandToRange(v.band);
    volume = { band: v.band, lo: range.lo, hi: range.hi, source: v.source };
  } catch (e) {
    if (!(e instanceof VolumeUnavailableError)) throw e;
    volume = null;
  }

  // 3. Authority for the ranking domains (+ the user's own domain when given).
  const domains = top10.map((r) => normalizeDomain(r.domain));
  const authority = await resolveAuthority(workspaceId, domains, opts);

  let ownDomainAuthority: number | null = null;
  if (opts.ownDomainAuthority != null) {
    ownDomainAuthority = Math.min(100, Math.max(0, opts.ownDomainAuthority));
  } else if (opts.ownDomain) {
    const own = await resolveAuthority(workspaceId, [opts.ownDomain], opts);
    const blend = own.blends.get(normalizeDomain(opts.ownDomain));
    ownDomainAuthority = blend && blend.sources.length > 0 ? blend.score : null;
  }

  // 4. Model.
  const modelInputs: ModelInputs = {
    keyword: kw,
    locale: loc,
    serp: {
      results: top10.map((r) => ({
        position: r.position,
        url: r.url,
        domain: r.domain,
        title: r.title,
      })),
      aiOverviewPresent: serp.aiOverviewPresent,
      serpFeatures: serp.serpFeatures,
    },
    authority: authority.blends,
    volume,
    ownDomainAuthority,
    serpVendor: serp.vendor,
  };
  const output = computeDifficulty(modelInputs);

  // 5. Versioned artifact (never rewrites history — see store.ts).
  const row = await upsertEstimate(workspaceId, { keyword: kw, locale: loc, output });

  const { experimental } = gateStatus();
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "difficulty_estimated" as FileChangeAction,
    summary: summarize(kw, output) + (experimental ? " [experimental]" : " [model live]"),
    actor: "ai",
  });

  return { ok: true, output, row, experimental };
}

/** Batch estimate (sequential — protects vendor budgets). */
export async function estimateKeywords(
  workspaceId: string,
  keywords: string[],
  locale: string,
  opts: EstimateOptions = {},
): Promise<{ results: Array<{ keyword: string; outcome: EstimateOutcome }>; modelVersion: string }> {
  const list = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].slice(0, MAX_BATCH);
  const results: Array<{ keyword: string; outcome: EstimateOutcome }> = [];
  for (const keyword of list) {
    results.push({ keyword, outcome: await estimateKeyword(workspaceId, keyword, locale, opts) });
  }
  return { results, modelVersion: MODEL_VERSION };
}

/** Pure helper for tests: run the model straight from a fixture (no I/O). */
export function estimateFromFixture(params: {
  keyword: string;
  locale: string;
  serp: ModelInputs["serp"];
  authorityRaw: Array<{ domain: string; mozDA?: number | null; oprInteger?: number | null; ccPrPos?: number | null }>;
  volumeBand: string | null;
  volumeSource?: string;
  ownDomainAuthority?: number | null;
  serpVendor?: string;
}): DifficultyOutput {
  const blends = new Map(
    params.authorityRaw.map((raw) => [
      normalizeDomain(raw.domain),
      blendAuthority({ ...raw, domain: raw.domain }),
    ]),
  );
  let volume: VolumeInput | null = null;
  if (params.volumeBand) {
    const range = bandToRange(params.volumeBand);
    volume = {
      band: params.volumeBand,
      lo: range.lo,
      hi: range.hi,
      source: params.volumeSource ?? "fixture",
    };
  }
  return computeDifficulty({
    keyword: params.keyword,
    locale: params.locale,
    serp: params.serp,
    authority: blends,
    volume,
    ownDomainAuthority: params.ownDomainAuthority,
    serpVendor: params.serpVendor ?? "fixture",
  });
}

export { MODEL_VERSION };

// ── M5-GATE seam: the vendor-replacement point ──────────────────────────────
// THE difficulty call site. lib/keywords/research.ts routes every
// keywordIdeas() difficulty value through resolveIdeaDifficulties(). While
// the eval bar (gate.ts) is unmet — the normal state — vendor difficulty
// passes through untouched: there is no forked second path, the model
// simply doesn't replace anything yet.
//
// Once a live eval records a PASS for the current MODEL_VERSION (the only
// writer is scripts/eval-difficulty.mts --live --write-state), each idea's
// difficulty is replaced by the full estimate pipeline (which persists a
// versioned artifact per keyword — model bumps never rewrite history).
// Replacement is sequential and chunked at MAX_BATCH to protect vendor
// budgets; an individual refusal keeps that idea's vendor value rather
// than inventing a difficulty (a §2 violation).
export interface IdeaDifficulty {
  phrase: string;
  difficulty: number | null;
  difficultySource?: "vendor" | "model";
}

export async function resolveIdeaDifficulties<T extends IdeaDifficulty>(
  workspaceId: string,
  ideas: T[],
  locale: string,
  deps: {
    /** Injected for tests — production uses the on-disk eval gate. */
    gateOpen?: () => boolean;
    estimate?: (
      workspaceId: string,
      keyword: string,
      locale: string,
    ) => Promise<EstimateOutcome>;
  } = {},
): Promise<{ ideas: T[]; replaced: boolean }> {
  const gateOpen = deps.gateOpen ?? shouldReplaceVendor;
  if (!gateOpen()) {
    // Gate closed: vendor values pass through; difficultySource stays
    // "vendor" (or unset). The model never runs here.
    return { ideas, replaced: false };
  }
  const estimate = deps.estimate ?? estimateKeyword;
  const loc = (locale || "en-US").trim();
  const out: T[] = [];
  for (let i = 0; i < ideas.length; i += MAX_BATCH) {
    for (const idea of ideas.slice(i, i + MAX_BATCH)) {
      try {
        const outcome = await estimate(workspaceId, idea.phrase, loc);
        if (outcome.ok) {
          out.push({
            ...idea,
            difficulty: outcome.output.estimate,
            difficultySource: "model" as const,
          });
        } else {
          // Refused (e.g. no SERP vendor) — keep the vendor value, never invent.
          out.push({ ...idea, difficultySource: "vendor" as const });
        }
      } catch {
        out.push({ ...idea, difficultySource: "vendor" as const });
      }
    }
  }
  return { ideas: out, replaced: true };
}
