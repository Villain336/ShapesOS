#!/usr/bin/env tsx
// Marketr — Phase 10 M9: corpus eval benchmark (M7 verification battery).
//
// 22 held-out Q&A with expected source-attributed answers. Each question
// retrieves top-1 from the corpus; a question scores when the top-1 hit is
// from an expected source AND contains at least one expected keyword.
// Precision = correct / total. Covers BOTH layers: verbatim sources and
// the Tier 1S synthesized playbooks.
//
// "The corpus grows only when precision holds" (docs/specs/SPEC-PHASE10.md §M9): this
// script records precision into the manifest (evalPrecision / evalRunAt) and
// exits non-zero below 0.60 so CI/build gates can block on it.
//
// Usage:
//   npx tsx scripts/eval-corpus.mts
//   CORPUS_DIR=/tmp/corpus-test npx tsx scripts/eval-corpus.mts

import fs from "node:fs";
import path from "node:path";
import { retrieveExpertContext } from "../lib/intelligence/corpus/index";
import { loadManifest, saveManifest, corpusDir } from "../lib/intelligence/corpus/store";

interface EvalQuestion {
  id: string;
  question: string;
  /** Top-1 hit must come from one of these source ids. */
  expectedSourceIds: string[];
  /** Top-1 hit text must contain ≥1 of these (case-insensitive). */
  expectedKeywords: string[];
  layer: "verbatim" | "1S";
}

const QUESTIONS: EvalQuestion[] = [
  // ── Verbatim layer ──
  {
    id: "q-gsc-crawl", layer: "verbatim", question: "How does Google recommend helping search engines discover and crawl pages?",
    expectedSourceIds: ["google-search-central"], expectedKeywords: ["crawl", "discover", "sitemap"],
  },
  {
    id: "q-hopkins-headlines", layer: "verbatim", question: "According to Claude Hopkins in Scientific Advertising, what makes headlines work?",
    expectedSourceIds: ["scientific-advertising", "my-life-in-advertising"], expectedKeywords: ["headline", "curiosity"],
  },
  {
    id: "q-hopkins-campaigns", layer: "verbatim", question: "Pepsodent Tooth Paste: what does Claude Hopkins call the greatest success of his advertising career?",
    expectedSourceIds: ["my-life-in-advertising", "scientific-advertising"], expectedKeywords: ["Pepsodent", "twenty-two years"],
  },
  {
    id: "q-scott-suggestion", layer: "verbatim", question: "How does suggestion work in advertising according to Walter Dill Scott — why do repeated suggestions make us forget their source?",
    expectedSourceIds: ["scott-psychology-of-advertising"], expectedKeywords: ["suggestion", "forget the source"],
  },
  {
    id: "q-calkins-soft-sell", layer: "verbatim", question: "According to Calkins' The Business of Advertising, what were the early advertising agencies like?",
    expectedSourceIds: ["calkins-business-of-advertising"], expectedKeywords: ["advertising agencies", "newspapers"],
  },
  {
    id: "q-sba-plan", layer: "verbatim", question: "What should a small business include in its marketing plan and market research?",
    expectedSourceIds: ["sba-marketing-guides"], expectedKeywords: ["market research", "target market", "competitive"],
  },
  {
    id: "q-grayson-social", layer: "verbatim", question: "What role does social media play in the digital marketing customer journey?",
    expectedSourceIds: ["grayson-foundations-digital-marketing"], expectedKeywords: ["social media", "customer journey", "touchpoint"],
  },
  {
    id: "q-wiki-mix", layer: "verbatim", question: "What are the four Ps of the marketing mix?",
    expectedSourceIds: ["wikipedia-marketing-clusters", "nscc-intro-marketing"], expectedKeywords: ["product", "price", "place", "promotion"],
  },
  {
    id: "q-grayson-journey", layer: "verbatim", question: "What is the customer journey in digital marketing?",
    expectedSourceIds: ["grayson-foundations-digital-marketing"], expectedKeywords: ["customer journey", "touchpoint"],
  },
  {
    id: "q-nscc-strategy", layer: "verbatim", question: "How does a marketing strategy use the marketing mix to reach target customers?",
    expectedSourceIds: ["nscc-intro-marketing", "wikipedia-marketing-clusters"], expectedKeywords: ["marketing mix", "target customer"],
  },
  {
    id: "q-mwm-tactics", layer: "verbatim", question: "What zero-budget marketing channels does the marketing-without-money guide cover?",
    expectedSourceIds: ["marketing-without-money"], expectedKeywords: ["Content Marketing", "Email Marketing", "Community Building"],
  },
  // ── Tier 1S synthesized layer ──
  {
    id: "q-1s-social-budget", layer: "1S", question: "Where should budget be set in a Meta ads account to let the system distribute spend across ad sets?",
    expectedSourceIds: ["1s-meta-blueprint"], expectedKeywords: ["campaign-level", "campaign budget", "ad set"],
  },
  {
    id: "q-1s-search-quality", layer: "1S", question: "What three components make up Quality Score in Google Ads?",
    expectedSourceIds: ["1s-google-skillshop", "grayson-foundations-digital-marketing"], expectedKeywords: ["expected click-through rate", "ad relevance", "landing-page"],
  },
  {
    id: "q-1s-bing-indexnow", layer: "1S", question: "What protocol should publishers use for instant URL notification to Bing when pages are added or updated?",
    expectedSourceIds: ["1s-bing-webmaster"], expectedKeywords: ["IndexNow"],
  },
  {
    id: "q-1s-tiktok-hook", layer: "1S", question: "What is the most important creative rule for short-form video ads?",
    expectedSourceIds: ["1s-tiktok-academy"], expectedKeywords: ["hook", "first 2 seconds", "native"],
  },
  {
    id: "q-1s-b2b-committee", layer: "1S", question: "Who should B2B paid campaigns target beyond a single persona?",
    expectedSourceIds: ["1s-linkedin-marketing-labs"], expectedKeywords: ["buying committee"],
  },
  {
    id: "q-1s-inbound-flywheel", layer: "1S", question: "What are the three stages of the inbound marketing flywheel?",
    expectedSourceIds: ["1s-hubspot-academy"], expectedKeywords: ["attract", "engage", "delight"],
  },
  {
    id: "q-1s-email-triggered", layer: "1S", question: "Which automated email journeys should every marketer build first — welcome series, abandoned cart, post-purchase?",
    expectedSourceIds: ["1s-trailhead"], expectedKeywords: ["welcome series", "abandoned cart"],
  },
  {
    id: "q-1s-cro-hypothesis", layer: "1S", question: "What three parts make an A/B test hypothesis testable?",
    expectedSourceIds: ["1s-cxl-blog", "grayson-foundations-digital-marketing"], expectedKeywords: ["research", "metric", "hypothesis"],
  },
  {
    id: "q-1s-copy-questions", layer: "1S", question: "What four buyer questions must conversion copy answer?",
    expectedSourceIds: ["1s-copyhackers-blog"], expectedKeywords: ["what's in it for me", "why should I believe", "why now"],
  },
  {
    id: "q-1s-channel", layer: "1S", question: "What should an early-stage startup find before diversifying across marketing channels: the one channel that works?",
    expectedSourceIds: ["1s-demand-curve-blog"], expectedKeywords: ["one channel"],
  },
  {
    id: "q-1s-seo-serp", layer: "1S", question: "What should you analyze before writing SEO content for a target keyword?",
    expectedSourceIds: ["1s-ahrefs-blog"], expectedKeywords: ["SERP", "search intent"],
  },
];

