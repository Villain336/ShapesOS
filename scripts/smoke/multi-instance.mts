// ShapesOS — Deploy PR (WS=state): two-instance smoke.
//
// Proves the app runs as 2 web replicas + 1 worker with NO shared disk:
//
//   1. sign in on A; B accepts the same session (shared AUTH_SECRET, JWT);
//   2. a workspace file uploaded through A downloads through B, byte for byte;
//   3. a site working copy written through A (incl. a path with a space) is
//      read through B, and its objects are in the shared bucket;
//   4. a chat stream open on A gets `event: reconnect` when A is SIGTERMed,
//      resumes on B with Last-Event-ID, every text delta exactly once, in
//      order, and A exits within the grace period;
//   5. the agent worker exits cleanly on SIGTERM (the shared shutdown path).
//
// The shared object store is the in-process S3-compatible FAKE
// (lib/filesystem/fake-s3.ts — labelled fake; it verifies every SigV4
// signature) so the smoke needs no cloud account. Point MARKETR_S3_* at a real
// bucket instead by setting SMOKE_REAL_S3=1 (the instances then inherit your
// MARKETR_S3_* env and check 3 skips the bucket-key assertion).
//
// Requires a production build (`npm run build` → .next/BUILD_ID; uses
// .next/standalone/server.js when present, else `next start`), a migrated
// Postgres, and:
//   DATABASE_URL            schema owner (seeding: scripts/e2e/seed.mts)
//   SMOKE_APP_DATABASE_URL  least-privilege app role the servers run as
//                           (scripts/db/create-app-role.sql; default DATABASE_URL)
// Optional: SMOKE_PORT_A (3101), SMOKE_PORT_B (3102), SMOKE_GRACE_MS (20000),
// SMOKE_SKIP_WORKER=1, E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
//
// Run: npx tsx scripts/smoke/multi-instance.mts
// Exit: 0 all checks pass, 1 a check failed, 2 prerequisites missing.
// Every child runs in its own process group and is killed by group at the end.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CookieJar,
  sessionOn,
  signIn,
  siteOnAReadOnB,
  sseDrainResume,
  uploadOnAFetchOnB,
  waitForHttp,
  type ChatTimeline,
  type Check,
  type Instance,
} from "./multi-instance-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let LOG_DIR = "";
const children: ChildProcess[] = [];

function fail(msg: string, code = 2): never {
  console.error(`[smoke] ${msg}`);
  process.exit(code);
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      // already gone
    }
  }
}

function startProcess(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): { child: ChildProcess; exited: Promise<number | null> } {
  const log = fs.openSync(path.join(LOG_DIR, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd: ROOT, env, detached: true, stdio: ["ignore", log, log] });
  children.push(child);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited };
}

