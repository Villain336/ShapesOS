#!/usr/bin/env npx tsx
// Marketr — Phase 10 M5: difficulty-model eval harness.
//
// Two modes:
//
//   Fixture mode (default — CI-safe, no API keys, no network):
//     npx tsx scripts/eval-difficulty.mts
//   Runs the structural fixture eval (ordering, crowding effect, uncertainty
//   honesty, provenance). Exit 0 = pass, 1 = fail. M7 runs this in CI.
//
//   Live mode (paid reference — costs real money):
//     npx tsx scripts/eval-difficulty.mts --live [--write-state] [--workspace <id>] [--keywords a,b]
//   For each held-out keyword: runs the model live (needs SERP vendor +
//   authority keys configured) and fetches the DataForSEO
//   labs/bulk_keyword_difficulty reference ($0.132/1K — ~$0.01 for 60
//   keywords). Computes MAE / Spearman / band coverage, checks the bar
//   (gate.ts), and prints PASS/FAIL. --write-state writes
//   lib/intelligence/difficulty/eval-state.json — the ONLY writer of that
//   file. The vendor-replacement gate opens only on a recorded PASS.
//
// Live env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD (reference API);
// SERP vendor keys via M6's data_source config or env; authority keys via
// OPENPAGERANK_API_KEY / MOZ_ACCESS_ID+MOZ_SECRET_KEY (optional —
// graceful degradation is part of what gets evaluated).

import { writeFileSync } from "node:fs";
import { estimateKeywords } from "../lib/intelligence/difficulty/service";
import { runFixtureEval } from "../lib/intelligence/difficulty/fixtureEval";
import {
  EVAL_BAR,
  bandCoverage,
  checkBar,
  evalStatePath,
  meanAbsoluteError,
  spearman,
  type EvalState,
} from "../lib/intelligence/difficulty/gate";
import { HELD_OUT_KEYWORDS } from "../lib/intelligence/difficulty/heldout";
import { MODEL_VERSION } from "../lib/intelligence/difficulty/model";

const DFS_BASE = "https://api.dataforseo.com/v3";

interface DfsBulkItem {
  keyword?: string;
  keyword_properties?: { keyword_difficulty?: number | null };
}

async function fetchVendorReference(
  keywords: string[],
  locale: string,
): Promise<Map<string, number>> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error(
      "Live eval needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (the paid reference).",
    );
  }
  const auth = Buffer.from(`${login}:${password}`).toString("base64");
  // location 2840 = United States; DataForSEO bulk endpoint takes up to 1000 keywords/task.
  const res = await fetch(`${DFS_BASE}/dataforseo_labs/bulk_keyword_difficulty/live`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      {
        keywords,
        location_code: 2840,
        language_code: locale.split("-")[0] ?? "en",
      },
    ]),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`DataForSEO bulk difficulty failed: HTTP ${res.status}`);
  const body = (await res.json()) as {
    tasks?: Array<{ result?: DfsBulkItem[]; status_message?: string }>;
  };
  const out = new Map<string, number>();
  for (const task of body.tasks ?? []) {
    for (const item of task.result ?? []) {
      const kd = item.keyword_properties?.keyword_difficulty;
      if (item.keyword != null && kd != null) out.set(item.keyword, kd);
    }
  }
  return out;
}

