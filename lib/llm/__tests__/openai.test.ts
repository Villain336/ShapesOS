// ShapesOS — Phase 6: OpenAI-compatible adapter reliability (offline).
// Run: npx tsx --test lib/llm/__tests__/openai.test.ts
//
// Every request goes to a stub fetch; nothing touches the network. The live
// API behaviour these assert (no temperature for GPT-5, max_completion_tokens,
// service_tier "flex") follows the OpenAI docs as read on 2026-10-04 and is
// UNVERIFIED against the live API from this sandbox.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAiCompatibleLlmProvider,
  OPENAI_DEFAULT_TIMEOUT_MS,
  OPENAI_FLEX_TIMEOUT_MS,
  buildChatCompletionsBody,
  isReasoningModel,
  parseOpenAiModel,
} from "../openai";
import { LlmProviderError, parseRetryAfter } from "../errors";

const KEY = "test-openai-key-ABCDEFGHIJKLMNOPQRSTUVWX";

type Step =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { reject: Error }
  | { hang: true };

function stubFetch(steps: Step[]) {
  const calls: Array<{ url: string; body: Record<string, unknown>; signal?: AbortSignal | null; auth?: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      signal: init?.signal,
      auth: (init?.headers as Record<string, string>)?.Authorization,
    });
    if ("reject" in step) throw step.reject;
    if ("hang" in step) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (text: string) => ({ status: 200, body: { choices: [{ message: { content: text }, finish_reason: "stop" }] } });

