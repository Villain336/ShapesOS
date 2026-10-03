// Marketr — Knowledge Brain: corpus rebuild job.
// GET  /api/corpus/rebuild → { status, logTail } (viewer+)
// POST /api/corpus/rebuild → start scripts/ingest-corpus.mts as a detached
//   background job (platform operators — the corpus is shared by every
//   tenant and the job spawns a process; Phase 1). One job at a time;
//   status + log tail pollable.
//   The job rewrites data/corpus/* and bumps the manifest version.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { requirePlatformOperator } from "@/lib/auth/require-platform-operator";
import {
  readRebuildStatus,
  writeRebuildStatus,
  readRebuildLogTail,
  rebuildLogPath,
} from "@/lib/intelligence/corpus/proposals";

export const dynamic = "force-dynamic";

async function authed(min: "viewer") {
  const user = await requireUser();
  if (!user) return { err: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, min);
  if (!membership) return { err: forbidden() };
  return { user };
}

export async function GET() {
  const a = await authed("viewer");
  if (a.err) return a.err;
  return Response.json({ status: readRebuildStatus(), logTail: readRebuildLogTail(60) });
}

export async function POST() {
  const op = await requirePlatformOperator();
  if (op instanceof Response) return op;

  const current = readRebuildStatus();
  if (current.state === "running") {
    return Response.json({ error: "a rebuild is already running", status: current }, { status: 409 });
  }

  const startedAt = new Date().toISOString();
  const logPath = rebuildLogPath();
  try {
    fs.writeFileSync(logPath, `[rebuild] started ${startedAt}\n`);
  } catch {
    return Response.json({ error: "cannot write rebuild log" }, { status: 500 });
  }

  const log = fs.openSync(logPath, "a");
  const child = spawn("npx", ["tsx", "scripts/ingest-corpus.mts"], {
    cwd: process.cwd(),
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  try {
    fs.closeSync(log);
  } catch {
    /* already handed to the child */
  }

  const status = { state: "running" as const, startedAt, finishedAt: null, pid: child.pid ?? null, error: null };
  writeRebuildStatus(status);

  // Reaper: poll the child and finalize the status file. Fire-and-forget;
  // the status file is the source of truth and survives restarts.
  const pid = child.pid;
  const timer = setInterval(() => {
    if (pid == null) {
      clearInterval(timer);
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(timer);
      const done = readRebuildStatus();
      if (done.state === "running") {
        try {
          const tail = readRebuildLogTail(5);
          const failed = /error|failed|ERR_/i.test(tail);
          writeRebuildStatus({
            state: failed ? "failed" : "succeeded",
            startedAt: done.startedAt,
            finishedAt: new Date().toISOString(),
            pid: done.pid,
            error: failed ? tail.slice(-500) : null,
          });
        } catch {
          writeRebuildStatus({ state: "failed", startedAt: done.startedAt, finishedAt: new Date().toISOString(), pid: done.pid, error: "could not read log" });
        }
      }
    }
  }, 5000);
  timer.unref?.();

  return Response.json({ status }, { status: 202 });
}
