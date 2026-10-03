// ShapesOS — Phase 4a observability: redaction, the JSON logger, request ids,
// the Sentry envelope reporter, the OTel switch, health-check rules, and the
// route error wrapper's structured 500 log.
// Run: npx tsx --test lib/observability/__tests__/observability.test.ts

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REDACTED, redactFields, redactString } from "../redact";
import { configuredLevel, formatLine, log, newRequestId, requestIdFrom, sanitizeRequestId } from "../log";
import { buildEnvelope, buildEvent, captureException, parseDsn, parseStack, sentryEnabled } from "../sentry";
import { otelOptions } from "../otel";
import { buildCommit, compareMigrations, listMigrations, overallStatus, withTimeout } from "../health";
import { errorResponse, withErrorHandling, NotFoundError } from "../../api/errors";

function capture(method: "log" | "warn" | "error") {
  const lines: string[] = [];
  const spy = mock.method(console, method, (...args: unknown[]) => {
    lines.push(String(args[0]));
  });
  return { lines, restore: () => spy.mock.restore() };
}

describe("redaction", () => {
  it("masks secrets inside free text", () => {
    const s = redactString(
      "connect postgresql://app:hunter2@db:5432/x failed; Authorization: Bearer abcdefghijklmnop; password=s3cret key sk_live_abcdefgh12345678 for ana@example.com",
    );
    assert.doesNotMatch(s, /hunter2|abcdefghijklmnop|s3cret|sk_live_abcdefgh12345678|ana@example\.com/);
    assert.match(s, /postgresql:\/\/\[redacted\]@db/);
    assert.match(s, /\[email\]/);
  });

  it("masks JWTs and long opaque tokens but keeps ordinary words and short ids", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const s = redactString(`token ${jwt} and ${"a".repeat(8)}${"0123456789abcdef".repeat(3)} for workspace cl123abc`);
    assert.doesNotMatch(s, /eyJhbGci/);
    assert.match(s, /workspace cl123abc/);
  });

  it("masks sensitive keys at any depth and survives cycles", () => {
    const o: Record<string, unknown> = { user: { email: "x@y.co", name: "Ana" }, headers: { cookie: "a=b", authorization: "Bearer x" }, apiKey: "k", count: 3 };
    o.self = o;
    const r = redactFields(o) as Record<string, Record<string, unknown>>;
    assert.equal(r.user!.email, REDACTED);
    assert.equal(r.user!.name, "Ana");
    assert.equal(r.headers!.cookie, REDACTED);
    assert.equal(r.headers!.authorization, REDACTED);
    assert.equal((r as Record<string, unknown>).apiKey, REDACTED);
    assert.equal((r as Record<string, unknown>).count, 3);
    assert.equal((r as Record<string, unknown>).self, "[circular]");
  });

  it("serializes errors with scrubbed message and stack frames", () => {
    const err = new Error("db at postgres://u:p@h/db said no");
    (err as Error & { code?: string }).code = "P1001";
    const r = redactFields({ err }) as { err: { name: string; message: string; code: string; stack?: string } };
    assert.equal(r.err.name, "Error");
    assert.equal(r.err.code, "P1001");
    assert.doesNotMatch(r.err.message, /u:p@/);
    assert.ok(r.err.stack && !r.err.stack.startsWith("Error"));
  });
});

