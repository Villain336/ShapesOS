// Deploy PR (WS=state): the dashboard's resilient EventSource client.
// A fake EventSource stands in for the browser's; timers are manual.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultBackoffMs, openLiveStream, withLastEventId, type EventSourceLike, type LiveStreamState } from "../live-stream";

class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  readyState = 0;
  closed = false;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  private listeners = new Map<string, Array<(ev: { data?: string; lastEventId?: string }) => void>>();
  constructor(readonly url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (ev: { data?: string; lastEventId?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(type: string, data: string, lastEventId = "") {
    for (const fn of this.listeners.get(type) ?? []) fn({ data, lastEventId });
  }
  fail() {
    this.readyState = 2;
    this.onerror?.({});
  }
}

function harness(extra: Partial<Parameters<typeof openLiveStream>[1]> = {}) {
  FakeES.all = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const states: LiveStreamState[] = [];
  const got: string[] = [];
  const handle = openLiveStream("/api/x/watch", {
    events: { frame: (d) => got.push(d) },
    onState: (s) => states.push(s),
    EventSourceImpl: FakeES,
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => undefined,
    random: () => 0.5,
    ...extra,
  });
  const fire = () => timers.splice(0).forEach((t) => t.fn());
  return { handle, timers, states, got, fire, es: () => FakeES.all[FakeES.all.length - 1]! };
}

describe("openLiveStream", () => {
  it("reconnects at once on `reconnect`, resuming from the last event id", () => {
    const h = harness();
    h.es().open();
    h.es().emit("frame", "f1", "7");
    h.es().emit("reconnect", '{"reason":"server-restart"}');
    assert.equal(FakeES.all[0]!.closed, true);
    assert.equal(h.timers.length, 1);
    assert.ok(h.timers[0]!.ms <= 500, "a deploy's reconnect is near-immediate");
    h.fire();
    assert.equal(h.es().url, "/api/x/watch?lastEventId=7");
    h.es().open();
    h.es().emit("frame", "f2");
    assert.deepEqual(h.got, ["f1", "f2"]);
    assert.deepEqual(h.states, ["connecting", "open", "reconnecting", "open"]);
  });

  it("backs off on dropped connections and gives up after maxFailures", () => {
    const h = harness({ maxFailures: 3 });
    h.es().open();
    h.es().fail();
    assert.equal(h.timers[0]!.ms, defaultBackoffMs(1, () => 0.5));
    h.fire();
    h.es().fail();
    assert.equal(h.timers[0]!.ms, defaultBackoffMs(2, () => 0.5));
    assert.ok(h.timers[0]!.ms > defaultBackoffMs(1, () => 0.5), "exponential");
    h.fire();
    h.es().fail();
    assert.equal(h.timers.length, 0);
    assert.equal(h.states[h.states.length - 1], "failed");
  });

  it("a stream that never opened fails after maxInitialFailures (a 404 looks like an error)", () => {
    const h = harness({ maxInitialFailures: 1 });
    h.es().fail();
    assert.deepEqual(h.states, ["connecting", "failed"]);
  });

  it("`end` stops, unless onEnd asks for a fresh stream", () => {
    const h = harness();
    h.es().open();
    h.es().emit("end", '{"reason":"run-finished"}');
    assert.equal(h.states[h.states.length - 1], "closed");
    assert.equal(h.timers.length, 0);
    const h2 = harness({ onEnd: () => "reconnect" });
    h2.es().open();
    h2.es().emit("end", '{"reason":"max-duration"}');
    assert.equal(h2.timers.length, 1);
  });

  it("close() stops everything", () => {
    const h = harness();
    h.handle.close();
    assert.equal(h.es().closed, true);
    assert.equal(h.states[h.states.length - 1], "closed");
  });

  it("withLastEventId appends the cursor correctly", () => {
    assert.equal(withLastEventId("/a", null), "/a");
    assert.equal(withLastEventId("/a?view=x", "r:1"), "/a?view=x&lastEventId=r%3A1");
  });
});
