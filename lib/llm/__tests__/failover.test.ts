// ShapesOS — Phase 6: FailoverLlmProvider with fake providers (offline).
// Run: npx tsx --test lib/llm/__tests__/failover.test.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FailoverLlmProvider, lastFailover, __resetFailoverLog } from "../failover";
import { LlmProviderError, type LlmErrorKind } from "../errors";
import type { ChatRequest, LlmGenerateOptions, LlmProvider } from "../types";
import { MockLlmProvider } from "../mock";

class FakeProvider implements LlmProvider {
  readonly isLive = true;
  calls = 0;
  private readonly mock = new MockLlmProvider();
  constructor(
    readonly name: string,
    private readonly behaviour: () => Promise<string>,
  ) {}
  isConfigured() {
    return true;
  }
  async generate(_prompt: string, _opts?: LlmGenerateOptions) {
    this.calls++;
    return this.behaviour();
  }
  chat(req: ChatRequest) {
    return this.mock.chat(req);
  }
  chatStream(req: ChatRequest) {
    return this.mock.chatStream(req);
  }
}

const fail = (kind: LlmErrorKind, status: number | null = null) => () =>
  Promise.reject(new LlmProviderError({ provider: "primary", kind, status, detail: `${kind}` }));

function wrap(primary: FakeProvider, fallback: FakeProvider) {
  const logs: string[] = [];
  const p = new FailoverLlmProvider(primary, fallback, {
    workload: "bulk",
    primaryModel: "gpt-5-nano",
    fallbackModel: "claude-haiku-4-5",
    log: (m) => logs.push(m),
  });
  return { p, logs };
}

describe("FailoverLlmProvider", () => {
  beforeEach(() => __resetFailoverLog());

  it("reports as the primary and never calls the fallback on success", async () => {
    const primary = new FakeProvider("openai-compatible", async () => "primary text");
    const fallback = new FakeProvider("anthropic", async () => "fallback text");
    const { p, logs } = wrap(primary, fallback);
    assert.equal(p.name, "openai-compatible");
    assert.equal(p.isLive, true);
    assert.equal(p.fallbackModel, "claude-haiku-4-5");
    assert.equal(await p.generate("x"), "primary text");
    assert.equal(fallback.calls, 0);
    assert.equal(logs.length, 0);
    assert.equal(lastFailover("bulk"), null);
  });

  for (const [kind, status] of [
    ["rate_limit", 429],
    ["server", 503],
    ["timeout", null],
    ["network", null],
  ] as const) {
    it(`fails over on ${kind}, logs and records the reason`, async () => {
      const primary = new FakeProvider("openai-compatible", fail(kind, status));
      const fallback = new FakeProvider("anthropic", async () => "fallback text");
      const { p, logs } = wrap(primary, fallback);
      assert.equal(await p.generate("x"), "fallback text");
      assert.equal(primary.calls, 1);
      assert.equal(fallback.calls, 1);
      assert.equal(logs.length, 1);
      assert.match(logs[0], new RegExp(`workload=bulk model="gpt-5-nano" failed: ${kind}`));
      assert.match(logs[0], /failing over to "claude-haiku-4-5"/);
      const ev = lastFailover("bulk");
      assert.ok(ev);
      assert.equal(ev.fallbackModel, "claude-haiku-4-5");
      assert.ok(ev.reason.startsWith(kind));
    });
  }

  for (const kind of ["client", "empty"] as const) {
    it(`does not fail over on ${kind} (4xx / non-retryable)`, async () => {
      const primary = new FakeProvider("openai-compatible", fail(kind, kind === "client" ? 400 : 200));
      const fallback = new FakeProvider("anthropic", async () => "fallback text");
      const { p, logs } = wrap(primary, fallback);
      await assert.rejects(p.generate("x"), (e: unknown) => e instanceof LlmProviderError && e.kind === kind);
      assert.equal(fallback.calls, 0);
      assert.equal(logs.length, 0);
    });
  }

  it("does not fail over on a non-classified error (programming error)", async () => {
    const primary = new FakeProvider("openai-compatible", () => Promise.reject(new TypeError("boom")));
    const fallback = new FakeProvider("anthropic", async () => "fallback text");
    const { p } = wrap(primary, fallback);
    await assert.rejects(p.generate("x"), TypeError);
    assert.equal(fallback.calls, 0);
  });

  it("never fails over on the caller's abort", async () => {
    const ac = new AbortController();
    const reason = new Error("stopped");
    const primary = new FakeProvider("openai-compatible", () => {
      ac.abort(reason);
      // Even a retryable-looking error after Stop must not fail over.
      return Promise.reject(new LlmProviderError({ provider: "p", kind: "network", detail: "aborted" }));
    });
    const fallback = new FakeProvider("anthropic", async () => "fallback text");
    const { p, logs } = wrap(primary, fallback);
    await assert.rejects(p.generate("x", { signal: ac.signal }));
    assert.equal(fallback.calls, 0);
    assert.equal(logs.length, 0);
  });

  it("when both fail, the error keeps the fallback's class and names the failover", async () => {
    const primary = new FakeProvider("openai-compatible", fail("server", 503));
    const fallback = new FakeProvider("anthropic", () =>
      Promise.reject(new LlmProviderError({ provider: "anthropic", kind: "rate_limit", status: 429, detail: "HTTP 429" })),
    );
    const { p } = wrap(primary, fallback);
    await assert.rejects(p.generate("x"), (e: unknown) => {
      assert.ok(e instanceof LlmProviderError);
      assert.equal(e.provider, "anthropic");
      assert.equal(e.kind, "rate_limit");
      assert.match(e.message, /after failover from "gpt-5-nano": server \(HTTP 503\)/);
      return true;
    });
  });
});
