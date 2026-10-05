// ShapesOS — structured JSON logger (Phase 4a observability).
//
// One JSON object per line on stdout (stderr for warn/error), so any log
// shipper (Docker json-file, Loki, CloudWatch, Datadog) can index it:
//
//   {"ts":"2026-10-05T12:00:00.000Z","level":"error","msg":"unhandled route error",
//    "service":"shapesos","requestId":"…","context":"POST /api/x","err":{…}}
//
// Every field passes through redactFields (lib/observability/redact.ts):
// secret-named keys are masked and strings scrubbed, so a careless
// `log.error("…", { headers })` can't leak a cookie or token.
//
// LOG_LEVEL (debug | info | warn | error, default info) filters output.
// Dependency-free so lib/api/errors.ts can import it.

import { redactFields } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Header that carries the per-request correlation id (set by proxy.ts). */
export const REQUEST_ID_HEADER = "x-request-id";

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** A fresh request id (UUID v4). */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * The inbound request id when it is well-formed (an upstream proxy or load
 * balancer may set one), else null. Anything else is ignored so a client
 * can't inject log content through the header.
 */
export function sanitizeRequestId(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && REQUEST_ID_RE.test(v) ? v : null;
}

/** Request id from a Request / Headers, when present and well-formed. */
export function requestIdFrom(source: Request | Headers | null | undefined): string | null {
  if (!source) return null;
  const headers = source instanceof Headers ? source : (source as Request).headers;
  if (!headers || typeof headers.get !== "function") return null;
  return sanitizeRequestId(headers.get(REQUEST_ID_HEADER));
}

export function configuredLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const v = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
}

export type LogFields = Record<string, unknown>;

/** Build the JSON line (exported for tests). */
export function formatLine(level: LogLevel, msg: string, fields: LogFields = {}, now = new Date()): string {
  const safe = redactFields(fields) as Record<string, unknown>;
  return JSON.stringify({ ts: now.toISOString(), level, msg, service: "shapesos", ...safe });
}

function emit(level: LogLevel, msg: string, fields?: LogFields) {
  if (ORDER[level] < ORDER[configuredLevel()]) return;
  let line: string;
  try {
    line = formatLine(level, msg, fields);
  } catch {
    line = JSON.stringify({ ts: new Date().toISOString(), level, msg, service: "shapesos", logError: "unserializable fields" });
  }
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `bindings` to every line (e.g. { requestId, route }). */
  child(bindings: LogFields): Logger;
}

function make(bindings: LogFields): Logger {
  const withB = (f?: LogFields) => (f ? { ...bindings, ...f } : bindings);
  return {
    debug: (m, f) => emit("debug", m, withB(f)),
    info: (m, f) => emit("info", m, withB(f)),
    warn: (m, f) => emit("warn", m, withB(f)),
    error: (m, f) => emit("error", m, withB(f)),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const log: Logger = make({});
