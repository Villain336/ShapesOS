// Deploy PR (WS=state): the two-instance smoke's checks
// (scripts/smoke/multi-instance-lib.ts), run against STUB servers — two
// in-process HTTP servers that share one in-memory "bucket" and one run
// timeline, standing in for replicas A and B (labelled stubs; the real run is
// scripts/smoke/multi-instance.mts against a production build). The negative
// cases prove each check can fail: a replica that replays from the start
// instead of honouring Last-Event-ID, one that drops the stream without
// `event: reconnect`, a wrong password, a replica that does not share the
// bucket.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CookieJar,
  sessionOn,
  signIn,
  siteOnAReadOnB,
  sseBlocks,
  sseDrainResume,
  uploadOnAFetchOnB,
  waitForHttp,
  type ChatTimeline,
  type Instance,
} from "../multi-instance-lib";

const SESSION = "jwt-session-value";
const RUN = "run1";

/** What the replicas share: the bucket, and the run timeline in the database. */
interface Shared {
  bucket: Map<string, Uint8Array | string>;
  events: Array<{ seq: number; delta: string }>;
  finalText: string | null;
}

interface StubOptions {
  /** Ignore Last-Event-ID and replay the run from the start (a bug). */
  ignoreLastEventId?: boolean;
  /** On SIGTERM, cut streams without `event: reconnect` (a bug). */
  noReconnect?: boolean;
  /** Use a private bucket instead of the shared one (a local-disk replica). */
  privateBucket?: boolean;
  /** At the end, send the whole answer again as its own message (the unprimed-resume bug). */
  resendFinalText?: boolean;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const servers: Server[] = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

async function stubReplica(name: string, shared: Shared, opts: StubOptions = {}): Promise<Instance & { requests: string[] }> {
  const bucket = opts.privateBucket ? new Map<string, Uint8Array | string>() : shared.bucket;
  const requests: string[] = [];
  let draining = false;
  let openStreams = 0;
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => (resolveExit = r));
  const maybeExit = () => {
    if (draining && openStreams === 0) {
      server.close();
      resolveExit(0);
    }
  };
  const authed = (req: IncomingMessage) => (req.headers.cookie ?? "").includes(`authjs.session-token=${SESSION}`);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/api/health/live") return json(res, 200, { ok: true });
    if (url.pathname === "/api/auth/csrf") return json(res, 200, { csrfToken: "csrf-1" }, { "set-cookie": "authjs.csrf-token=csrf-1%7Chash; Path=/; HttpOnly" });
    if (url.pathname === "/api/auth/callback/credentials" && req.method === "POST") {
      const form = new URLSearchParams((await readBody(req)).toString());
      const ok =
        (req.headers.cookie ?? "").includes("authjs.csrf-token=csrf-1") &&
        form.get("csrfToken") === "csrf-1" &&
        form.get("email") === "admin@example.com" &&
        form.get("password") === "pw";
      res.writeHead(302, ok ? { location: "/dashboard", "set-cookie": [`authjs.session-token=${SESSION}; Path=/; HttpOnly`, "authjs.callback-url=x; Path=/"] } : { location: "/login?error=CredentialsSignin" });
      return res.end();
    }
    if (url.pathname === "/api/auth/session") return json(res, 200, authed(req) ? { user: { email: "admin@example.com" } } : {});
    if (!authed(req)) return json(res, 401, { error: "Unauthorized" });