describe("JSON logger", () => {
  it("writes one parseable line with ts, level, msg, service and fields", () => {
    const line = formatLine("info", "hello", { requestId: "req-12345678", n: 1 }, new Date("2026-10-05T00:00:00Z"));
    assert.deepEqual(JSON.parse(line), {
      ts: "2026-10-05T00:00:00.000Z",
      level: "info",
      msg: "hello",
      service: "shapesos",
      requestId: "req-12345678",
      n: 1,
    });
  });

  it("routes levels to the right stream and honors LOG_LEVEL", () => {
    const prev = process.env.LOG_LEVEL;
    const out = capture("log");
    const err = capture("error");
    try {
      process.env.LOG_LEVEL = "warn";
      log.info("dropped");
      log.error("kept", { password: "x" });
      assert.equal(out.lines.length, 0);
      assert.equal(err.lines.length, 1);
      const parsed = JSON.parse(err.lines[0]!);
      assert.equal(parsed.password, REDACTED);
      process.env.LOG_LEVEL = "debug";
      log.child({ requestId: "child-1234" }).debug("d");
      assert.equal(JSON.parse(out.lines[0]!).requestId, "child-1234");
    } finally {
      out.restore();
      err.restore();
      if (prev === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = prev;
    }
  });

  it("falls back to info for unknown levels", () => {
    assert.equal(configuredLevel({ LOG_LEVEL: "loud" } as NodeJS.ProcessEnv), "info");
    assert.equal(configuredLevel({} as NodeJS.ProcessEnv), "info");
  });
});

describe("request ids", () => {
  it("accepts well-formed ids and rejects injection attempts", () => {
    assert.equal(sanitizeRequestId("3f2b8c1e-1111-4222-8333-444455556666"), "3f2b8c1e-1111-4222-8333-444455556666");
    assert.equal(sanitizeRequestId("short"), null);
    assert.equal(sanitizeRequestId('abc"}\n{"level":"error"'), null);
    assert.equal(sanitizeRequestId("x".repeat(200)), null);
    assert.match(newRequestId(), /^[0-9a-f-]{36}$/);
  });

  it("reads the header from a Request or Headers", () => {
    const req = new Request("http://x/api/y", { headers: { "x-request-id": "req-abcdef12" } });
    assert.equal(requestIdFrom(req), "req-abcdef12");
    assert.equal(requestIdFrom(new Headers()), null);
    assert.equal(requestIdFrom(null), null);
  });
});

describe("Sentry reporter", () => {
  it("parses DSNs (with and without a path prefix) and rejects bad ones", () => {
    assert.deepEqual(parseDsn("https://pub123@o42.ingest.sentry.io/7"), {
      publicKey: "pub123",
      origin: "https://o42.ingest.sentry.io",
      projectId: "7",
      envelopeUrl: "https://o42.ingest.sentry.io/api/7/envelope/",
    });
    assert.equal(parseDsn("https://k@glitch.example.com/sentry/12")?.envelopeUrl, "https://glitch.example.com/sentry/api/12/envelope/");
    for (const bad of ["", "not a url", "https://o42.ingest.sentry.io/7", "https://k@host/notanumber", "ftp://k@h/1"]) {
      assert.equal(parseDsn(bad), null, bad);
    }
    assert.equal(sentryEnabled({} as NodeJS.ProcessEnv), false);
  });

  it("builds an event without headers, query strings, emails or secrets", () => {
    const err = new TypeError("lookup failed for ana@example.com with token=abc123secret");
    const ev = buildEvent(
      err,
      { route: "POST /api/x", method: "post", path: "/api/x?key=SECRET&email=a@b.co", requestId: "req-12345678" },
      { NODE_ENV: "production", MARKETR_GIT_COMMIT: "abc1234" } as NodeJS.ProcessEnv,
    );
    const json = JSON.stringify(ev);
    assert.doesNotMatch(json, /ana@example\.com|abc123secret|SECRET|a@b\.co/);
    assert.equal((ev.request as { url: string }).url, "/api/x");
    assert.equal(ev.release, "abc1234");
    assert.equal(ev.environment, "production");
    const ex = (ev.exception as { values: { type: string; stacktrace: { frames: unknown[] } }[] }).values[0]!;
    assert.equal(ex.type, "TypeError");
    assert.ok(ex.stacktrace.frames.length > 0);
    assert.deepEqual(ev.tags, { route: "POST /api/x", method: "POST", requestId: "req-12345678" });
    const envelope = buildEnvelope(ev, parseDsn("https://k@h.io/1")!);
    const [header, item, payload] = envelope.trim().split("\n");
    assert.equal(JSON.parse(header!).event_id, ev.event_id);
    assert.deepEqual(JSON.parse(item!), { type: "event" });
    assert.equal(JSON.parse(payload!).event_id, ev.event_id);
  });

  it("parses V8 stacks oldest-first and marks app frames", () => {
    const frames = parseStack("Error: x\n    at inner (/app/lib/a.ts:1:2)\n    at outer (/app/node_modules/p/i.js:3:4)\n    at /app/lib/b.ts:5:6");
    assert.equal(frames.length, 3);
    assert.equal(frames[0]!.filename, "/app/lib/b.ts");
    assert.equal(frames[2]!.function, "inner");
    assert.equal(frames[1]!.in_app, false);
  });

  it("is a no-op without SENTRY_DSN", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return new Response(null);
    }) as typeof fetch;
    assert.equal(await captureException(new Error("x"), {}, { env: {} as NodeJS.ProcessEnv, fetchImpl }), false);
    assert.equal(called, 0);
  });

  it("POSTs one envelope per error with the auth header, and never throws", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const env = { SENTRY_DSN: "https://pubkey@sentry.example.com/9" } as NodeJS.ProcessEnv;
    const err = new Error("boom");
    assert.equal(await captureException(err, { route: "GET /x" }, { env, fetchImpl }), true);
    assert.equal(await captureException(err, { route: "GET /x" }, { env, fetchImpl }), false, "same error reported once");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://sentry.example.com/api/9/envelope/");
    const h = calls[0]!.init.headers as Record<string, string>;
    assert.match(h["x-sentry-auth"]!, /sentry_key=pubkey/);
    assert.equal(h["content-type"], "application/x-sentry-envelope");
    const failing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    assert.equal(await captureException(new Error("y"), {}, { env, fetchImpl: failing }), false);
  });
});