function provider(
  model: string,
  steps: Step[],
  extra: Partial<ConstructorParameters<typeof OpenAiCompatibleLlmProvider>[3]> = {},
) {
  const f = stubFetch(steps);
  const sleeps: number[] = [];
  const p = new OpenAiCompatibleLlmProvider(KEY, model, "https://llm.example.test/v1/", {
    fetchImpl: f.impl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
  return { p, calls: f.calls, sleeps };
}

describe("request shape per model family", () => {
  it("GPT-5 family: no temperature, max_completion_tokens, no max_tokens", () => {
    const b = buildChatCompletionsBody("gpt-5-nano", "hi", 2048, false);
    assert.equal(b.model, "gpt-5-nano");
    assert.equal(b.max_completion_tokens, 2048);
    assert.equal("max_tokens" in b, false);
    assert.equal("temperature" in b, false);
    assert.equal("service_tier" in b, false);
    const b2 = buildChatCompletionsBody("gpt-5.4-nano", "hi", 100, false);
    assert.equal("temperature" in b2, false);
    assert.equal(b2.max_completion_tokens, 100);
  });

  it(":flex is a routing alias: base model + service_tier flex", () => {
    const b = buildChatCompletionsBody("gpt-5-nano:flex", "hi", 512, false);
    assert.equal(b.model, "gpt-5-nano");
    assert.equal(b.service_tier, "flex");
    assert.equal("temperature" in b, false);
    assert.deepEqual(parseOpenAiModel("gpt-5-nano:flex", false), { wireModel: "gpt-5-nano", serviceTier: "flex" });
  });

  it("hosted non-reasoning (grandfathered legacy) keeps temperature, uses max_completion_tokens", () => {
    const b = buildChatCompletionsBody("gpt-4o-mini", "hi", 64, false);
    assert.equal(b.temperature, 0.7);
    assert.equal(b.max_completion_tokens, 64);
    assert.equal("max_tokens" in b, false);
  });

  it("self-host keeps max_tokens + temperature and never strips a :tag", () => {
    const b = buildChatCompletionsBody("qwen3:27b", "hi", 300, true);
    assert.equal(b.model, "qwen3:27b");
    assert.equal(b.max_tokens, 300);
    assert.equal(b.temperature, 0.7);
    assert.equal("max_completion_tokens" in b, false);
    const f = buildChatCompletionsBody("my-model:flex", "hi", 300, true);
    assert.equal(f.model, "my-model:flex");
    assert.equal("service_tier" in f, false);
  });

  it("reasoning-model detection", () => {
    for (const m of ["gpt-5-nano", "gpt-5.4-nano", "GPT-5", "o3-mini", "o4"]) assert.equal(isReasoningModel(m), true, m);
    for (const m of ["gpt-4o-mini", "qwen3.8-27b", "claude-haiku-4-5"]) assert.equal(isReasoningModel(m), false, m);
  });

  it("timeouts: standard vs flex vs override", () => {
    assert.equal(new OpenAiCompatibleLlmProvider(KEY, "gpt-5-nano", "x").getTimeoutMs(), OPENAI_DEFAULT_TIMEOUT_MS);
    assert.equal(new OpenAiCompatibleLlmProvider(KEY, "gpt-5-nano:flex", "x").getTimeoutMs(), OPENAI_FLEX_TIMEOUT_MS);
    assert.ok(OPENAI_FLEX_TIMEOUT_MS > OPENAI_DEFAULT_TIMEOUT_MS);
    assert.equal(new OpenAiCompatibleLlmProvider(KEY, "gpt-5-nano", "x", { timeoutMs: 5 }).getTimeoutMs(), 5);
  });
});

describe("generate(): wire behaviour", () => {
  it("posts the built body to /chat/completions with bearer auth and trims output", async () => {
    const { p, calls } = provider("gpt-5-nano:flex", [ok("  hello  ")]);
    assert.equal(await p.generate("prompt", { maxTokens: 77 }), "hello");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://llm.example.test/v1/chat/completions");
    assert.equal(calls[0].auth, `Bearer ${KEY}`);
    assert.equal(calls[0].body.model, "gpt-5-nano");
    assert.equal(calls[0].body.service_tier, "flex");
    assert.equal(calls[0].body.max_completion_tokens, 77);
    assert.ok(calls[0].signal, "every request carries a timeout signal");
  });

  it("unconfigured provider throws a non-retryable classified error", async () => {
    const p = new OpenAiCompatibleLlmProvider("", "gpt-5-nano", "x");
    await assert.rejects(p.generate("hi"), (e: unknown) => e instanceof LlmProviderError && !e.retryable && /not configured/.test(e.message));
  });
});

describe("generate(): retry and classification", () => {
  it("429 then 200: one retry, honours Retry-After", async () => {
    const { p, calls, sleeps } = provider("gpt-5-nano", [
      { status: 429, body: { error: { code: "rate_limit_exceeded" } }, headers: { "retry-after": "2" } },
      ok("second time"),
    ]);
    assert.equal(await p.generate("hi"), "second time");
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  it("retry-after-ms wins over retry-after", () => {
    const h = new Headers({ "retry-after-ms": "1500", "retry-after": "9" });
    assert.equal(parseRetryAfter(h), 1500);
    const d = new Headers({ "retry-after": new Date(Date.now() + 4000).toUTCString() });
    const ms = parseRetryAfter(d)!;
    assert.ok(ms > 2000 && ms <= 4000, String(ms));
    assert.equal(parseRetryAfter(new Headers()), null);
  });

  it("5xx twice: exactly one retry (bounded), then a retryable server error", async () => {
    const { p, calls, sleeps } = provider("gpt-5-nano", [{ status: 503 }, { status: 502 }, ok("never")]);
    await assert.rejects(p.generate("hi"), (e: unknown) => {
      assert.ok(e instanceof LlmProviderError);
      assert.equal(e.kind, "server");
      assert.equal(e.status, 502);
      assert.equal(e.retryable, true);
      return true;
    });
    assert.equal(calls.length, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 500 && sleeps[0] <= 1000, `backoff ${sleeps[0]}`);
  });

  it("4xx is not retried and not retryable", async () => {
    const { p, calls } = provider("gpt-5-nano", [
      { status: 400, body: { error: { code: "unsupported_parameter", message: "nope" } } },
      ok("never"),
    ]);
    await assert.rejects(p.generate("hi"), (e: unknown) => {
      assert.ok(e instanceof LlmProviderError);
      assert.equal(e.kind, "client");
      assert.equal(e.retryable, false);
      assert.match(e.message, /HTTP 400 \(unsupported_parameter\)/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("a Retry-After beyond the cap skips the retry (failover takes over)", async () => {
    const { p, calls } = provider("gpt-5-nano", [{ status: 429, headers: { "retry-after": "120" } }, ok("never")]);
    await assert.rejects(p.generate("hi"), (e: unknown) => e instanceof LlmProviderError && e.kind === "rate_limit" && e.retryAfterMs === 120000);
    assert.equal(calls.length, 1);
  });

  it("network failure is retryable and retried once", async () => {
    const { p, calls } = provider("gpt-5-nano", [{ reject: new TypeError("fetch failed") }, ok("recovered")]);
    assert.equal(await p.generate("hi"), "recovered");
    assert.equal(calls.length, 2);
    const { p: p2 } = provider("gpt-5-nano", [{ reject: new TypeError("fetch failed") }]);
    await assert.rejects(p2.generate("hi"), (e: unknown) => e instanceof LlmProviderError && e.kind === "network" && e.retryable);
  });

  it("our own timeout is a retryable timeout error", async () => {
    const { p, calls } = provider("gpt-5-nano", [{ hang: true }], { timeoutMs: 30 });
    await assert.rejects(p.generate("hi"), (e: unknown) => e instanceof LlmProviderError && e.kind === "timeout" && e.retryable);
    assert.equal(calls.length, 2, "timed out, retried once, timed out again");
  });

  it("empty reply after the token cap names the cause (not retryable)", async () => {
    const { p } = provider("gpt-5-nano", [{ status: 200, body: { choices: [{ message: { content: "" }, finish_reason: "length" }] } }]);
    await assert.rejects(p.generate("hi"), (e: unknown) => e instanceof LlmProviderError && e.kind === "empty" && !e.retryable && /raise maxTokens/.test(e.message));
    const { p: p2 } = provider("gpt-5-nano", [{ status: 200, body: { choices: [] } }]);
    await assert.rejects(p2.generate("hi"), /empty response/);
  });
});

describe("generate(): abort (Phase 5 Stop)", () => {
  it("caller abort mid-request surfaces as the abort reason, no retry", async () => {
    const ac = new AbortController();
    const { p, calls } = provider("gpt-5-nano", [{ hang: true }], { timeoutMs: 60_000 });
    const reason = new Error("run stopped");
    setTimeout(() => ac.abort(reason), 10);
    await assert.rejects(p.generate("hi", { signal: ac.signal }), (e: unknown) => e === reason);
    assert.equal(calls.length, 1);
  });

  it("abort during the retry backoff stops immediately", async () => {
    const ac = new AbortController();
    const reason = new Error("stopped during backoff");
    const f = stubFetch([{ status: 503 }, ok("never")]);
    const p = new OpenAiCompatibleLlmProvider(KEY, "gpt-5-nano", "https://x.test", {
      fetchImpl: f.impl,
      backoffMs: 20_000, // real abortable sleep (10–20 s, under the 30 s cap)
    });
    setTimeout(() => ac.abort(reason), 20);
    await assert.rejects(p.generate("hi", { signal: ac.signal }), (e: unknown) => e === reason);
    assert.equal(f.calls.length, 1);
  });
});

describe("no key material in errors (T3)", () => {
  it("never echoes the key or the error body text", async () => {
    const leaky = { error: { message: `Incorrect API key provided: ${KEY}`, code: "invalid_api_key" } };
    for (const status of [401, 429, 500]) {
      const { p } = provider("gpt-5-nano", [{ status, body: leaky }], { maxRetries: 0 });
      await assert.rejects(p.generate("hi"), (e: unknown) => {
        const msg = (e as Error).message;
        assert.ok(!msg.includes(KEY), msg);
        assert.ok(!msg.includes("Incorrect API key"), msg);
        return true;
      });
    }
    const { p } = provider("gpt-5-nano", [{ reject: new Error(`connect failed for ${KEY}`) }], { maxRetries: 0 });
    await assert.rejects(p.generate("hi"), (e: unknown) => !(e as Error).message.includes(KEY));
  });
});
