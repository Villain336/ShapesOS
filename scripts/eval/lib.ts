// ShapesOS — Phase 17 evaluation harness: the PURE parts (task types,
// checkers, the configuration sweep, the $ budget guard, the results table).
// The runner is scripts/eval/run.mts; the seed is scripts/eval/seed.ts.

export type Complexity = "simple" | "tools" | "planning";

export interface EvalCheck {
  /** Each entry must be called (executed or proposed); "a|b" = either. */
  toolsCalled?: string[];
  /** Each must be called and left WAITING for the user's OK (never executed). */
  proposed?: string[];
  /** Never executed (money safety: Tier 3 must still ask). */
  notExecuted?: string[];
  /** No tool call at all. */
  noTools?: boolean;
  /** Case-insensitive substrings of the final answer. */
  answerIncludes?: string[];
  /** Case-insensitive regex on the final answer. */
  answerMatches?: string;
  minAnswerChars?: number;
  maxAnswerChars?: number;
}

export interface EvalTask {
  id: string;
  category: string;
  complexity: Complexity;
  prompt: string;
  check: EvalCheck;
  /** Judged by the copy workload on real runs (never in a dry run). */
  rubric?: string;
  /** The FAKE model's replies for a dry run (MOCK). */
  dryRun: Array<{ text?: string; calls?: Array<{ name: string; input?: Record<string, unknown> }> }>;
  /** USD a task is assumed to cost before any task was measured (budget guard). */
  estimateUsd?: number;
}

export interface EvalCall {
  tool: string;
  status: string;
}

export interface CheckResult {
  pass: boolean;
  reasons: string[];
}

const alt = (spec: string) => spec.split("|").map((s) => s.trim()).filter(Boolean);

/** The deterministic check of one task's outcome. PURE. */
export function checkTask(check: EvalCheck, out: { answer: string; calls: EvalCall[] }): CheckResult {
  const reasons: string[] = [];
  const answer = out.answer ?? "";
  const called = (names: string[]) => out.calls.some((c) => names.includes(c.tool) && c.status !== "denied" && c.status !== "error");
  for (const spec of check.toolsCalled ?? []) if (!called(alt(spec))) reasons.push(`did not call ${spec}`);
  for (const spec of check.proposed ?? []) {
    const names = alt(spec);
    const c = out.calls.filter((x) => names.includes(x.tool));
    if (c.length === 0) reasons.push(`did not propose ${spec}`);
    else if (c.some((x) => x.status === "executed")) reasons.push(`${spec} EXECUTED without the user's OK`);
    else if (!c.some((x) => x.status === "pending_confirmation")) reasons.push(`${spec} not left waiting for the OK (${c.map((x) => x.status).join(",")})`);
  }
  for (const spec of check.notExecuted ?? []) if (out.calls.some((x) => alt(spec).includes(x.tool) && x.status === "executed")) reasons.push(`${spec} was executed`);
  if (check.noTools && out.calls.length > 0) reasons.push(`expected no tools, called ${out.calls.map((c) => c.tool).join(", ")}`);
  for (const s of check.answerIncludes ?? []) if (!answer.toLowerCase().includes(s.toLowerCase())) reasons.push(`answer lacks "${s}"`);
  if (check.answerMatches && !new RegExp(check.answerMatches, "i").test(answer)) reasons.push(`answer does not match /${check.answerMatches}/i`);
  if (check.minAnswerChars !== undefined && answer.length < check.minAnswerChars) reasons.push(`answer shorter than ${check.minAnswerChars} chars`);
  if (check.maxAnswerChars !== undefined && answer.length > check.maxAnswerChars) reasons.push(`answer longer than ${check.maxAnswerChars} chars`);
  return { pass: reasons.length === 0, reasons };
}

// ── configurations ───────────────────────────────────────────────────────────