describe("OpenTelemetry switch", () => {
  it("is off without an endpoint or when disabled", () => {
    assert.equal(otelOptions({} as NodeJS.ProcessEnv), null);
    assert.equal(otelOptions({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" } as NodeJS.ProcessEnv), null);
  });
  it("names the service and keeps its own telemetry out of the traces", () => {
    const o = otelOptions({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      SENTRY_DSN: "https://k@sentry.example.com/3",
    } as NodeJS.ProcessEnv);
    assert.equal(o?.serviceName, "shapesos");
    assert.deepEqual(o?.instrumentationConfig.fetch.ignoreUrls, ["http://collector:4318", "https://sentry.example.com"]);
    assert.equal(otelOptions({ OTEL_EXPORTER_OTLP_ENDPOINT: "x", OTEL_SERVICE_NAME: "acme" } as NodeJS.ProcessEnv)?.serviceName, "acme");
  });
});

describe("health rules", () => {
  const done = (name: string) => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null });

  it("all shipped migrations applied → ok", () => {
    assert.deepEqual(compareMigrations(["a", "b"], [done("a"), done("b")]), { status: "ok", pending: 0, failed: 0 });
  });
  it("a pending or failed migration fails readiness; a rolled-back one doesn't count as applied", () => {
    assert.deepEqual(compareMigrations(["a", "b"], [done("a")]), { status: "fail", pending: 1, failed: 0 });
    const failed = { migration_name: "b", finished_at: null, rolled_back_at: null };
    assert.deepEqual(compareMigrations(["a", "b"], [done("a"), failed]), { status: "fail", pending: 1, failed: 1 });
    const rolledBack = { migration_name: "b", finished_at: new Date(), rolled_back_at: new Date() };
    assert.equal(compareMigrations(["a", "b"], [done("a"), rolledBack]).pending, 1);
  });
  it("unknown when the table or the folder can't be read", () => {
    assert.equal(compareMigrations(["a"], null).status, "unknown");
    assert.deepEqual(compareMigrations(null, [done("a")]), { status: "unknown", pending: null, failed: 0 });
  });
  it("overall: database must be ok and migrations must not fail", () => {
    const db = { status: "ok" as const, latencyMs: 1 };
    assert.equal(overallStatus({ database: db, migrations: { status: "ok", pending: 0, failed: 0 } }), "ok");
    assert.equal(overallStatus({ database: db, migrations: { status: "unknown", pending: null, failed: null } }), "ok");
    assert.equal(overallStatus({ database: db, migrations: { status: "fail", pending: 2, failed: 0 } }), "unavailable");
    assert.equal(
      overallStatus({ database: { status: "fail", latencyMs: null }, migrations: { status: "ok", pending: 0, failed: 0 } }),
      "unavailable",
    );
  });
  it("commit must look like a git sha", () => {
    assert.equal(buildCommit({ MARKETR_GIT_COMMIT: "0123456789abcdef0123" } as NodeJS.ProcessEnv), "0123456789ab");
    assert.equal(buildCommit({ MARKETR_GIT_COMMIT: "secret value" } as NodeJS.ProcessEnv), null);
    assert.equal(buildCommit({} as NodeJS.ProcessEnv), null);
  });
  it("lists only folders that hold a migration.sql", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    mkdirSync(join(dir, "20260101_a"));
    writeFileSync(join(dir, "20260101_a", "migration.sql"), "select 1;");
    mkdirSync(join(dir, "empty"));
    writeFileSync(join(dir, "migration_lock.toml"), "");
    assert.deepEqual(listMigrations(dir), ["20260101_a"]);
    assert.equal(listMigrations(join(dir, "missing")), null);
  });
  it("withTimeout rejects slow work", async () => {
    await assert.rejects(() => withTimeout(new Promise((r) => setTimeout(r, 200)), 10), /timed out/);
    assert.equal(await withTimeout(Promise.resolve(5), 100), 5);
  });
});

describe("route error wrapper", () => {
  it("logs a 500 as one JSON line with context, request id and scrubbed error; body carries the request id", async () => {
    const err = capture("error");
    try {
      const handler = withErrorHandling(async (_req: Request) => {
        throw new Error("password=hunter2 rejected by postgres://u:pw@db/x");
      }, "POST /api/thing");
      const res = await handler(new Request("http://app/api/thing?token=abc", { method: "POST", headers: { "x-request-id": "req-77777777" } }));
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Internal server error", requestId: "req-77777777" });
      assert.equal(err.lines.length, 1);
      const line = JSON.parse(err.lines[0]!);
      assert.equal(line.level, "error");
      assert.equal(line.context, "POST /api/thing");
      assert.equal(line.requestId, "req-77777777");
      assert.equal(line.method, "POST");
      assert.equal(line.path, "/api/thing");
      assert.doesNotMatch(err.lines[0]!, /hunter2|u:pw@|token=abc/);
    } finally {
      err.restore();
    }
  });

  it("4xx stays quiet and has no request id in the body", async () => {
    const err = capture("error");
    try {
      const res = errorResponse(new NotFoundError(), "GET /x", new Request("http://a/x", { headers: { "x-request-id": "req-88888888" } }));
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "Not found." });
      assert.equal(err.lines.length, 0);
    } finally {
      err.restore();
    }
  });
});
