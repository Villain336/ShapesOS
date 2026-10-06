// ShapesOS — Phase 8: the agent worker process.
//
// Run: npx tsx scripts/worker.mts
// (compose `worker` service; the app then runs with AGENT_WORKER=external so
// it only enqueues). Claims agent_jobs with SKIP LOCKED, runs each through
// lib/agents/queue/handlers.ts with a heartbeat-extended lease, and requeues
// / dead-letters as lib/agents/queue/worker.ts describes. Settings:
// AGENT_WORKER_CONCURRENCY, AGENT_WORKER_POLL_MS, AGENT_JOB_LEASE_SECONDS,
// AGENT_JOB_HEARTBEAT_SECONDS, AGENT_JOB_MAX_ATTEMPTS (.env.example).
//
// Needs DATABASE_URL (the least-privilege app role) and the same model keys
// as the app. SIGTERM / SIGINT (deploy PR: the shared shutdown path,
// lib/runtime/shutdown.ts): stop claiming, let running jobs finish for
// SHUTDOWN_HANDOFF_MS, then hand the rest back to the queue at once (their
// transcripts are saved; another worker continues them without waiting for
// the lease to expire and without charging the attempt); exit by
// SHUTDOWN_GRACE_MS at the latest. A second signal exits at once.

import { AgentWorker } from "@/lib/agents/queue/worker";
import { prisma } from "@/lib/prisma";
import { installShutdownHandlers, onShutdown } from "@/lib/runtime/shutdown";
import { drainAgentWork } from "@/lib/runtime/agent-drain";
import { startCollabServer } from "@/lib/collab/server";
import { workerCollabPort } from "@/lib/collab/env";

if (!(process.env.DATABASE_URL ?? "").trim()) {
  console.error("[agent-worker] DATABASE_URL is not set; nothing to work on.");
  process.exit(1);
}

const worker = new AgentWorker();
worker.start();

// Phase 18.2 (WS=content): the live-collaboration server, when COLLAB_PORT is
// set (local, docker compose). On Render it runs as its own single-instance
// web service (scripts/collab.mts): a background worker takes no inbound
// connections. SIGTERM stores every live document before the process exits.
const collabPort = workerCollabPort();
if (collabPort) {
  const collab = await startCollabServer({ port: collabPort, host: "0.0.0.0" });
  onShutdown("collab", async (signal) => {
    console.log(`[collab] ${signal}: storing live documents and closing connections…`);
    await collab.close();
  });
}

onShutdown("agent-worker", async (signal) => {
  console.log(`[agent-worker] ${signal}: handing off ${worker.busy} running job(s)…`);
  await drainAgentWork({ worker, inlineHandoff: false });
  await prisma.$disconnect().catch(() => undefined);
});
installShutdownHandlers();