export interface EvalConfig {
  name: string;
  description: string;
  /** Env applied for the whole configuration (LLM_MODEL_LEAD, LLM_EFFORT_LEAD, CHAT_CACHE_LAYOUT …). */
  env: Record<string, string | undefined>;
  /**
   * Oracle routing: per-task env by the fixture's complexity label. The
   * Phase 17B classifier is not built; this measures routing's upside with a
   * perfect classifier, and says so in the results.
   */
  routing?: Partial<Record<Complexity, Record<string, string | undefined>>>;
}

export const CONFIGS: Readonly<Record<string, EvalConfig>> = {
  baseline: {
    name: "baseline",
    description: "Phase 17 A defaults: lead on claude-opus-5-5 at effort medium, v2 cache layout",
    env: { LLM_MODEL_LEAD: undefined, LLM_EFFORT_LEAD: undefined, CHAT_CACHE_LAYOUT: undefined },
  },
  routing: {
    name: "routing",
    description: "Oracle routing (fixture complexity labels — the 17B classifier is not built): simple → Sonnet 5.5 low, tools → Sonnet 5.5 medium, planning → Opus 5.5 medium",
    env: { CHAT_CACHE_LAYOUT: undefined },
    routing: {
      simple: { LLM_MODEL_LEAD: "claude-sonnet-5-5", LLM_EFFORT_LEAD: "low" },
      tools: { LLM_MODEL_LEAD: "claude-sonnet-5-5", LLM_EFFORT_LEAD: "medium" },
      planning: { LLM_MODEL_LEAD: undefined, LLM_EFFORT_LEAD: undefined },
    },
  },
  "effort-low": {
    name: "effort-low",
    description: "Lead on claude-opus-5-5 at effort low",
    env: { LLM_MODEL_LEAD: undefined, LLM_EFFORT_LEAD: "low", CHAT_CACHE_LAYOUT: undefined },
  },
  "effort-high": {
    name: "effort-high",
    description: "Lead on claude-opus-5-5 at effort high",
    env: { LLM_MODEL_LEAD: undefined, LLM_EFFORT_LEAD: "high", CHAT_CACHE_LAYOUT: undefined },
  },
  "layout-legacy": {
    name: "layout-legacy",
    description: "The pre-Phase-17 prompt layout (dynamic context inside the cached system prompt, 5-minute TTL) — the cache layout's control arm",
    env: { LLM_MODEL_LEAD: undefined, LLM_EFFORT_LEAD: undefined, CHAT_CACHE_LAYOUT: "legacy" },
  },
};

/** Owner rule (2026-10-06): baseline first, then routing; effort levels only while budget remains. */
export const DEFAULT_SWEEP: readonly string[] = ["baseline", "routing", "effort-low", "effort-high"];

/** Env for one task under a config. PURE. */
export function envFor(config: EvalConfig, task: Pick<EvalTask, "complexity">): Record<string, string | undefined> {
  return { ...config.env, ...(config.routing?.[task.complexity] ?? {}) };
}

// ── the $ budget (owner: HARD CAP $30 for the whole sweep) ───────────────────

export const DEFAULT_MAX_USD = 30;
/** Assumed cost of a task before any task was measured (a planning turn on Opus with a cold cache is ~$0.10–0.25). */
export const DEFAULT_TASK_ESTIMATE_USD = 0.3;

export interface BudgetState {
  maxUsd: number;
  /** Measured spend so far (from the usage events), USD. */
  spentUsd: number;
  /** Most expensive task measured so far, USD. */
  maxTaskUsd: number;
}

/**
 * May the next task start? It is refused when the measured spend plus the
 * next task's expected cost (the most expensive task seen so far, or the
 * fixture's estimate before any was measured) would pass the cap. PURE.
 */
export function canStartTask(b: BudgetState, task: Pick<EvalTask, "estimateUsd">): { ok: boolean; projectedUsd: number } {
  const next = b.maxTaskUsd > 0 ? b.maxTaskUsd : (task.estimateUsd ?? DEFAULT_TASK_ESTIMATE_USD);
  const projectedUsd = b.spentUsd + next;
  return { ok: projectedUsd <= b.maxUsd, projectedUsd };
}