function serverCommand(port: number): { cmd: string; args: string[]; envExtra: NodeJS.ProcessEnv } {
  const standalone = path.join(ROOT, ".next", "standalone", "server.js");
  if (fs.existsSync(standalone)) {
    return { cmd: process.execPath, args: [standalone], envExtra: { PORT: String(port), HOSTNAME: "127.0.0.1" } };
  }
  return { cmd: process.execPath, args: [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], envExtra: {} };
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    fail("no production build (.next/BUILD_ID). Run `npm run build` first — this smoke runs the built app, never `next dev`.");
  }
  const ownerUrl = process.env.DATABASE_URL?.trim();
  if (!ownerUrl) fail("DATABASE_URL (schema owner, for seeding) is required.");
  const appUrl = process.env.SMOKE_APP_DATABASE_URL?.trim() || ownerUrl;
  const email = (process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com").toLowerCase();
  const password = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-password";
  const graceMs = Number(process.env.SMOKE_GRACE_MS ?? 20_000);
  const portA = Number(process.env.SMOKE_PORT_A ?? 3101);
  const portB = Number(process.env.SMOKE_PORT_B ?? 3102);
  const credentialsKey = process.env.MARKETR_CREDENTIALS_KEY ?? randomBytes(32).toString("hex");
  LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "shapes-multi-instance-"));
  console.log(`[smoke] logs: ${LOG_DIR}`);

  // 1. Seed the E2E world (idempotent) as the schema owner.
  const seed = spawnSync(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/e2e/seed.mts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: ownerUrl, E2E_ADMIN_EMAIL: email },
    encoding: "utf8",
  });
  if (seed.status !== 0) fail(`seed failed:\n${seed.stdout}\n${seed.stderr}`);
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "e2e", ".e2e-ids.json"), "utf8")) as { workspaceId: string; projectId: string };
  const adminUserId = `admin:${email}`;

  // 2. The shared object store.
  const realS3 = process.env.SMOKE_REAL_S3 === "1";
  const { startFakeS3 } = await import("@/lib/filesystem/fake-s3");
  const fake = realS3 ? null : await startFakeS3({ bucket: "shapes-smoke", accessKeyId: "SMOKEAK", secretAccessKey: "SMOKESK" });
  const s3Env: NodeJS.ProcessEnv = fake
    ? {
        MARKETR_S3_ENDPOINT: fake.endpoint,
        MARKETR_S3_BUCKET: "shapes-smoke",
        MARKETR_S3_ACCESS_KEY: "SMOKEAK",
        MARKETR_S3_SECRET_KEY: "SMOKESK",
        MARKETR_S3_REGION: "us-east-1",
        MARKETR_S3_FORCE_PATH_STYLE: "true",
      }
    : {};

  // 3. Two replicas + one worker — same secret, same DB, same bucket, no shared disk.
  const authSecret = randomBytes(32).toString("hex");
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...s3Env,
    NODE_ENV: "production",
    DATABASE_URL: appUrl,
    MARKETR_STORAGE: "s3",
    MARKETR_CREDENTIALS_KEY: credentialsKey,
    AUTH_SECRET: authSecret,
    NEXTAUTH_SECRET: authSecret,
    AUTH_TRUST_HOST: "true",
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    AGENT_WORKER: "external",
    KEEP_ALIVE_TIMEOUT: "310000",
    SHUTDOWN_GRACE_MS: String(graceMs),
    LLM_API_KEY: process.env.LLM_API_KEY ?? "smoke-no-llm",
    LLM_MODEL: process.env.LLM_MODEL ?? "smoke-no-model",
  };
  // A fixed public URL would send B's auth redirects to A; the host comes from the request.
  delete baseEnv.NEXTAUTH_URL;
  delete baseEnv.AUTH_URL;
  // Each replica gets its own scratch dir: nothing may rely on a shared disk.
  const instance = (name: string, port: number): Instance => {
    const scratch = fs.mkdtempSync(path.join(LOG_DIR, `${name}-tmp-`));
    const { cmd, args, envExtra } = serverCommand(port);
    const { child, exited } = startProcess(name, cmd, args, { ...baseEnv, ...envExtra, TMPDIR: scratch, MARKETR_BLOB_DIR: path.join(scratch, "blobs") });
    return { name, base: `http://127.0.0.1:${port}`, signal: (sig) => killGroup(child, sig), exited };
  };
  const a = instance("A", portA);
  const b = instance("B", portB);
  for (const inst of [a, b]) {
    if (!(await waitForHttp(`${inst.base}/api/health/live`, 90_000))) fail(`${inst.name} did not come up — see ${LOG_DIR}/${inst.name}.log`, 1);
  }

  const checks: Check[] = [];
  const jar = new CookieJar();

  // 4. Session + storage.
  checks.push(await signIn(a.base, jar, email, password));
  checks.push(await sessionOn(b, jar, email));
  const bytes = new Uint8Array(randomBytes(64 * 1024));
  checks.push(...(await uploadOnAFetchOnB(a, b, jar, ids.workspaceId, bytes)));
  const objectsBefore = fake ? fake.objects.size : 0;
  checks.push(...(await siteOnAReadOnB(a, b, jar, ids.projectId)));
  if (fake) {
    const siteKeys = [...fake.objects.keys()].filter((k) => k.startsWith("blobs/sites/"));
    checks.push({ name: "the working copy lives in the shared bucket (blobs/sites/…)", ok: siteKeys.length >= 2 && fake.objects.size > objectsBefore, detail: `${siteKeys.length} site objects` });
    checks.push({ name: "every bucket request was SigV4-signed", ok: fake.requests.length > 0 && fake.requests.every((r) => r.signed), detail: `${fake.requests.length} requests` });
  }

  // 5. Drain + resume. The timeline is written straight to the run (as the
  // worker would) so the check needs no model.
  process.env.DATABASE_URL = appUrl;
  const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
  const runs = await import("@/lib/agents/runs/service");
  const thread = await withWorkspaceScope(ids.workspaceId, (tx) =>
    tx.aiChatThread.create({ data: { projectId: ids.projectId, userId: adminUserId, title: "Multi-instance smoke" } }),
  );
  const run = await runs.createAgentRun({ workspaceId: ids.workspaceId, kind: "chat", startedBy: adminUserId, threadId: thread.id });
  await runs.markAgentRunRunning(ids.workspaceId, run.id);
  const timeline: ChatTimeline = {
    push: async (text) => {
      await runs.appendAgentRunEvent(ids.workspaceId, run.id, { type: "text", summary: "Text delta", payload: { kind: "text_delta", text, step: 0 } });
    },
    finish: async (finalText) => {
      await withWorkspaceScope(ids.workspaceId, (tx) => tx.aiChatMessage.create({ data: { threadId: thread.id, role: "assistant", content: finalText } }));
      await runs.finishAgentRun(ids.workspaceId, run.id, "succeeded");
    },
  };
  checks.push(...(await sseDrainResume(a, b, jar, { runId: run.id, aguiRunId: `smoke-${Date.now()}` }, timeline, { graceMs })));
  checks.push(await sessionOn(b, jar, email));

  // 6. The worker's shutdown path.
  if (process.env.SMOKE_SKIP_WORKER !== "1") {
    const w = startProcess("worker", process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/worker.mts"], baseEnv);
    await new Promise((r) => setTimeout(r, 8_000));
    const stillUp = w.child.exitCode === null;
    const t0 = Date.now();
    killGroup(w.child, "SIGTERM");
    const code = await Promise.race([w.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), graceMs + 5_000))]);
    checks.push({
      name: "the worker starts and exits on SIGTERM within the grace period",
      ok: stillUp && code !== "timeout",
      detail: stillUp ? (code === "timeout" ? "still running" : `exit ${code} after ${Date.now() - t0} ms`) : `exited early (${w.child.exitCode}) — see ${LOG_DIR}/worker.log`,
    });
  }

  await fake?.close();
  return checks;
}

function cleanup() {
  for (const c of children) killGroup(c, "SIGKILL");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

main()
  .then((checks) => {
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail ?? ""}`);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`# pass ${checks.length - failed}\n# fail ${failed}`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error("[smoke] crashed:", err);
    process.exit(1);
  });