    if (url.pathname === "/api/files" && req.method === "POST") {
      const body = await readBody(req);
      const form = await new Request("http://stub/", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(body) }).formData();
      const file = form.get("file") as File;
      const id = `f${bucket.size + 1}`;
      bucket.set(`files/${form.get("workspaceId")}/${id}`, new Uint8Array(await file.arrayBuffer()));
      return json(res, 201, { file: { id } });
    }
    const fileMatch = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
    if (fileMatch && url.searchParams.get("download") === "1") {
      const bytes = bucket.get(`files/${url.searchParams.get("workspaceId")}/${fileMatch[1]}`);
      if (!(bytes instanceof Uint8Array)) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.from(bytes));
    }
    if (url.pathname === "/api/websites" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString()) as { initialFiles: Array<{ path: string; content: string }> };
      const id = `site${bucket.size + 1}`;
      for (const f of body.initialFiles) bucket.set(`sites/${id}${f.path}`, f.content);
      return json(res, 201, { site: { id } });
    }
    const siteMatch = /^\/api\/websites\/([^/]+)\/file$/.exec(url.pathname);
    if (siteMatch) {
      const content = bucket.get(`sites/${siteMatch[1]}${url.searchParams.get("path")}`);
      return typeof content === "string" ? json(res, 200, { content }) : json(res, 404, { error: "not found" });
    }

    if (url.pathname === "/api/agents/chat/stream") {
      if (url.searchParams.get("runId") !== RUN) return json(res, 404, { error: "Stream not found" });
      const m = /^run1:(\d+)$/.exec(String(req.headers["last-event-id"] ?? ""));
      let cursor = m && !opts.ignoreLastEventId ? Number(m[1]) : -1;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write("retry: 2000\n\n");
      openStreams++;
      const end = () => {
        openStreams--;
        res.end();
        maybeExit();
      };
      for (;;) {
        for (const ev of shared.events.filter((e) => e.seq > cursor)) {
          res.write(`id: ${RUN}:${ev.seq}\ndata: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: ev.delta })}\n\n`);
          cursor = ev.seq;
        }
        if (draining) {
          if (opts.noReconnect) {
            openStreams--;
            res.destroy();
            maybeExit();
            return;
          }
          res.write(`event: reconnect\ndata: ${JSON.stringify({ runId: RUN, after: cursor, aguiRunId: url.searchParams.get("aguiRunId") })}\n\n`);
          return end();
        }
        if (shared.finalText !== null) {
          // Like the real (primed) tail: the final text matches what the
          // open message already holds, so only the message end and
          // RUN_FINISHED follow — no second copy of the answer.
          res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_END", messageId: "m1" })}\n\n`);
          if (opts.resendFinalText) {
            res.write(`data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", messageId: "m2", delta: shared.finalText })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
          return end();
        }
        res.write(": ping\n\n");
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    json(res, 404, { error: "no route" });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    name,
    base,
    requests,
    exited,
    signal: (sig) => {
      if (sig !== "SIGTERM") return;
      draining = true;
      // Let the open streams notice the drain on their next poll.
      setTimeout(maybeExit, 50);
    },
  };
}

function newShared(): Shared {
  return { bucket: new Map(), events: [], finalText: null };
}

function timelineOf(shared: Shared): ChatTimeline {
  return {
    push: async (text) => void shared.events.push({ seq: shared.events.length, delta: text }),
    finish: async (finalText) => void (shared.finalText = finalText),
  };
}

async function signedIn(a: Instance): Promise<CookieJar> {
  const jar = new CookieJar();
  const c = await signIn(a.base, jar, "admin@example.com", "pw");
  assert.ok(c.ok, c.detail);
  return jar;
}

describe("multi-instance smoke checks (stub replicas)", () => {
  it("cookie jar keeps the latest value per name and builds the header", () => {
    const jar = new CookieJar();
    const res = new Response(null, { headers: [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=x=y; HttpOnly"], ["set-cookie", "a=2"]] });
    jar.absorb(res);
    assert.equal(jar.header(), "a=2; b=x=y");
    assert.ok(jar.has(/^b$/));
    assert.ok(!jar.has(/session-token/));
  });

  it("waitForHttp reports up and down", async () => {
    const a = await stubReplica("A", newShared());
    assert.equal(await waitForHttp(`${a.base}/api/health/live`, 2_000), true);
    assert.equal(await waitForHttp("http://127.0.0.1:1/api/health/live", 600), false);
  });

  it("sign in on A; B accepts the session; a wrong password fails", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const b = await stubReplica("B", shared);
    const jar = await signedIn(a);
    assert.ok(jar.has(/session-token/));
    const onB = await sessionOn(b, jar, "ADMIN@example.com");
    assert.ok(onB.ok, onB.detail);
    const bad = await signIn(a.base, new CookieJar(), "admin@example.com", "nope");
    assert.equal(bad.ok, false);
    assert.equal((await sessionOn(b, new CookieJar(), "admin@example.com")).ok, false);
  });

  it("upload on A, download on B byte for byte; site written on A read on B", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const b = await stubReplica("B", shared);
    const jar = await signedIn(a);
    const bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
    const up = await uploadOnAFetchOnB(a, b, jar, "ws1", bytes);
    assert.deepEqual(up.map((c) => c.ok), [true, true], JSON.stringify(up));
    const site = await siteOnAReadOnB(a, b, jar, "p1");
    assert.deepEqual(site.map((c) => c.ok), [true, true, true], JSON.stringify(site));
    assert.ok(a.requests.includes("POST /api/files") && b.requests.includes("GET /api/files/f1"), "each half went to its own replica");
  });

  it("a replica that does not share the bucket fails both storage checks", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const b = await stubReplica("B", shared, { privateBucket: true });
    const jar = await signedIn(a);
    const up = await uploadOnAFetchOnB(a, b, jar, "ws1", new Uint8Array([1, 2, 3]));
    assert.deepEqual(up.map((c) => c.ok), [true, false]);
    const site = await siteOnAReadOnB(a, b, jar, "p1");
    assert.deepEqual(site.map((c) => c.ok), [true, false, false]);
  });

  it("sseBlocks parses events split across chunks", async () => {
    const enc = new TextEncoder();
    const chunks = ["retry: 2000\n\nid: r:1\nda", 'ta: {"x":1}\n\n: ping\n\nevent: reconnect\ndata: {"after":1}\n', "\n"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const blocks = [];
    for await (const b of sseBlocks(new Response(body))) blocks.push(b);
    assert.deepEqual(blocks, [
      { event: null, id: "r:1", data: '{"x":1}' },
      { event: "reconnect", id: null, data: '{"after":1}' },
    ]);
  });

  it("drain + resume: reconnect on SIGTERM, resume on B, every delta exactly once, A exits", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const b = await stubReplica("B", shared);
    const jar = await signedIn(a);
    const checks = await sseDrainResume(a, b, jar, { runId: RUN, aguiRunId: "agui-1" }, timelineOf(shared), { graceMs: 200 });
    for (const c of checks) assert.ok(c.ok, `${c.name}: ${c.detail}`);
    assert.equal(checks.length, 7);
    assert.equal(shared.finalText, "a0 a1 a2 b0 b1 b2 ");
  });

  it("fails when the resuming replica replays from the start (duplicates)", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const b = await stubReplica("B", shared, { ignoreLastEventId: true });
    const jar = await signedIn(a);
    const checks = await sseDrainResume(a, b, jar, { runId: RUN, aguiRunId: "agui-1" }, timelineOf(shared), { graceMs: 200 });
    const exactlyOnce = checks.find((c) => c.name.startsWith("every delta exactly once"))!;
    assert.equal(exactlyOnce.ok, false);
    assert.match(exactlyOnce.detail!, /"a0 ".*"a0 "/);
  });

  it("fails when the resuming replica sends the whole answer again at the end", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const b = await stubReplica("B", shared, { resendFinalText: true });
    const jar = await signedIn(a);
    const checks = await sseDrainResume(a, b, jar, { runId: RUN, aguiRunId: "agui-1" }, timelineOf(shared), { graceMs: 200 });
    const exactlyOnce = checks.find((c) => c.name.startsWith("every delta exactly once"))!;
    assert.equal(exactlyOnce.ok, false);
    assert.match(exactlyOnce.detail!, /"a0 a1 a2 b0 b1 b2 "/);
  });

  it("fails when SIGTERM drops the stream without `event: reconnect`", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared, { noReconnect: true });
    const b = await stubReplica("B", shared);
    const jar = await signedIn(a);
    const checks = await sseDrainResume(a, b, jar, { runId: RUN, aguiRunId: "agui-1" }, timelineOf(shared), { graceMs: 200 }).catch(
      (err: Error) => [{ name: "A sends `event: reconnect` on SIGTERM", ok: false, detail: err.message }],
    );
    assert.equal(checks.find((c) => c.name.startsWith("A sends `event: reconnect`"))!.ok, false);
  });

  it("an unknown run is a failed open, not a crash", async () => {
    const shared = newShared();
    const a = await stubReplica("A", shared);
    const jar = await signedIn(a);
    const checks = await sseDrainResume(a, a, jar, { runId: "nope", aguiRunId: "x" }, timelineOf(shared), { graceMs: 200 });
    assert.deepEqual(checks.map((c) => c.ok), [false]);
  });
});
