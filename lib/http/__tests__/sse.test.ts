// Deploy PR (WS=state): the shared SSE helper and the one shutdown path.
// Heartbeats on a fake clock, Last-Event-ID, the reconnect drain, the
// cooperative drain with its deadline, client disconnects, and the process
// drain (streams + hooks + background work + deadline).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { formatSseEvent, lastEventIdOf, sseStream, sseResponse, SSE_HEARTBEAT_MS, type SseClock } from "../sse";
import {
  __resetShutdownForTests,
  beginDrain,
  isDraining,
  onShutdown,
  openStreamCount,
  registerStream,
  shutdownGraceMs,
  shutdownHandoffMs,
  trackBackgroundWork,
  type DrainableStream,
} from "@/lib/runtime/shutdown";

/** Manual clock: timers fire only when the test says so. */
function fakeClock() {
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  let n = 0;
  const clock: SseClock = {
    setInterval: (fn, ms) => (intervals.set(++n, { fn, ms }), n),
    clearInterval: (h) => void intervals.delete(h as number),
    setTimeout: (fn, ms) => (timeouts.set(++n, { fn, ms }), n),
    clearTimeout: (h) => void timeouts.delete(h as number),
  };
  return {
    clock,
    intervals,
    timeouts,
    tickIntervals: () => [...intervals.values()].forEach((t) => t.fn()),
    fireTimeouts: () => [...timeouts.entries()].forEach(([k, t]) => (timeouts.delete(k), t.fn())),
  };
}

/** Registry stub: captures the drainable so the test can drain it. */
function fakeRegistry() {
  const streams: DrainableStream[] = [];
  return { streams, register: (s: DrainableStream) => (streams.push(s), () => void streams.splice(streams.indexOf(s), 1)) };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Read what has been enqueued so far without waiting for the end. */
function reader(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await r.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
  })();
  return { text: () => buf, ended: pump, cancel: () => r.cancel() };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => __resetShutdownForTests());

describe("SSE formatting and resume cursor", () => {
  it("formats events with id, name and multi-line data", () => {
    assert.equal(formatSseEvent(null, "x"), "data: x\n\n");
    assert.equal(formatSseEvent("frame", { a: 1 }, "7"), 'id: 7\nevent: frame\ndata: {"a":1}\n\n');
    assert.equal(formatSseEvent("note", "line1\nline2"), "event: note\ndata: line1\ndata: line2\n\n");
    assert.equal(formatSseEvent("e\nvil", "d", "1\n2"), "id: 12\nevent: evil\ndata: d\n\n", "no header injection");
  });

  it("Last-Event-ID comes from the header, else ?lastEventId=", () => {
    assert.equal(lastEventIdOf(new Request("http://x/s", { headers: { "Last-Event-ID": "run:42" } })), "run:42");
    assert.equal(lastEventIdOf(new Request("http://x/s?lastEventId=run%3A9")), "run:9");
    assert.equal(lastEventIdOf(new Request("http://x/s")), null);
  });
});

