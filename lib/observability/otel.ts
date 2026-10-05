// ShapesOS — OpenTelemetry switch (Phase 4a observability).
//
// Tracing is OFF unless OTEL_EXPORTER_OTLP_ENDPOINT is set; then
// instrumentation.ts registers @vercel/otel (the setup the Next 16 docs
// recommend), which picks up Next's built-in server spans (requests, route
// handlers, rendering, fetch) and exports them over OTLP to that endpoint.
// The standard OTEL_* variables (OTEL_EXPORTER_OTLP_HEADERS,
// OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_RESOURCE_ATTRIBUTES, …) are read by the
// exporter itself. OTEL_SDK_DISABLED=true turns it off again.
//
// Spans carry URLs of outbound fetches. Point the exporter at a collector
// you control (and redact query strings there if a provider puts keys in
// URLs); telemetry for the error tracker itself and the collector are not
// traced.

import { parseDsn } from "./sentry";

export interface OtelOptions {
  serviceName: string;
  instrumentationConfig: { fetch: { ignoreUrls: (string | RegExp)[] } };
}

/** Options for registerOTel, or null when tracing is not configured. */
export function otelOptions(env: NodeJS.ProcessEnv = process.env): OtelOptions | null {
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  if ((env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true") return null;
  const ignoreUrls: (string | RegExp)[] = [endpoint];
  const dsn = parseDsn(env.SENTRY_DSN);
  if (dsn) ignoreUrls.push(dsn.origin);
  return {
    serviceName: (env.OTEL_SERVICE_NAME ?? "").trim() || "shapesos",
    instrumentationConfig: { fetch: { ignoreUrls } },
  };
}
