// ShapesOS — Phase 17 (latency): the latency-budget battery.
//
// Measures, against a seeded database and the SCRIPTED FAKE model
// (lib/chat/__tests__/fake-responses.ts — MOCK, answers at once, so what we
// measure is OUR OWN server overhead, never the model's):
//
//   chat.firstByte    POST /api/agents/chat → first SSE byte (the server's
//                     "first visible feedback": auth, thread checks, the run
//                     row, the stream opened)
//   chat.firstToken   → the first TEXT_MESSAGE_CONTENT frame ("server
//                     overhead to first token": everything before and around
//                     the model call — prompt assembly, recall, connectors,
//                     the stream path from the loop to the socket)
//   chat.total        → RUN_FINISHED
//   command           POST /api/agents/chat with a slash command (/keywords):
//                     a deterministic, no-model fast path — and the fake
//                     model's request counter proves no model was called
//   api.*             GET of the hot non-model routes: the overview feed
//                     (/api/agents/activity), the Needs-you inbox, record
//                     search, the twin state and its change signal
//   page.*            GET of the runs list and the ops overview pages (HTML)
//
// Each is sampled LATENCY_RUNS times (default 20) after a warm-up, and the
// p50 / p95 are printed and checked against the budgets below. Budgets are
// multiplied by LATENCY_SLACK (default 3: CI runners and `next dev` are
// slower than a warm production box); LATENCY_STRICT=1 sets the slack to 1.
// LATENCY_ASSERT=0 only reports (a baseline run).
//
// Runs the app itself unless LATENCY_BASE_URL points at one: `next start`
// when .next/BUILD_ID exists (CI, after the production build), else
// `next dev`. Needs DATABASE_URL (schema owner — seeding) and, optionally,
// LATENCY_APP_DATABASE_URL (the least-privilege app role the server runs
// as; default DATABASE_URL). Every env var is documented in .env.example.
//
// Run: DATABASE_URL=… npx tsx scripts/verify/latency.mts
// Exit: 0 budgets met (or LATENCY_ASSERT=0), 1 a budget missed, 2 setup failed.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeModel } from "../../lib/chat/__tests__/fake-responses";
import { readSseEvents } from "../../components/chat/agui-stream";
import { CookieJar, signIn, waitForHttp } from "../smoke/multi-instance-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNS = Math.max(3, Number(process.env.LATENCY_RUNS ?? 20));
const WARMUP = 3;
const SLACK = process.env.LATENCY_STRICT === "1" ? 1 : Math.max(1, Number(process.env.LATENCY_SLACK ?? 3));
const ASSERT = process.env.LATENCY_ASSERT !== "0";

/** Base budgets (ms) — the Phase 17 targets. Multiplied by LATENCY_SLACK. */
const BUDGETS = {
  "chat.firstByte": { p50: 300 },
  "chat.firstToken": { p50: 1000, p95: 2000 },
  command: { p50: 300, p95: 600 },
  api: { p95: 300 },
  page: { p95: 1000 },
} as const;

interface Sample {
  name: string;
  ms: number[];
  /** Extra facts to print (e.g. model calls). */
  note?: string;
  fail?: string[];
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}

const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : "n/a");

let server: ChildProcess | null = null;
function killServer(sig: NodeJS.Signals = "SIGTERM") {
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    try {
      process.kill(-server.pid, sig);
    } catch {
      // gone
    }
  }
}
process.on("exit", () => killServer("SIGKILL"));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killServer("SIGTERM");
    setTimeout(() => process.exit(sig === "SIGINT" ? 130 : 143), 1500).unref();
  });
}

function fail(msg: string): never {
  console.error(`[latency] ${msg}`);
  process.exit(2);
}

