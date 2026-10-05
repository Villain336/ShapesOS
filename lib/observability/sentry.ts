// ShapesOS — minimal Sentry error reporter (Phase 4a observability).
//
// Env-gated: with SENTRY_DSN unset every call is a no-op (no network, no
// work). With it set, server errors are POSTed to Sentry's envelope endpoint
// (https://develop.sentry.dev/sdk/envelopes/) — no SDK dependency: the
// official @sentry/nextjs wraps the build and the bundler, which is a lot of
// surface for "send this exception". Works with self-hosted Sentry and
// GlitchTip (same protocol).
//
// Privacy: events carry the error type, a scrubbed message and stack
// (lib/observability/redact.ts), the route, method and request id. Never
// headers, cookies, query strings, bodies, user ids or emails.
//
// Env: SENTRY_DSN, SENTRY_ENVIRONMENT (default NODE_ENV), SENTRY_RELEASE
// (default MARKETR_GIT_COMMIT).

import { redactString, serializeError } from "./redact";

export interface ParsedDsn {
  publicKey: string;
  /** https://host[:port][/path-prefix] */
  origin: string;
  projectId: string;
  envelopeUrl: string;
}

/** Parse https://<key>@<host>[/<path>]/<project>; null when malformed. */
export function parseDsn(dsn: string | undefined | null): ParsedDsn | null {
  const raw = (dsn ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const publicKey = decodeURIComponent(u.username);
  const parts = u.pathname.split("/").filter(Boolean);
  const projectId = parts.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = parts.length ? `/${parts.join("/")}` : "";
  const origin = `${u.protocol}//${u.host}${prefix}`;
  return { publicKey, origin, projectId, envelopeUrl: `${origin}/api/${projectId}/envelope/` };
}

export function sentryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseDsn(env.SENTRY_DSN) !== null;
}

export interface ErrorContext {
  /** e.g. "POST /api/eddm/orders" or the Next route path. */
  route?: string;
  method?: string;
  /** Path only; any query string is dropped. */
  path?: string;
  requestId?: string | null;
  /** Where Next caught it: render | route | action | proxy. */
  routeType?: string;
  digest?: string;
}

interface Frame {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

/** V8 stack → Sentry frames (oldest first, as Sentry expects). */
export function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(1, 40)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const filename = m[2]!;
    frames.push({
      function: m[1] ? redactString(m[1], 200) : "<anonymous>",
      filename: redactString(filename, 300),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|node:internal|^node:/.test(filename),
    });
  }
  return frames.reverse();
}

function stripQuery(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const i = path.search(/[?#]/);
  return redactString(i === -1 ? path : path.slice(0, i), 500);
}

/** Build the Sentry event (exported for tests). */
export function buildEvent(
  err: unknown,
  ctx: ErrorContext,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Record<string, unknown> {
  const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-error thrown");
  const s = serializeError(error);
  const tags: Record<string, string> = {};
  if (ctx.route) tags.route = redactString(ctx.route, 200);
  if (ctx.method) tags.method = ctx.method.toUpperCase().slice(0, 10);
  if (ctx.routeType) tags.routeType = ctx.routeType.slice(0, 20);
  if (ctx.requestId) tags.requestId = ctx.requestId.slice(0, 128);
  const event: Record<string, unknown> = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: now.getTime() / 1000,
    platform: "node",
    level: "error",
    logger: "shapesos",
    environment: (env.SENTRY_ENVIRONMENT || env.NODE_ENV || "production").slice(0, 64),
    exception: {
      values: [
        {
          type: s.name,
          value: s.message,
          stacktrace: { frames: parseStack(error.stack) },
        },
      ],
    },
    tags,
  };
  const release = (env.SENTRY_RELEASE || env.MARKETR_GIT_COMMIT || "").trim();
  if (release) event.release = release.slice(0, 200);
  const url = stripQuery(ctx.path);
  if (url || ctx.method) event.request = { ...(url ? { url } : {}), ...(ctx.method ? { method: ctx.method.toUpperCase() } : {}) };
  if (ctx.digest) event.extra = { digest: String(ctx.digest).slice(0, 100) };
  return event;
}

export function buildEnvelope(event: Record<string, unknown>, dsn: ParsedDsn, now = new Date()): string {
  const header = { event_id: event.event_id, sent_at: now.toISOString() };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

// One report per Error object (errorResponse and onRequestError can both see one).
const reported = new WeakSet<object>();

/**
 * Report a server error to Sentry. Never throws, never blocks longer than
 * ~2s, and does nothing without SENTRY_DSN.
 */
export async function captureException(
  err: unknown,
  ctx: ErrorContext = {},
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const dsn = parseDsn(env.SENTRY_DSN);
  if (!dsn) return false;
  if (err && typeof err === "object") {
    if (reported.has(err)) return false;
    reported.add(err);
  }
  try {
    const event = buildEvent(err, ctx, env);
    const res = await (opts.fetchImpl ?? fetch)(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=shapesos-reporter/1.0, sentry_key=${dsn.publicKey}`,
      },
      body: buildEnvelope(event, dsn),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    // Telemetry must never take the request down with it.
    return false;
  }
}