function usage(): never {
  console.log(`usage:
  npx tsx scripts/eval-difficulty.mts                      # fixture mode (CI-safe)
  npx tsx scripts/eval-difficulty.mts --live [--write-state] [--workspace <id>] [--keywords k1,k2]

options:
  --live            run against the paid DataForSEO reference (costs ~$0.01/60 keywords)
  --write-state     write eval-state.json (only meaningful with --live)
  --workspace <id>  workspace to run under (default: EVAL_WORKSPACE_ID env)
  --keywords a,b    override the held-out set (comma-separated)`);
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();
  const live = args.includes("--live");
  const writeState = args.includes("--write-state");

  // ── Fixture mode: no keys, no network ──────────────────────────────────
  if (!live) {
    const report = runFixtureEval();
    console.log(`\nM5 difficulty fixture eval — model ${report.modelVersion}`);
    for (const c of report.checks) {
      console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
    }
    console.log("\nestimates:");
    for (const e of report.estimates) {
      console.log(
        `  KD ${String(e.estimate).padStart(3)} ±${e.uncertainty} [${e.band[0]}–${e.band[1]}]  ${e.keyword}`,
      );
    }
    console.log(report.passed ? "\nFIXTURE EVAL: PASS" : "\nFIXTURE EVAL: FAIL");
    process.exit(report.passed ? 0 : 1);
  }

  // ── Live mode ──────────────────────────────────────────────────────────
  const wi = args.indexOf("--workspace");
  const workspaceId =
    (wi >= 0 ? args[wi + 1] : undefined) ?? process.env.EVAL_WORKSPACE_ID;
  if (!workspaceId) {
    console.error("Live eval needs --workspace <id> or EVAL_WORKSPACE_ID.");
    process.exit(2);
  }
  const ki = args.indexOf("--keywords");
  const keywords =
    ki >= 0 && args[ki + 1]
      ? args[ki + 1].split(",").map((k) => k.trim()).filter(Boolean)
      : HELD_OUT_KEYWORDS.map((k) => k.keyword);
  const locale = "en-US";

  console.log(
    `\nM5 difficulty LIVE eval — model ${MODEL_VERSION}, ${keywords.length} keywords`,
  );
  console.log(
    `Reference: DataForSEO labs/bulk_keyword_difficulty (~$${((keywords.length / 1000) * 0.132).toFixed(4)} for this run)`,
  );

  const { results } = await estimateKeywords(workspaceId, keywords, locale);
  const reference = await fetchVendorReference(keywords, locale);

  const pairs: Array<{ keyword: string; modeled: number; band: [number, number]; reference: number }> = [];
  const skipped: string[] = [];
  for (const { keyword, outcome } of results) {
    if (!outcome.ok) {
      skipped.push(`${keyword} (${outcome.reason})`);
      continue;
    }
    const ref = reference.get(keyword);
    if (ref == null) {
      skipped.push(`${keyword} (no vendor reference returned)`);
      continue;
    }
    pairs.push({
      keyword,
      modeled: outcome.output.estimate,
      band: outcome.output.uncertaintyBand,
      reference: ref,
    });
  }

  const metrics = {
    n: pairs.length,
    mae: meanAbsoluteError(pairs),
    spearman: spearman(pairs),
    bandCoverage: bandCoverage(pairs),
  };
  const bar = checkBar(metrics);

  console.log("\nkeyword-level:");
  for (const p of pairs) {
    const inBand = p.reference >= p.band[0] && p.reference <= p.band[1];
    console.log(
      `  modeled ${String(p.modeled).padStart(3)} [${p.band[0]}–${p.band[1]}]  vendor ${String(p.reference).padStart(3)}  ${inBand ? "in-band" : "OUT-OF-BAND"}  ${p.keyword}`,
    );
  }
  if (skipped.length > 0) {
    console.log(`\nskipped (${skipped.length}):`);
    for (const s of skipped) console.log(`  - ${s}`);
  }

  console.log("\nbar check:");
  for (const [name, c] of Object.entries(bar.checks)) {
    const v = typeof c.value === "number" ? c.value.toFixed(2) : String(c.value);
    console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${name}: ${v} (required ${c.required})`);
  }
  console.log(bar.passed ? "\nLIVE EVAL: PASS — gate opens" : "\nLIVE EVAL: FAIL — gate stays closed");

  if (writeState) {
    const state: EvalState = {
      modelVersion: MODEL_VERSION,
      evaluatedAt: new Date().toISOString(),
      passed: bar.passed,
      metrics: {
        n: metrics.n,
        mae: Number(metrics.mae.toFixed(2)),
        spearman: Number.isFinite(metrics.spearman) ? Number(metrics.spearman.toFixed(3)) : 0,
        bandCoverage: Number(metrics.bandCoverage.toFixed(3)),
        vendorReference: "dataforseo_labs_bulk_keyword_difficulty",
      },
      note: bar.passed
        ? `Passed the eval bar on ${metrics.n} held-out keywords vs. DataForSEO bulk difficulty.`
        : `Below the eval bar (need MAE ≤ ${EVAL_BAR.maxMAE}, Spearman ≥ ${EVAL_BAR.minSpearman}, coverage ≥ ${EVAL_BAR.minBandCoverage}, n ≥ ${EVAL_BAR.minKeywords}). Model stays experimental.`,
    };
    writeFileSync(evalStatePath(), JSON.stringify(state, null, 2) + "\n");
    console.log(`\nwrote ${evalStatePath()}`);
  } else {
    console.log("\n(not writing eval-state.json — pass --write-state to record)");
  }
  process.exit(bar.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(`eval failed: ${(e as Error).message}`);
  process.exit(1);
});
