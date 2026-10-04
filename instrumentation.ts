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
//   onRequestError()  errors Next caught itself (render, route, action,
//                     proxy): one structured log line, plus a Sentry report
//                     when SENTRY_DSN is set (lib/observability/sentry.ts).
//
// Both are clean no-ops without configuration. Node.js runtime only; the
// app has no edge routes.

import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
    await startCronRunnerFromEnv(process.env);
  } catch (err) {
    const { log } = await import("./lib/observability/log");
    log.error("in-app cron runner failed to start", { err: err instanceof Error ? err.message : String(err) });
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./lib/observability/request-error");
  await reportRequestError(err, request, context);
};
