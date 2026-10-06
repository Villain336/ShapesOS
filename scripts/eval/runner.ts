// ShapesOS — Phase 17 evaluation harness: the runner (the CLI is scripts/eval/run.mts).
//
// Runs the frozen task set (scripts/eval/tasks.json) through the REAL chat
// loop (lib/chat/agent.ts runTrackedAgentTurn → lib/agents/loop.ts → the
// router's providers) against a freshly seeded workspace per configuration,
// and writes a comparison table: pass rate, cost per task (summed from the
// usage events the calls recorded — the ledger, not an estimate), time to
// first token and total latency.
//
//   Dry run (CI, no key, no money — the FAKE model server, MOCK):
//     DATABASE_URL=… npx tsx scripts/eval/run.mts --dry-run
//   Real run (paid — read scripts/eval/README.md first):
//     ANTHROPIC_API_KEY=… DATABASE_URL=… npx tsx scripts/eval/run.mts --max-usd 30
//
// Options:
//   --dry-run             the fake Anthropic server (no key, no cost)
//   --configs a,b         configurations, in order (default: baseline, routing,
//                         effort-low, effort-high — owner rule: baseline first,
//                         then routing; effort levels only while budget remains)
//   --max-usd N           HARD CAP on the sweep's measured spend (default 30):
//                         a task that could take the spend past it is never
//                         started; the partial table is written and the run stops
//   --tasks id,id         a subset of the task set
//   --out DIR             where results.json / results.md go (default .data/eval/<time>)
//   --no-judge            skip the rubric judge on real runs
//
// The model key is read ONLY from the ANTHROPIC_API_KEY environment variable —
// never from a flag or a file. OpenAI keys are removed for the run so no
// failover can bill a second vendor.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import {
  CONFIGS,
  DEFAULT_MAX_USD,
  DEFAULT_SWEEP,
  canStartTask,
  checkTask,
  envFor,
  resultsMarkdown,
  summarize,
  type BudgetState,
  type EvalConfig,
  type EvalTask,
  type TaskResult,
} from "./lib";
import { seedEvalWorkspace, type EvalWorkspace } from "./seed";
import taskSet from "./tasks.json";

export interface RunOptions {
  dryRun: boolean;
  configs: string[];
  maxUsd: number;
  tasks?: string[];
  outDir: string;
  judge: boolean;
  /** Test seam: the fake server's batch/usage knobs (dry run only). */
  fakeUsage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  log?: (msg: string) => void;
}

export interface RunOutcome {
  results: TaskResult[];
  spentUsd: number;
  stopped: string | null;
  markdownPath: string;
  jsonPath: string;
}

export function parseArgs(argv: string[]): RunOptions {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  for (const a of argv) {
    if (/^--(api-)?key\b|^--anthropic/i.test(a)) throw new Error(`"${a}": the key is read only from the ANTHROPIC_API_KEY environment variable.`);
  }
  const maxUsd = Number(get("--max-usd") ?? DEFAULT_MAX_USD);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("--max-usd must be a positive number");
  const configs = (get("--configs") ?? DEFAULT_SWEEP.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const c of configs) if (!CONFIGS[c]) throw new Error(`unknown config "${c}" (known: ${Object.keys(CONFIGS).join(", ")})`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    dryRun: argv.includes("--dry-run"),
    configs,
    maxUsd,
    tasks: get("--tasks")?.split(",").map((s) => s.trim()).filter(Boolean),
    outDir: get("--out") ?? join(".data", "eval", stamp),
    judge: !argv.includes("--no-judge"),
  };
}

export function loadTasks(filter?: string[]): EvalTask[] {
  const raw = taskSet as unknown as { tasks: EvalTask[] };
  const tasks = filter?.length ? raw.tasks.filter((t) => filter.includes(t.id)) : raw.tasks;
  if (filter?.length && tasks.length !== filter.length) throw new Error(`unknown task id in --tasks (${filter.join(",")})`);
  return tasks;
}

const OPENAI_KEYS = ["OPENAI_API_KEY", "LLM_API_KEY", "OPENAI_BASE_URL", "LLM_BASE_URL"];

function applyEnv(env: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

interface LedgerSlice {
  costUsd: number;
  calls: number;
  ttftMs: number | null;
  cacheReadShare: number | null;
}

/** The newest llm_tokens row's time (epoch when none). */
async function lastRecordedAt(workspaceId: string): Promise<Date> {
  const r = await prisma.usageEvent.findFirst({ where: { workspaceId, action: "llm_tokens" }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } });
  return r?.occurredAt ?? new Date(0);
}

