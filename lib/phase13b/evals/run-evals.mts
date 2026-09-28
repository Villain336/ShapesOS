// Marketr — Phase 13B eval runner (worker 7).
//
// Runs all 7 acceptance suites and prints a PASS / PENDING / FAIL summary.
//   npx tsx lib/phase13b/evals/run-evals.mts [--human]
//
// --human also runs the voice-fidelity human-rated mode (EVAL_HUMAN=1),
// which writes lib/phase13b/evals/reviews/voice-fidelity-blind-<date>.md
// for Tico to rate.
//
// Exit code: 0 unless a suite FAILs (PENDING is not a failure — other
// workers' modules simply haven't landed yet).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

// Load .env so DATABASE_URL reaches the suite subprocesses when the
// runner's own environment doesn't carry it (e.g. subagent shells).
if (!process.env.DATABASE_URL) {
  const { config } = await import("dotenv");
  config({ path: join(REPO, ".env") });
}

const SUITES = [
  ["01-lesson-quality", "Lesson quality (consolidation contract + rubric)"],
  ["02-preference-precision", "Preference-retrieval precision (20 prefs, tenant isolation)"],
  ["03-style-rule-enforcement", "Style-rule enforcement (contract + violation battery)"],
  ["04-voice-fidelity", "Voice-fidelity blind eval (automated + human-rated)"],
  ["05-no-ghost-recall", "No-ghost-recall (learnings, prefs, episodes)"],
  ["06-stop-asking", "\"Stops asking known things\" (prompt injection proxy)"],
  ["07-feedback-diff", "Feedback-diff sanity (pairs + contract)"],
] as const;

type Status = "PASS" | "PENDING" | "FAIL";

interface SuiteOutcome {
  file: string;
  title: string;
  status: Status;
  passed: number;
  skipped: number;
  failed: number;
  skipReasons: string[];
  failureLines: string[];
}

function parseTap(tap: string): { passed: number; skipped: number; failed: number; skipReasons: string[]; failureLines: string[] } {
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  const skipReasons: string[] = [];
  const failureLines: string[] = [];
  for (const raw of tap.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^(not )?ok \d+ - (.+)$/);
    if (!m) continue;
    // TAP spec: a "# SKIP" directive means the test was skipped, whether
    // the reporter wrote "ok" (boolean skip) or "not ok" (string skip —
    // a node:test quirk where the reason string flips the verdict word).
    const skipM = line.match(/# SKIP\s*(.*)$/);
    if (skipM) {
      skipped++;
      // Reason may live in the test name (pendingName embeds it there
      // because node renders string skip-reasons as `not ok`).
      const nameReason = line.match(/— PENDING: (.+?)(?: # SKIP)?$/);
      const reason = (nameReason?.[1] ?? skipM[1]).trim();
      if (reason && !skipReasons.includes(reason)) skipReasons.push(reason);
    } else if (m[1]) {
      failed++;
      failureLines.push(line);
    } else {
      passed++;
    }
  }
  return { passed, skipped, failed, skipReasons, failureLines };
}

async function runSuite(file: string, title: string): Promise<SuiteOutcome> {
  const path = join(HERE, `${file}.test.ts`);
  const env = { ...process.env };
  if (process.argv.includes("--human")) env.EVAL_HUMAN = "1";
  let tap = "";
  let failed = 0;
  try {
    const { stdout, stderr } = await execFileP(
      "npx",
      ["tsx", "--test", "--test-reporter=tap", path],
      { cwd: REPO, env, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
    );
    tap = stdout + stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    tap = (err.stdout ?? "") + (err.stderr ?? "");
    failed = 1; // process-level failure (crash/timeout)
  }
  const p = parseTap(tap);
  failed += p.failed;
  const status: Status = failed > 0 ? "FAIL" : p.skipped > 0 ? "PENDING" : "PASS";
  return {
    file,
    title,
    status,
    passed: p.passed,
    skipped: p.skipped,
    failed,
    skipReasons: p.skipReasons,
    failureLines: p.failureLines,
  };
}

async function main(): Promise<void> {
  console.log("Phase 13B evals — acceptance suites");
  console.log(`Repo: ${REPO}`);
  console.log(`Date: ${new Date().toISOString()}`);
  console.log("");

  const outcomes: SuiteOutcome[] = [];
  for (const [file, title] of SUITES) {
    process.stdout.write(`running ${file} ... `);
    const o = await runSuite(file, title);
    console.log(o.status);
    outcomes.push(o);
  }

  console.log("");
  console.log("=".repeat(78));
  console.log("SUMMARY");
  console.log("=".repeat(78));
  for (const o of outcomes) {
    const counts = `pass ${o.passed} · skip ${o.skipped} · fail ${o.failed}`;
    console.log(`[${o.status.padEnd(7)}] ${o.file} — ${o.title}`);
    console.log(`           ${counts}`);
    for (const r of o.skipReasons.slice(0, 3)) {
      console.log(`           pending: ${r.slice(0, 130)}${r.length > 130 ? "…" : ""}`);
    }
    for (const f of o.failureLines.slice(0, 5)) {
      console.log(`           FAIL: ${f.slice(0, 150)}`);
    }
  }
  console.log("=".repeat(78));
  const nPass = outcomes.filter((o) => o.status === "PASS").length;
  const nPend = outcomes.filter((o) => o.status === "PENDING").length;
  const nFail = outcomes.filter((o) => o.status === "FAIL").length;
  console.log(`Suites: ${nPass} PASS · ${nPend} PENDING · ${nFail} FAIL`);

  const resultsDir = join(HERE, "results");
  await mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await writeFile(
    join(resultsDir, `eval-run-${stamp}.json`),
    JSON.stringify({ date: new Date().toISOString(), outcomes }, null, 2),
  );
  console.log(`Results saved to lib/phase13b/evals/results/eval-run-${stamp}.json`);

  if (nFail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("eval runner crashed:", e);
  process.exit(2);
});
