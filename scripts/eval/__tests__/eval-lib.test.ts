// ShapesOS — Phase 17 evaluation harness: checkers, configs, the $ budget
// guard, argument rules and the frozen task set (PURE).
// Run: env -u DATABASE_URL npx tsx --test scripts/eval/__tests__/eval-lib.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIGS, DEFAULT_MAX_USD, DEFAULT_SWEEP, canStartTask, checkTask, envFor, percentile, resultsMarkdown, summarize, type TaskResult } from "../lib";
import { loadTasks, parseArgs } from "../runner";
import { allTools } from "@/lib/chat/tools";
import "@/lib/chat/agent";

describe("the frozen task set", () => {
  const tasks = loadTasks();
  it("has ~30 real requests across chat Q&A, CRM/ops, SEO, content, one coding task and one delegation task", () => {
    assert.equal(tasks.length, 30);
    const cats = new Set(tasks.map((t) => t.category));
    for (const c of ["qa", "crm", "ops", "seo", "content", "code", "delegation"]) assert.ok(cats.has(c), c);
    assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length, "unique ids");
    for (const t of tasks) {
      assert.ok(Object.keys(t.check).length > 0, `${t.id} has a check`);
      assert.ok(t.dryRun.length > 0, `${t.id} has a dry-run script`);
    }
  });

  it("every tool a check or a dry-run script names exists in the registry", () => {
    const names = new Set([...allTools().map((t) => t.name), "delegate_tasks", "delegate_to_subagent"]);
    for (const t of tasks) {
      const named = [...(t.check.toolsCalled ?? []), ...(t.check.proposed ?? []), ...(t.check.notExecuted ?? [])].flatMap((s) => s.split("|"));
      for (const s of t.dryRun) for (const c of s.calls ?? []) named.push(c.name);
      for (const n of named) assert.ok(names.has(n), `${t.id}: ${n}`);
    }
  });
});

describe("checkTask", () => {
  it("tools called (with alternatives), proposals left waiting, money never executed", () => {
    assert.equal(checkTask({ toolsCalled: ["get_rankings|get_keywords"] }, { answer: "", calls: [{ tool: "get_keywords", status: "executed" }] }).pass, true);
    assert.equal(checkTask({ toolsCalled: ["get_rankings"] }, { answer: "", calls: [{ tool: "get_rankings", status: "denied" }] }).pass, false);
    assert.equal(checkTask({ proposed: ["ops_create_deal"] }, { answer: "", calls: [{ tool: "ops_create_deal", status: "pending_confirmation" }] }).pass, true);
    assert.match(checkTask({ proposed: ["ops_create_deal"] }, { answer: "", calls: [{ tool: "ops_create_deal", status: "executed" }] }).reasons[0], /EXECUTED without the user's OK/);
    assert.equal(checkTask({ notExecuted: ["ops_mark_invoice_paid"] }, { answer: "", calls: [{ tool: "ops_mark_invoice_paid", status: "pending_confirmation" }] }).pass, true);
    assert.equal(checkTask({ notExecuted: ["ops_mark_invoice_paid"] }, { answer: "", calls: [{ tool: "ops_mark_invoice_paid", status: "executed" }] }).pass, false);
  });

  it("answer checks", () => {
    const out = { answer: "Espresso Machines ranks 3", calls: [] };
    assert.equal(checkTask({ answerIncludes: ["espresso machines"], answerMatches: "\\b3\\b", noTools: true, minAnswerChars: 5, maxAnswerChars: 100 }, out).pass, true);
    assert.equal(checkTask({ maxAnswerChars: 5 }, out).pass, false);
    assert.equal(checkTask({ noTools: true }, { answer: "", calls: [{ tool: "get_keywords", status: "executed" }] }).pass, false);
  });
});

describe("configurations and the $ budget", () => {
  it("sweep order: baseline, then routing, then the effort levels; default cap $30", () => {
    assert.deepEqual(DEFAULT_SWEEP.slice(0, 2), ["baseline", "routing"]);
    assert.equal(DEFAULT_MAX_USD, 30);
    for (const c of DEFAULT_SWEEP) assert.ok(CONFIGS[c], c);
  });

  it("oracle routing picks the model/effort by complexity; baseline clears overrides", () => {
    assert.deepEqual(envFor(CONFIGS.routing, { complexity: "simple" }), { CHAT_CACHE_LAYOUT: undefined, LLM_MODEL_LEAD: "claude-sonnet-5-5", LLM_EFFORT_LEAD: "low" });
    assert.equal(envFor(CONFIGS.routing, { complexity: "planning" }).LLM_MODEL_LEAD, undefined);
    assert.equal(envFor(CONFIGS.baseline, { complexity: "simple" }).LLM_EFFORT_LEAD, undefined);
    assert.equal(envFor(CONFIGS["layout-legacy"], { complexity: "tools" }).CHAT_CACHE_LAYOUT, "legacy");
  });

  it("a task that could take the spend past the cap is never started", () => {
    assert.deepEqual(canStartTask({ maxUsd: 30, spentUsd: 0, maxTaskUsd: 0 }, {}), { ok: true, projectedUsd: 0.3 });
    assert.equal(canStartTask({ maxUsd: 30, spentUsd: 29.5, maxTaskUsd: 0.4 }, {}).ok, true);
    assert.equal(canStartTask({ maxUsd: 30, spentUsd: 29.7, maxTaskUsd: 0.4 }, {}).ok, false);
    assert.equal(canStartTask({ maxUsd: 1, spentUsd: 0.5, maxTaskUsd: 0 }, { estimateUsd: 0.6 }).ok, false, "the fixture estimate counts before any task was measured");
  });

  it("the key is only ever the environment variable: key flags are refused", () => {
    assert.throws(() => parseArgs(["--key", "sk-ant-x"]), /ANTHROPIC_API_KEY environment variable/);
    assert.throws(() => parseArgs(["--api-key=sk"]), /ANTHROPIC_API_KEY/);
    assert.throws(() => parseArgs(["--max-usd", "-1"]), /positive/);
    assert.throws(() => parseArgs(["--configs", "nope"]), /unknown config/);
    const o = parseArgs(["--dry-run", "--configs", "baseline", "--max-usd", "5"]);
    assert.deepEqual([o.dryRun, o.configs, o.maxUsd], [true, ["baseline"], 5]);
  });
});

describe("results", () => {
  const r = (config: string, taskId: string, pass: boolean, costUsd: number, latencyMs: number): TaskResult => ({
    config, taskId, category: "qa", pass, reasons: pass ? [] : ["x"], judge: "skipped (no rubric)", costUsd, calls: 2, cacheReadShare: 0.5, ttftMs: 400, latencyMs, answer: "", tools: [],
  });
  it("summaries and the comparison table", () => {
    const rs = [r("baseline", "a", true, 0.1, 1000), r("baseline", "b", false, 0.3, 3000), r("routing", "a", true, 0.05, 800)];
    const s = summarize("baseline", rs);
    assert.equal(s.passRate, 0.5);
    assert.equal(Math.round(s.costPerTaskUsd * 100), 20);
    assert.equal(percentile([1, 2, 3, 4], 0.5), 3);
    const md = resultsMarkdown({ title: "t", dryRun: true, maxUsd: 30, spentUsd: 0.45, stopped: "cap", configs: ["baseline", "routing"], results: rs });
    assert.match(md, /DRY RUN — FAKE model/);
    assert.match(md, /STOPPED: cap/);
    assert.match(md, /\| baseline \| 2 \| 50% \(1\) \|/);
    assert.match(md, /\| a \| pass \$0\.1000 \| pass \$0\.0500 \|/);
  });
});
