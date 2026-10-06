// ShapesOS — Next.js instrumentation hook (Phase 4a observability).
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
//
//   register()        once per server start. Turns on OpenTelemetry tracing
//                     when OTEL_EXPORTER_OTLP_ENDPOINT is set
//                     (lib/observability/otel.ts); otherwise does nothing.
//                     Then starts the in-app cron runner (lib/cron/runner.ts)
//                     when cronRunnerDecision() allows it: CRON_RUNNER=internal
//                     (the default on a production server) and CRON_SECRET
//                     set; never during `next build`, in tests or on edge.
//                     Phase 8: then the in-app agent worker
//                     (lib/agents/queue/worker.ts) unless AGENT_WORKER is
//                     external (a separate `worker` service) or off.
//                     Deploy PR: first of all, the ONE graceful-shutdown
//                     path (lib/runtime/shutdown.ts): on SIGTERM open SSE
//                     streams reconnect elsewhere, readiness answers 503,
//                     the cron runner and the in-app worker stop, inline
//                     agent turns hand off to the worker, and the process
//                     exits by SHUTDOWN_GRACE_MS at the latest.
//   onRequestError()  errors Next caught itself (render, route, action,
//                     proxy): one structured log line, plus a Sentry report
//                     when SENTRY_DSN is set (lib/observability/sentry.ts).
//
// Both are clean no-ops without configuration. Node.js runtime only; the
// app has no edge routes.

import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const shutdown = await import("./lib/runtime/shutdown");
  if (process.env.NEXT_PHASE !== "phase-production-build") shutdown.installShutdownHandlers();
  // Deploy PR: a hosted install with per-instance disk storage is broken in
  // a way nothing else would surface — say so at boot.
  const { storageDeploymentWarning } = await import("./lib/filesystem/storage");
  const storageWarning = storageDeploymentWarning(process.env);
  if (storageWarning) {
    const { log } = await import("./lib/observability/log");
    log.error("storage misconfigured for this deployment", { detail: storageWarning });
  }
  const { otelOptions } = await import("./lib/observability/otel");
  const options = otelOptions(process.env);
  if (options) {
    const { registerOTel } = await import("@vercel/otel");
    registerOTel(options);
    const { log } = await import("./lib/observability/log");
    log.info("opentelemetry tracing enabled", { serviceName: options.serviceName });
  }
  // The runner's first tick waits until the server is listening; register()
  // itself returns immediately (it must finish before requests are served).
  try {
    const { startCronRunnerFromEnv } = await import("./lib/cron/runner");
    const runner = await startCronRunnerFromEnv(process.env);
    if (runner) {
      shutdown.onShutdown("cron-runner", async () => {
        runner.stop();
        await runner.drain();
      });
    }
  } catch (err) {
    const { log } = await import("./lib/observability/log");
    log.error("in-app cron runner failed to start", { err: err instanceof Error ? err.message : String(err) });
  }
  let worker: import("./lib/agents/queue/worker").AgentWorker | null = null;
  try {
    const { startAgentWorkerFromEnv } = await import("./lib/agents/queue/worker");
    worker = await startAgentWorkerFromEnv(process.env);
  } catch (err) {
    const { log } = await import("./lib/observability/log");
    log.error("in-app agent worker failed to start", { err: err instanceof Error ? err.message : String(err) });
  }
  // Agent work this process is running: in-app worker jobs are handed back,
  // inline chat turns hand off to the worker (lib/runtime/agent-drain.ts).
  shutdown.onShutdown("agent-work", async () => {
    const { drainAgentWork } = await import("./lib/runtime/agent-drain");
    await drainAgentWork({ worker });
  });
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./lib/observability/request-error");
  await reportRequestError(err, request, context);
};