describe("sseStream", () => {
  it("opens with retry:, sends a heartbeat on every tick of the (fake) clock, closes when run returns", async () => {
    const fc = fakeClock();
    const reg = fakeRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = reader(
      sseStream(
        async (ch) => {
          ch.send("hello", { n: 1 }, { id: "1" });
          await gate;
        },
        { clock: fc.clock, register: reg.register, heartbeatMs: 60_000 },
      ),
    );
    await tick();
    assert.equal([...fc.intervals.values()][0]!.ms, SSE_HEARTBEAT_MS, "heartbeat is capped at 15 s");
    fc.tickIntervals();
    fc.tickIntervals();
    await tick();
    assert.equal(s.text().split(": ping\n\n").length - 1, 2);
    assert.ok(s.text().startsWith("retry: 2000\n\n"));
    assert.match(s.text(), /id: 1\nevent: hello\ndata: \{"n":1\}/);
    assert.equal(reg.streams.length, 1, "registered for the drain");
    release();
    await s.ended;
    assert.equal(fc.intervals.size, 0, "heartbeat stopped");
    assert.equal(reg.streams.length, 0, "unregistered on close");
  });

  it("drain (default): retry + event: reconnect, then close; the producer sees its signal abort", async () => {
    const fc = fakeClock();
    const reg = fakeRegistry();
    let aborted = false;
    const s = reader(
      sseStream(
        async (ch) => {
          ch.send("frame", "a", { id: "5" });
          await new Promise<void>((r) => ch.signal.addEventListener("abort", () => r()));
          aborted = true;
          assert.equal(ch.send("frame", "late"), false, "nothing is written after close");
        },
        { clock: fc.clock, register: reg.register, reconnectData: () => ({ after: "5" }) },
      ),
    );
    await tick();
    reg.streams[0]!.drain("SIGTERM");
    await s.ended;
    await reg.streams[0]?.done;
    assert.ok(aborted);
    assert.match(s.text(), /retry: 2000\n\nevent: reconnect\ndata: \{"after":"5"\}\n\n$/);
    assert.ok(!s.text().includes("late"));
  });

  it("drain (cooperative): the producer finishes its unit and reconnects itself; the deadline forces it otherwise", async () => {
    const fc = fakeClock();
    const reg = fakeRegistry();
    const s = reader(
      sseStream(
        async (ch) => {
          await ch.drained;
          assert.equal(ch.draining, true);
          ch.send(null, { type: "LAST_OF_BATCH" }, { id: "run:9" });
          ch.reconnect({ runId: "run", after: 9 });
        },
        { clock: fc.clock, register: reg.register, drain: "cooperative" },
      ),
    );
    await tick();
    reg.streams[0]!.drain("SIGTERM");
    await s.ended;
    assert.match(s.text(), /id: run:9\ndata: \{"type":"LAST_OF_BATCH"\}\n\nretry: 2000\n\nevent: reconnect\ndata: \{"runId":"run","after":9\}\n\n$/);

    // A producer that ignores the drain is cut at the deadline.
    const fc2 = fakeClock();
    const reg2 = fakeRegistry();
    const stuck = reader(sseStream(() => new Promise<void>(() => undefined), { clock: fc2.clock, register: reg2.register, drain: "cooperative" }));
    await tick();
    reg2.streams[0]!.drain("SIGTERM");
    assert.equal(fc2.timeouts.size, 1);
    fc2.fireTimeouts();
    await stuck.ended;
    assert.match(stuck.text(), /event: reconnect/);
  });

  it("a client disconnect aborts the producer and unregisters the stream", async () => {
    const reg = fakeRegistry();
    let sawAbort = false;
    const s = reader(
      sseStream(
        async (ch) => {
          await new Promise<void>((r) => ch.signal.addEventListener("abort", () => r()));
          sawAbort = true;
        },
        { clock: fakeClock().clock, register: reg.register },
      ),
    );
    await tick();
    await s.cancel();
    await tick();
    assert.ok(sawAbort);
    assert.equal(reg.streams.length, 0);
  });

  it("sseResponse sets the SSE headers", async () => {
    const res = sseResponse((ch) => void ch.send("x", "y"), { clock: fakeClock().clock, register: fakeRegistry().register });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    assert.match(await readAll(res.body!), /event: x\ndata: y/);
  });
});

describe("process drain (lib/runtime/shutdown.ts)", () => {
  it("drains every open stream, runs hooks, waits for background work, then exits", async () => {
    const order: string[] = [];
    // A real stream on the real registry.
    const s = reader(sseStream(async (ch) => void (await new Promise((r) => ch.signal.addEventListener("abort", r))), { clock: fakeClock().clock }));
    await tick();
    assert.equal(openStreamCount(), 1);
    onShutdown("cron", () => void order.push("cron stopped"));
    onShutdown("cron", () => void order.push("duplicate hook ignored"));
    let finishBg!: () => void;
    void trackBackgroundWork(new Promise<void>((r) => (finishBg = r)).then(() => void order.push("background done")));
    let exitCode: number | null = null;
    const drained = beginDrain("SIGTERM", { graceMs: 5_000, exit: (c) => (exitCode = c), log: () => undefined });
    assert.equal(isDraining(), true);
    await s.ended;
    assert.match(s.text(), /event: reconnect/);
    await tick();
    assert.equal(exitCode, null, "still waiting for background work");
    finishBg();
    await drained;
    assert.equal(exitCode, 0);
    assert.deepEqual(order, ["cron stopped", "background done"]);
    assert.equal(beginDrain("SIGTERM"), drained, "idempotent");
  });

  it("exits at the deadline when work does not finish", async () => {
    void trackBackgroundWork(new Promise(() => undefined));
    let exitCode: number | null = null;
    const started = Date.now();
    await beginDrain("SIGTERM", { graceMs: 50, exit: (c) => (exitCode = c), log: () => undefined });
    assert.equal(exitCode, 0);
    assert.ok(Date.now() - started >= 45);
  });

  it("a stream opened after the drain started is drained at once", async () => {
    void beginDrain("SIGTERM", { graceMs: 1_000, exit: () => undefined, log: () => undefined });
    const s = reader(sseStream(async (ch) => void (await new Promise((r) => ch.signal.addEventListener("abort", r))), { clock: fakeClock().clock }));
    await s.ended;
    assert.match(s.text(), /event: reconnect/);
  });

  it("grace and hand-off windows come from the environment, clamped", () => {
    const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;
    assert.equal(shutdownGraceMs(env({})), 25_000);
    assert.equal(shutdownGraceMs(env({ SHUTDOWN_GRACE_MS: "40000" })), 40_000);
    assert.equal(shutdownGraceMs(env({ SHUTDOWN_GRACE_MS: "5" })), 1_000);
    assert.equal(shutdownHandoffMs(env({})), 8_000);
    assert.equal(shutdownHandoffMs(env({ SHUTDOWN_GRACE_MS: "3000" })), 3_000, "never past the grace period");
  });
});