async function main() {
  const email = (process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com").toLowerCase();
  const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password";
  const ownerUrl = process.env.DATABASE_URL?.trim();
  const external = process.env.LATENCY_BASE_URL?.trim();

  // 1. The fake model (this process): the app is pointed at it through env.
  const model = await startFakeModel({ agentWorker: "off" });
  model.script = () => ({ text: "Here is a short answer from the fake model." });

  // 2. Seed the E2E world (owner connection) — the same seed the smoke uses.
  if (!ownerUrl) fail("DATABASE_URL (schema owner, for seeding) is required.");
  const seed = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/e2e/seed.mts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: ownerUrl, E2E_ADMIN_EMAIL: email },
    encoding: "utf8",
  });
  if (seed.status !== 0) fail(`seed failed:\n${seed.stdout}\n${seed.stderr}`);
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "e2e", ".e2e-ids.json"), "utf8")) as { workspaceId: string; projectId: string };

  // 3. The app (unless one is given).
  let base = external ?? "";
  if (!external) {
    const port = Number(process.env.LATENCY_PORT ?? 3117);
    const appUrl = process.env.LATENCY_APP_DATABASE_URL?.trim() || ownerUrl;
    const built = fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")) && process.env.LATENCY_DEV !== "1";
    const secret = randomBytes(32).toString("hex");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: appUrl,
      ...(built ? { NODE_ENV: "production" } : {}),
      AUTH_SECRET: secret,
      NEXTAUTH_SECRET: secret,
      AUTH_TRUST_HOST: "true",
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: password,
      MARKETR_CREDENTIALS_KEY: process.env.MARKETR_CREDENTIALS_KEY ?? randomBytes(32).toString("hex"),
      // The fake model (set on this process by startFakeModel).
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      AGENT_WORKER: "off",
      RATE_LIMIT_STORE: "memory",
      NEXT_TELEMETRY_DISABLED: "1",
      PORT: String(port),
    };
    delete env.NEXTAUTH_URL;
    delete env.AUTH_URL;
    delete env.LLM_API_KEY;
    delete env.LLM_MODEL;
    delete env.ANTHROPIC_API_KEY;
    const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
    const logPath = path.join(process.env.LATENCY_LOG_DIR ?? ROOT, `.latency-server.log`);
    const log = fs.openSync(logPath, "w");
    server = spawn(process.execPath, [nextBin, built ? "start" : "dev", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    base = `http://127.0.0.1:${port}`;
    console.log(`[latency] starting next ${built ? "start" : "dev"} on ${base} (log: ${logPath})`);
    if (!(await waitForHttp(`${base}/api/health/live`, 180_000))) fail(`the app did not come up — see ${logPath}`);
  }

  // 4. Sign in (Auth.js credentials → JWT cookie).
  const jar = new CookieJar();
  const signed = await signIn(base, jar, email, password);
  if (!signed.ok) fail(`sign-in failed: ${signed.detail}`);
  const headers = () => ({ cookie: jar.header(), origin: base });
  const get = (p: string) => fetch(`${base}${p}`, { headers: { ...headers(), accept: "application/json, text/html" }, cache: "no-store" });
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(body) });

  // 5. Fixtures: a chat thread, and a sample twin site (admin+; optional).
  const threadRes = await post("/api/chat/threads", { projectId: ids.projectId });
  if (threadRes.status !== 201) fail(`could not create a chat thread: ${threadRes.status} ${await threadRes.text()}`);
  const threadId = ((await threadRes.json()) as { thread: { id: string } }).thread.id;
  let siteId: string | null = null;
  const twin = await post("/api/twin/sites/sample", { kind: "warehouse" });
  if (twin.ok) {
    // createSampleSite → { siteId, kind, created, objectCount }
    const body = (await twin.json()) as { siteId?: string };
    siteId = body.siteId ?? null;
    if (!siteId) console.log(`[latency] the sample site answered without a siteId: ${JSON.stringify(body).slice(0, 200)}`);
  } else {
    console.log(`[latency] no twin sample site (${twin.status}): the twin routes are skipped`);
  }

  const samples: Sample[] = [];

  // 6. Chat: time to first SSE byte, first text token, and the end.
  const firstByte: number[] = [];
  const firstToken: number[] = [];
  const total: number[] = [];
  const chatFails: string[] = [];
  async function chatTurn(content: string, into: { firstByte?: number[]; firstToken?: number[]; total?: number[] } = {}) {
    const t0 = performance.now();
    const res = await fetch(`${base}/api/agents/chat`, {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ threadId, content }),
    });
    if (!res.ok || !res.body) {
      chatFails.push(`POST /api/agents/chat → ${res.status} ${await res.text().catch(() => "")}`);
      return { finished: false };
    }
    const reader = res.body.getReader();
    let tFirst = 0;
    // Tee: the first chunk time, then the AG-UI frames.
    const tapped = new ReadableStream<Uint8Array>({
      async pull(c) {
        const { value, done } = await reader.read();
        if (done) return c.close();
        if (!tFirst) tFirst = performance.now();
        c.enqueue(value);
      },
      cancel: () => reader.cancel(),
    });
    let tToken = 0;
    let finished = false;
    for await (const block of readSseEvents(tapped)) {
      if (block.event && block.event !== "message") continue;
      let frame: { type?: string; delta?: string };
      try {
        frame = JSON.parse(block.data);
      } catch {
        continue;
      }
      if (!tToken && frame.type === "TEXT_MESSAGE_CONTENT" && frame.delta) tToken = performance.now();
      if (frame.type === "RUN_FINISHED" || frame.type === "RUN_ERROR") {
        finished = frame.type === "RUN_FINISHED";
        break;
      }
    }
    const tEnd = performance.now();
    into.firstByte?.push(tFirst - t0);
    if (tToken) into.firstToken?.push(tToken - t0);
    into.total?.push(tEnd - t0);
    return { finished };
  }
  for (let i = 0; i < WARMUP; i++) await chatTurn(`warm-up ${i}`);
  for (let i = 0; i < RUNS; i++) {
    const r = await chatTurn(`Question ${i}: what should I look at next?`, { firstByte, firstToken, total });
    if (!r.finished) chatFails.push(`turn ${i} did not finish with RUN_FINISHED`);
  }
  samples.push({ name: "chat.firstByte", ms: firstByte, fail: chatFails });
  samples.push({ name: "chat.firstToken", ms: firstToken, note: `${firstToken.length}/${RUNS} turns streamed text` });
  samples.push({ name: "chat.total", ms: total });

  // 7. A slash command: deterministic, must not call the model.
  const cmd: number[] = [];
  const before = model.requests.length;
  const cmdFails: string[] = [];
  for (let i = 0; i < WARMUP; i++) await chatTurn("/keywords");
  const afterWarm = model.requests.length;
  for (let i = 0; i < RUNS; i++) {
    const r = await chatTurn("/keywords", { total: cmd });
    if (!r.finished) cmdFails.push(`command ${i} did not finish`);
  }
  const modelCalls = model.requests.length - afterWarm;
  if (modelCalls > 0) cmdFails.push(`the slash command called the model ${modelCalls} times (expected 0)`);
  samples.push({ name: "command", ms: cmd, note: `model calls: ${modelCalls} (warm-up: ${afterWarm - before})`, fail: cmdFails });

  // 8. Hot non-model routes.
  const routes: Array<{ name: string; path: string; kind: "api" | "page"; expect?: number }> = [
    { name: "api.activity", path: "/api/agents/activity", kind: "api" },
    { name: "api.approvalsInbox", path: "/api/approvals/inbox", kind: "api" },
    { name: "api.searchRecords", path: "/api/search/records?q=e2e", kind: "api" },
    ...(siteId
      ? [
          { name: "api.twinState", path: `/api/twin/sites/${siteId}/state`, kind: "api" as const },
          { name: "api.twinSignal", path: `/api/twin/sites/${siteId}/state?signal=1`, kind: "api" as const },
        ]
      : []),
    { name: "page.runs", path: "/dashboard/runs", kind: "page" },
    { name: "page.ops", path: "/dashboard/ops", kind: "page" },
  ];
  for (const r of routes) {
    const ms: number[] = [];
    const fails: string[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const t0 = performance.now();
      const res = await get(r.path);
      await res.arrayBuffer();
      const dt = performance.now() - t0;
      if (!res.ok) fails.push(`GET ${r.path} → ${res.status}`);
      if (i >= WARMUP) ms.push(dt);
    }
    samples.push({ name: r.name, ms, fail: [...new Set(fails)] });
  }

  // 9. Report + budgets.
  const rows: string[] = [];
  const failures: string[] = [];
  const check = (name: string, p: "p50" | "p95", value: number, budget: number) => {
    const limit = budget * SLACK;
    if (!Number.isFinite(value) || value > limit) failures.push(`${name} ${p} ${fmt(value)} > ${fmt(limit)} (budget ${fmt(budget)} × ${SLACK})`);
  };
  for (const s of samples) {
    const p50 = pct(s.ms, 50);
    const p95 = pct(s.ms, 95);
    rows.push(`${s.name.padEnd(20)} n=${String(s.ms.length).padStart(2)}  p50 ${fmt(p50).padStart(8)}  p95 ${fmt(p95).padStart(8)}${s.note ? `  ${s.note}` : ""}`);
    for (const f of s.fail ?? []) failures.push(`${s.name}: ${f}`);
    const b =
      s.name in BUDGETS
        ? BUDGETS[s.name as keyof typeof BUDGETS]
        : s.name.startsWith("api.")
          ? BUDGETS.api
          : s.name.startsWith("page.")
            ? BUDGETS.page
            : null;
    if (!b) continue;
    if ("p50" in b) check(s.name, "p50", p50, b.p50);
    if ("p95" in b) check(s.name, "p95", p95, b.p95);
  }
  console.log(`\n[latency] ${external ? external : fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")) && process.env.LATENCY_DEV !== "1" ? "next start" : "next dev"} · fake model · ${RUNS} samples each · slack ×${SLACK}`);
  console.log(rows.join("\n"));
  if (failures.length) {
    console.log(`\n[latency] ${ASSERT ? "budget misses" : "misses (not asserted: LATENCY_ASSERT=0)"}:\n  - ${failures.join("\n  - ")}`);
  } else {
    console.log("\n[latency] every budget met");
  }
  await model.close();
  killServer("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(ASSERT && failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error("[latency] crashed:", err);
  killServer("SIGTERM");
  setTimeout(() => process.exit(2), 1000);
});
