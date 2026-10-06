// ShapesOS — Phase 17 evaluation harness, dry run against Postgres: the
// whole runner (seed → real chat loop → FAKE Anthropic model, MOCK → ledger
// → table) works, every scripted task passes, cost comes from the usage
// events, and the $ cap stops the sweep BEFORE a task that could cross it,
// with the partial table written.
// Run: DATABASE_URL=… npx tsx --test scripts/eval/__tests__/eval-dry-run-db.test.ts

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/prisma";
import { runEval } from "../runner";

after(async () => {
  await prisma.$disconnect();
});

const quiet = () => undefined;

describe("evaluation harness dry run (fake model)", () => {
  it("runs tasks through the real chat loop for two configs; cost per task is read from the usage events", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "p17-eval-"));
    const out = await runEval({ dryRun: true, configs: ["baseline", "routing"], maxUsd: 30, tasks: ["qa-keywords", "crm-create-contact", "money-guard", "content-linkedin"], outDir, judge: true, log: quiet });
    assert.equal(out.stopped, null);
    assert.equal(out.results.length, 8);
    for (const r of out.results) assert.ok(r.pass, `${r.config}/${r.taskId}: ${r.reasons.join("; ")}`);
    const kw = out.results.find((r) => r.config === "baseline" && r.taskId === "qa-keywords")!;
    assert.ok(kw.costUsd > 0 && kw.calls >= 2, "measured from the ledger");
    // Oracle routing put the simple/tools tasks on Sonnet 5.5: cheaper than Opus at the same tokens.
    const routed = out.results.find((r) => r.config === "routing" && r.taskId === "qa-keywords")!;
    assert.ok(routed.costUsd < kw.costUsd, `${routed.costUsd} < ${kw.costUsd}`);
    const md = readFileSync(out.markdownPath, "utf8");
    assert.match(md, /DRY RUN — FAKE model \(MOCK\)/);
    assert.match(md, /\| baseline \| 4 \| 100% \(4\)/);
    const json = JSON.parse(readFileSync(out.jsonPath, "utf8"));
    assert.equal(json.results.length, 8);
  });

  it("the $ cap: the sweep stops before a task that could cross it and writes the partial table", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "p17-eval-cap-"));
    // Each fake task costs ~$0.057 (two Opus calls + the facts summary). A
    // $0.32 cap: the first task is let in on the $0.30 estimate, then each
    // next task is projected at the most expensive one so far — five
    // baseline tasks fit ($0.284), a sixth (routing's first, projected
    // $0.34) is never started.
    const ids = ["qa-keywords", "qa-rankings", "qa-best-rank", "qa-competitors", "qa-content"];
    const out = await runEval({ dryRun: true, configs: ["baseline", "routing"], maxUsd: 0.32, tasks: ids, outDir, judge: true, log: quiet });
    assert.ok(out.stopped, "stopped on the budget");
    assert.match(out.stopped!, /routing\/qa-keywords.*past the \$0\.32 cap/);
    assert.ok(out.spentUsd <= 0.32, `spent ${out.spentUsd}`);
    assert.equal(out.results.length, 5);
    assert.ok(out.results.every((r) => r.config === "baseline"));
    assert.ok(existsSync(out.markdownPath));
    assert.match(readFileSync(out.markdownPath, "utf8"), /STOPPED:/);
  });

  it("a real run refuses to start without ANTHROPIC_API_KEY in the environment", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(runEval({ dryRun: false, configs: ["baseline"], maxUsd: 1, tasks: ["qa-keywords"], outDir: mkdtempSync(join(tmpdir(), "p17-eval-nokey-")), judge: false, log: quiet }), /needs ANTHROPIC_API_KEY in the environment/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
