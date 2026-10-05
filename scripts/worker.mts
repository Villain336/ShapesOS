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
// as the app. SIGTERM / SIGINT: stop claiming, let running jobs finish (they
// keep heartbeating); a second signal exits at once — the leases then expire
// and another worker resumes those runs from their saved transcripts.

import { AgentWorker } from "@/lib/agents/queue/worker";
import { prisma } from "@/lib/prisma";

if (!(process.env.DATABASE_URL ?? "").trim()) {
  console.error("[agent-worker] DATABASE_URL is not set; nothing to work on.");
  process.exit(1);
}

const worker = new AgentWorker();
worker.start();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) {
    console.error(`[agent-worker] ${signal} again: exiting now; unfinished jobs resume elsewhere when their leases expire.`);
    process.exit(1);
  }
  stopping = true;
  console.log(`[agent-worker] ${signal}: finishing ${worker.busy} running job(s)…`);
  await worker.stop();
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
