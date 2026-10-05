import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { invalidateShared, sharedJson } from "../shared-fetch";

function fakeFetch() {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify({ n: calls }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

describe("sharedJson", () => {
  beforeEach(() => invalidateShared());

  it("joins concurrent callers onto one request", async () => {
    const f = fakeFetch();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => sharedJson("/api/x", { fetcher: f.fetcher })));
    assert.equal(f.calls(), 1);
    assert.deepEqual([a.body, b.body, c.body], [{ n: 1 }, { n: 1 }, { n: 1 }]);
  });

  it("reuses a result inside the window, refetches after it and on fresh", async () => {
    const f = fakeFetch();
    let t = 1_000;
    const now = () => t;
    await sharedJson("/api/x", { fetcher: f.fetcher, now });
    t += 4_000;
    await sharedJson("/api/x", { fetcher: f.fetcher, now });
    assert.equal(f.calls(), 1);
    t += 2_000;
    await sharedJson("/api/x", { fetcher: f.fetcher, now });
    assert.equal(f.calls(), 2);
    await sharedJson("/api/x", { fetcher: f.fetcher, now, fresh: true });
    assert.equal(f.calls(), 3);
  });

  it("never reuses a failed response", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response("no", { status: calls === 1 ? 500 : 200 });
    }) as unknown as typeof fetch;
    const first = await sharedJson("/api/y", { fetcher });
    assert.equal(first.ok, false);
    await new Promise((r) => setImmediate(r));
    const second = await sharedJson("/api/y", { fetcher });
    assert.equal(second.ok, true);
    assert.equal(calls, 2);
  });
});