/** What the usage events recorded for a workspace after a moment (the ledger is the source of truth). */
async function ledgerSince(workspaceId: string, since: Date): Promise<LedgerSlice> {
  const rows = await prisma.usageEvent.findMany({
    where: { workspaceId, action: "llm_tokens", occurredAt: { gt: since } },
    orderBy: { occurredAt: "asc" },
    select: { llmCostMicroUsd: true, llmTtftMs: true, llmInputTokens: true, llmCacheReadTokens: true, llmCacheWriteTokens: true },
  });
  let micro = 0;
  let input = 0;
  let read = 0;
  for (const r of rows) {
    micro += Number(r.llmCostMicroUsd ?? 0);
    input += (r.llmInputTokens ?? 0) + (r.llmCacheReadTokens ?? 0) + (r.llmCacheWriteTokens ?? 0);
    read += r.llmCacheReadTokens ?? 0;
  }
  const firstTtft = rows.find((r) => r.llmTtftMs !== null)?.llmTtftMs ?? null;
  return { costUsd: micro / 1_000_000, calls: rows.length, ttftMs: firstTtft, cacheReadShare: input > 0 ? read / input : null };
}

async function waitForRun(workspaceId: string, runId: string, timeoutMs: number): Promise<void> {
  const { getAgentRun } = await import("@/lib/agents/runs/service");
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await getAgentRun(workspaceId, runId).catch(() => null);
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return;
    if (Date.now() > until) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function judge(ws: EvalWorkspace, task: EvalTask, answer: string): Promise<{ verdict: "pass" | "fail" | "error"; reason: string }> {
  try {
    const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
    const llm = await getLlmProviderForWorkspace("copy", { workspaceId: ws.workspaceId, projectId: ws.projectId });
    const text = await llm.generate(
      [
        "You grade one answer from a business assistant against a rubric. Reply with ONLY JSON: {\"pass\": true|false, \"reason\": \"one short sentence\"}.",
        `Request: ${task.prompt}`,
        `Rubric: ${task.rubric}`,
        `Answer:\n"""${answer.slice(0, 6000)}"""`,
      ].join("\n\n"),
      { maxTokens: 200 },
    );
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { pass?: unknown; reason?: unknown }) : null;
    if (!parsed || typeof parsed.pass !== "boolean") return { verdict: "error", reason: "the judge's reply was not JSON" };
    return { verdict: parsed.pass ? "pass" : "fail", reason: String(parsed.reason ?? "").slice(0, 200) };
  } catch (err) {
    return { verdict: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function runEval(opts: RunOptions): Promise<RunOutcome> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required (the harness seeds its own workspaces).");
  const tasks = loadTasks(opts.tasks);
  mkdirSync(opts.outDir, { recursive: true });
  const jsonPath = join(opts.outDir, "results.json");
  const markdownPath = join(opts.outDir, "results.md");

  // The model: a FAKE server (dry run) or the real API with the env key only.
  let fake: import("@/lib/llm/__tests__/fake-anthropic").FakeAnthropic | null = null;
  let current: { task: EvalTask; step: number } | null = null;
  const restoreBase = applyEnv(Object.fromEntries(OPENAI_KEYS.map((k) => [k, undefined])));
  if (opts.dryRun) {
    const { startFakeAnthropic } = await import("@/lib/llm/__tests__/fake-anthropic");
    fake = await startFakeAnthropic({ agentWorker: "external" });
    fake.script = (body) => {
      if (!body.stream) return { text: "- a fact the conversation established", usage: { input_tokens: 400, output_tokens: 40 } };
      if (!current) return { text: "ok" };
      // Sub-agents of the delegation task: a deliverable.
      const sys = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => String(b.text ?? "")).join("\n");
      if (/sub-agent of ShapesOS/.test(sys)) {
        return { text: 'Done.\n\n```deliverable\n{"summary":"done","outputs":"beanhub.example: price; brewcraft.example: craft","artifacts":[],"openIssues":[],"confidence":"high"}\n```', usage: opts.fakeUsage ?? { input_tokens: 1500, output_tokens: 200, cache_read_input_tokens: 4000 } };
      }
      const steps = current.task.dryRun;
      // Past the script: a closing answer (never the last tool call again — that would loop).
      const s = current.step < steps.length ? steps[current.step] : { text: [...steps].reverse().find((x) => x.text)?.text ?? "Done." };
      current.step++;
      const usage = opts.fakeUsage ?? { input_tokens: 1800, output_tokens: 250, cache_read_input_tokens: current.step > 1 ? 6000 : 0, cache_creation_input_tokens: current.step > 1 ? 0 : 6000 };
      return { ...(s.text ? { text: s.text } : {}), ...(s.calls ? { calls: s.calls.map((c) => ({ name: c.name, input: c.input ?? {} })) } : {}), usage };
    };
  } else {
    if (!(process.env.ANTHROPIC_API_KEY ?? "").trim()) {
      restoreBase();
      throw new Error("A real run needs ANTHROPIC_API_KEY in the environment (it is never read from a flag or a file). Use --dry-run to exercise the harness for free.");
    }
    process.env.AGENT_WORKER = "external";
  }

  // Delegated sub-agents run on the queue: a worker for those kinds only.
  const { AgentWorker } = await import("@/lib/agents/queue/worker");
  const { DELEGATION_JOB_KINDS } = await import("@/lib/agents/delegation/local-worker");
  const worker = new AgentWorker({ kinds: [...DELEGATION_JOB_KINDS], log: { info: () => undefined, warn: () => undefined, error: (m: string) => log(`worker: ${m}`) } as never });
  worker.start();

  const { runTrackedAgentTurn } = await import("@/lib/chat/agent");
  const { settleThreadFacts } = await import("@/lib/chat/facts");
  const results: TaskResult[] = [];
  const budget: BudgetState = { maxUsd: opts.maxUsd, spentUsd: 0, maxTaskUsd: 0 };
  let stopped: string | null = null;
  const write = () => {
    writeFileSync(jsonPath, JSON.stringify({ dryRun: opts.dryRun, maxUsd: opts.maxUsd, spentUsd: budget.spentUsd, stopped, configs: opts.configs, summaries: opts.configs.map((c) => summarize(c, results)), results }, null, 2));
    writeFileSync(markdownPath, resultsMarkdown({ title: "ShapesOS Phase 17 evaluation", dryRun: opts.dryRun, maxUsd: opts.maxUsd, spentUsd: budget.spentUsd, stopped, configs: opts.configs, results }));
  };

  try {
    for (const name of opts.configs) {
      if (stopped) break;
      const config: EvalConfig = CONFIGS[name];
      const ws = await seedEvalWorkspace(`${Date.now().toString(36)}-${name}`);
      log(`\n== ${name}: ${config.description} (workspace ${ws.workspaceId})`);
      for (const task of tasks) {
        const gate = canStartTask(budget, task);
        if (!gate.ok) {
          stopped = `the next task (${name}/${task.id}) could take the spend to $${gate.projectedUsd.toFixed(2)}, past the $${opts.maxUsd} cap`;
          log(`STOP: ${stopped}`);
          break;
        }
        const restore = applyEnv(envFor(config, task));
        const thread = await prisma.aiChatThread.create({ data: { projectId: ws.projectId, userId: ws.userId } });
        // The ledger's own clock: everything after the workspace's last recorded call is this task's.
        const since = await lastRecordedAt(ws.workspaceId);
        const started = Date.now();
        current = { task, step: 0 };
        let answer = "";
        let calls: Array<{ tool: string; status: string }> = [];
        let error: string | null = null;
        try {
          const out = await runTrackedAgentTurn(
            { projectId: ws.projectId, workspaceId: ws.workspaceId, userId: ws.userId, role: "owner", threadId: thread.id, userContent: task.prompt },
            { inlineBudgetMs: null },
          );
          if (out.waiting) await waitForRun(ws.workspaceId, out.runId, 10 * 60_000);
          const last = await prisma.aiChatMessage.findFirst({ where: { threadId: thread.id, role: "assistant" }, orderBy: { createdAt: "desc" } });
          answer = last?.content ?? out.assistantText;
          const rows = await prisma.aiChatMessage.findMany({ where: { threadId: thread.id, role: "assistant" }, select: { toolCalls: true } });
          calls = rows.flatMap((r) => (Array.isArray(r.toolCalls) ? (r.toolCalls as Array<{ tool: string; status: string }>) : []));
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        } finally {
          current = null;
          restore();
        }
        const latencyMs = Date.now() - started;
        await settleThreadFacts();
        const check = error ? { pass: false, reasons: [`turn threw: ${error}`] } : checkTask(task.check, { answer, calls });
        let verdict: TaskResult["judge"] = task.rubric ? (opts.dryRun ? "skipped (dry run)" : "skipped (no rubric)") : "skipped (no rubric)";
        let judgeReason: string | undefined;
        if (task.rubric && !opts.dryRun && opts.judge && check.pass) {
          const j = await judge(ws, task, answer);
          verdict = j.verdict;
          judgeReason = j.reason;
        }
        const ledger = await ledgerSince(ws.workspaceId, since);
        budget.spentUsd += ledger.costUsd;
        budget.maxTaskUsd = Math.max(budget.maxTaskUsd, ledger.costUsd);
        results.push({
          config: name,
          taskId: task.id,
          category: task.category,
          pass: check.pass,
          reasons: check.reasons,
          judge: verdict,
          judgeReason,
          costUsd: ledger.costUsd,
          calls: ledger.calls,
          cacheReadShare: ledger.cacheReadShare,
          ttftMs: ledger.ttftMs,
          latencyMs,
          answer: answer.slice(0, 2000),
          tools: calls.map((c) => `${c.tool}:${c.status}`),
        });
        log(`${check.pass && verdict !== "fail" ? "pass" : "FAIL"} ${task.id} $${ledger.costUsd.toFixed(4)} ${latencyMs} ms${check.reasons.length ? ` — ${check.reasons.join("; ")}` : ""}`);
        write();
      }
    }
  } finally {
    await worker.stop().catch(() => undefined);
    await fake?.close();
    restoreBase();
    write();
  }
  log(`\nwrote ${markdownPath} (spend $${budget.spentUsd.toFixed(4)} of $${opts.maxUsd}${stopped ? `; stopped: ${stopped}` : ""})`);
  return { results, spentUsd: budget.spentUsd, stopped, markdownPath, jsonPath };
}