const PRECISION_FLOOR = 0.6;

interface EvalResult {
  id: string;
  layer: string;
  correct: boolean;
  topSourceId: string | null;
  topSourceTitle: string | null;
  matchedKeyword: string | null;
  note: string;
}

async function main(): Promise<void> {
  console.log(`[m9-eval] ${QUESTIONS.length} questions (verbatim + 1S layers)`);

  // Title → source id map from the manifest. 1S chunks are attributed as
  // "Marketr Tier 1S synthesis from <target source title>".
  const manifestForMap = loadManifest();
  const titleToId = new Map<string, string>();
  for (const s of manifestForMap?.sources ?? []) {
    if (s.tier === "learn-only") {
      titleToId.set(`Marketr Tier 1S synthesis from ${s.title}`, `1s-${s.id}`);
    } else {
      titleToId.set(s.title, s.id);
    }
  }

  const results: EvalResult[] = [];
  let correct = 0;

  for (const q of QUESTIONS) {
    let note = "";
    let correctQ = false;
    let topSourceId: string | null = null;
    let topSourceTitle: string | null = null;
    let matchedKeyword: string | null = null;
    try {
      const hits = await retrieveExpertContext(q.question, { topK: 1 });
      const top = hits[0];
      if (top) {
        // Source check: resolve the hit's attributed title through the
        // manifest map (never through the expected list — a wrong source
        // must fail even if it shares the tier).
        topSourceTitle = top.sourceTitle;
        const textLower = top.text.toLowerCase();
        matchedKeyword = q.expectedKeywords.find((k) => textLower.includes(k.toLowerCase())) ?? null;
        topSourceId = titleToId.get(top.sourceTitle) ?? null;
        correctQ = !!matchedKeyword && !!topSourceId && q.expectedSourceIds.includes(topSourceId);
        if (!matchedKeyword) note = "no expected keyword in top-1 text";
        else if (!topSourceId || !q.expectedSourceIds.includes(topSourceId))
          note = `top-1 from "${top.sourceTitle}" (expected one of ${q.expectedSourceIds.join(", ")})`;
      } else {
        note = "no hits (empty corpus?)";
      }
    } catch (err) {
      note = `retrieval error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (correctQ) correct++;
    results.push({ id: q.id, layer: q.layer, correct: correctQ, topSourceId, topSourceTitle, matchedKeyword, note });
    console.log(`  ${correctQ ? "✓" : "✗"} [${q.layer}] ${q.id}${note ? ` — ${note}` : ""}`);
  }

  const precision = results.length ? correct / results.length : 0;
  const byLayer = (l: string) => {
    const rs = results.filter((r) => r.layer === l);
    return rs.length ? rs.filter((r) => r.correct).length / rs.length : 0;
  };
  console.log(
    `\n[m9-eval] precision ${(precision * 100).toFixed(1)}% (${correct}/${results.length}) ` +
      `· verbatim ${(byLayer("verbatim") * 100).toFixed(1)}% · 1S ${(byLayer("1S") * 100).toFixed(1)}%`,
  );

  // Persist: results file + manifest precision (corpus version unchanged —
  // evals never bump the version).
  const outPath = path.join(corpusDir(), "eval-results.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify({ ranAt: new Date().toISOString(), precision, questions: QUESTIONS.length, results }, null, 2) + "\n",
    "utf8",
  );
  const manifest = loadManifest();
  if (manifest) {
    manifest.evalPrecision = Math.round(precision * 1000) / 1000;
    manifest.evalRunAt = new Date().toISOString();
    saveManifest(manifest);
  }
  console.log(`[m9-eval] results → ${outPath}`);

  if (precision < PRECISION_FLOOR) {
    console.error(`[m9-eval] PRECISION BELOW FLOOR (${PRECISION_FLOOR}) — corpus must not grow until this is fixed.`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("[m9-eval] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