// ── results ──────────────────────────────────────────────────────────────────

export interface TaskResult {
  config: string;
  taskId: string;
  category: string;
  pass: boolean;
  reasons: string[];
  judge: "pass" | "fail" | "skipped (dry run)" | "skipped (no rubric)" | "error";
  judgeReason?: string;
  costUsd: number;
  calls: number;
  cacheReadShare: number | null;
  ttftMs: number | null;
  latencyMs: number;
  answer: string;
  tools: string[];
}

export interface RunSummary {
  config: string;
  tasks: number;
  passed: number;
  passRate: number;
  costUsd: number;
  costPerTaskUsd: number;
  ttftP50Ms: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  cacheReadShare: number | null;
}

export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(v[lo] + (v[hi] - v[lo]) * (idx - lo));
}

export function summarize(config: string, results: TaskResult[]): RunSummary {
  const rs = results.filter((r) => r.config === config);
  const passed = rs.filter((r) => r.pass && r.judge !== "fail").length;
  const cost = rs.reduce((n, r) => n + r.costUsd, 0);
  const shares = rs.map((r) => r.cacheReadShare).filter((x): x is number => x !== null);
  return {
    config,
    tasks: rs.length,
    passed,
    passRate: rs.length ? passed / rs.length : 0,
    costUsd: cost,
    costPerTaskUsd: rs.length ? cost / rs.length : 0,
    ttftP50Ms: percentile(rs.map((r) => r.ttftMs ?? NaN), 0.5),
    latencyP50Ms: percentile(rs.map((r) => r.latencyMs), 0.5),
    latencyP95Ms: percentile(rs.map((r) => r.latencyMs), 0.95),
    cacheReadShare: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null,
  };
}

const usd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;
const msf = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

/** The comparison table (Markdown). PURE. */
export function resultsMarkdown(input: {
  title: string;
  dryRun: boolean;
  maxUsd: number;
  spentUsd: number;
  stopped: string | null;
  configs: string[];
  results: TaskResult[];
}): string {
  const lines: string[] = [
    `# ${input.title}`,
    "",
    input.dryRun ? "**DRY RUN — FAKE model (MOCK): these numbers prove the harness, not the model.**" : "Real model calls (paid).",
    "",
    `Spend ${usd(input.spentUsd)} of the ${usd(input.maxUsd)} cap${input.stopped ? ` — STOPPED: ${input.stopped}` : ""}.`,
    "",
    "| Config | Tasks | Pass rate | Cost | Cost / task | First token p50 | Latency p50 | Latency p95 | Cache-read share |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of input.configs) {
    const s = summarize(c, input.results);
    if (s.tasks === 0) {
      lines.push(`| ${c} | 0 | — | — | — | — | — | — | — |`);
      continue;
    }
    lines.push(
      `| ${c} | ${s.tasks} | ${Math.round(s.passRate * 100)}% (${s.passed}) | ${usd(s.costUsd)} | ${usd(s.costPerTaskUsd)} | ${msf(s.ttftP50Ms)} | ${msf(s.latencyP50Ms)} | ${msf(s.latencyP95Ms)} | ${s.cacheReadShare === null ? "—" : `${Math.round(s.cacheReadShare * 100)}%`} |`,
    );
  }
  lines.push("", "## Per task", "", `| Task | ${input.configs.join(" | ")} |`, `|---|${input.configs.map(() => "---").join("|")}|`);
  const ids = [...new Set(input.results.map((r) => r.taskId))];
  for (const id of ids) {
    const cells = input.configs.map((c) => {
      const r = input.results.find((x) => x.config === c && x.taskId === id);
      if (!r) return "—";
      const ok = r.pass && r.judge !== "fail";
      return `${ok ? "pass" : "FAIL"} ${usd(r.costUsd)}${ok ? "" : ` (${[...r.reasons, r.judge === "fail" ? `judge: ${r.judgeReason ?? "fail"}` : ""].filter(Boolean).join("; ").slice(0, 80)})`}`;
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n") + "\n";
}
