// Marketr — Phase 15 slice 6: sampled tier-accuracy eval (spec §6).
//
// Runs deriveTier() over the human-labeled gold set
// (scripts/eval-data/phase15-tier-gold.json — 12 tools × 8 fixture
// toolkits = 96 entries) and writes
// scripts/eval-results/phase15-tier-accuracy.json:
//
//   { ranAt, target, overall, entryCount, goldSha, perToolkit: { slug: { agreement, n, passed } } }
//
// TARGET: agreement ≥ 90% per toolkit. Exits non-zero if any toolkit is
// below target.
//
// The committed results JSON is the runtime auto-read gate's proof
// (derive.ts isToolkitAutoReadLive, spec §6 "classifier agreement ≥ target
// before a toolkit's auto-read tier goes live"): a toolkit's derived LOW
// tier only executes silently once this eval passes for it AND the results
// are fresh vs the gold set (goldSha binding — editing the gold set
// without re-running the eval can never keep a toolkit live).
//
// Run: npx tsx scripts/eval-phase15-tier-accuracy.mts
// Requires: nothing (pure; no DB).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveTier,
  goldShaFor,
  type TierAccuracyResults,
} from "../lib/integrations/actions/derive";

const here = dirname(fileURLToPath(import.meta.url));
const GOLD_PATH = join(here, "eval-data", "phase15-tier-gold.json");
const RESULTS_PATH = join(here, "eval-results", "phase15-tier-accuracy.json");

/** Fixture toolkitSlug → Marketr appKey (activates the per-app override table). */
const TOOLKIT_APPKEY: Record<string, string> = {
  gmail: "gmail",
  google_sheets: "google-sheets",
  slack: "slack",
  hubspot: "hubspot",
  notion: "notion",
  salesforce: "salesforce",
  zendesk: "zendesk",
  stripe: "stripe",
};

const TARGET_PCT = 90;

interface GoldEntry {
  toolkitSlug: string;
  toolSlug: string;
  description: string;
  expectedTier: "low" | "medium" | "high";
  note?: string;
}

function main() {
  const gold = JSON.parse(readFileSync(GOLD_PATH, "utf8")) as GoldEntry[];
  if (!Array.isArray(gold) || gold.length === 0) {
    console.error("gold set is empty or invalid");
    process.exit(2);
  }
  const tallies = new Map<string, { agree: number; total: number; misses: string[] }>();
  for (const e of gold) {
    const d = deriveTier(e.toolSlug, e.description, TOOLKIT_APPKEY[e.toolkitSlug]);
    const agree = d.tier === e.expectedTier;
    let t = tallies.get(e.toolkitSlug);
    if (!t) {
      t = { agree: 0, total: 0, misses: [] };
      tallies.set(e.toolkitSlug, t);
    }
    t.total++;
    if (agree) {
      t.agree++;
    } else {
      t.misses.push(
        `${e.toolSlug}: expected ${e.expectedTier}, got ${d.tier} (classified=${d.classified})`,
      );
    }
  }

  const perToolkit: TierAccuracyResults["perToolkit"] = {};
  let totalAgree = 0;
  let totalN = 0;
  const failed: string[] = [];
  for (const slug of [...tallies.keys()].sort()) {
    const t = tallies.get(slug)!;
    const pct = Math.round((t.agree / t.total) * 10000) / 100;
    const passed = pct >= TARGET_PCT;
    perToolkit[slug] = { agreement: pct, n: t.total, passed };
    totalAgree += t.agree;
    totalN += t.total;
    if (!passed) failed.push(slug);
    for (const m of t.misses) console.log(`  miss [${slug}] ${m}`);
  }

  const results: TierAccuracyResults = {
    ranAt: new Date().toISOString(),
    target: TARGET_PCT,
    overall: Math.round((totalAgree / totalN) * 10000) / 100,
    entryCount: totalN,
    goldSha: goldShaFor(gold),
    perToolkit,
  };
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");

  console.log(`\nTier-accuracy eval: ${totalAgree}/${totalN} agree (${results.overall}%), target ≥${TARGET_PCT}% per toolkit`);
  for (const slug of Object.keys(perToolkit)) {
    const p = perToolkit[slug];
    console.log(`  ${p.passed ? "PASS" : "FAIL"} ${slug}: ${p.agreement}% (${p.n} entries)`);
  }
  console.log(`results → ${RESULTS_PATH}`);
  if (failed.length > 0) {
    console.error(`\nFAIL: toolkits below target: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("\nall toolkits ≥ target — eval passed");
}

main();
