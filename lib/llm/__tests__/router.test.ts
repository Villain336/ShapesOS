// ShapesOS — Phase 6: single-key mode, failover arming and the routing
// status the Settings → Providers page renders (offline, env-driven).
// Run: npx tsx --test lib/llm/__tests__/router.test.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_ZDR_MODELS,
  FAMILY_WORKLOAD_DEFAULTS,
  OPENAI_ZDR_MODELS,
  failoverModelFor,
  getLlmProviderFor,
  isRoutableHostedModel,
  llmRoutingStatus,
  resolveWorkload,
} from "../router";
import { FailoverLlmProvider } from "../failover";

const VARS = [
  "LLM_MODEL_COPY",
  "LLM_MODEL_BULK",
  "LLM_MODEL_BACKGROUND",
  "LLM_MODEL",
  "LLM_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LLM_BASE_URL",
  "ANTHROPIC_API_KEY",
  "LLM_SELF_HOST",
  "LLM_FAILOVER",
  "LLM_TIMEOUT_MS",
];
const saved: Record<string, string | undefined> = {};
const realWarn = console.warn;
let warnings: string[] = [];

beforeEach(() => {
  for (const k of VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  warnings = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  console.warn = realWarn;
});

const OAI = "test-openai-key-000111222333444555";
const ANT = "test-anthropic-key-666777888999000";

describe("single-key mode", () => {
  it("only an OpenAI key: copy runs live on the OpenAI copy default", () => {
    process.env.OPENAI_API_KEY = OAI;
    const copy = resolveWorkload("copy");
    assert.equal(copy.provider.name, "openai-compatible");
    assert.equal(copy.provider.isLive, true);
    assert.equal(copy.requestedModel, FAMILY_WORKLOAD_DEFAULTS.openai.copy);
    assert.equal(copy.source, "default");
    assert.equal(copy.singleKey?.from, "claude-haiku-4-5");
    assert.match(copy.singleKey!.reason, /ANTHROPIC_API_KEY is not set/);
    // bulk/background already default to OpenAI: no substitution
    assert.equal(resolveWorkload("bulk").singleKey, null);
    assert.equal(resolveWorkload("bulk").requestedModel, "gpt-5-nano");
    assert.equal(resolveWorkload("background").requestedModel, "gpt-5-nano:flex");
    // nothing on mock, nothing to fail over to
    for (const w of ["copy", "bulk", "background"] as const) {
      const s = llmRoutingStatus()[w];
      assert.equal(s.isLive, true, w);
      assert.equal(s.failover, null, w);
    }
    assert.match(llmRoutingStatus().copy.singleKey ?? "", /swapped/);
  });

  it("only an Anthropic key: bulk and background run on the Anthropic default", () => {
    process.env.ANTHROPIC_API_KEY = ANT;
    for (const w of ["bulk", "background"] as const) {
      const r = resolveWorkload(w);
      assert.equal(r.provider.name, "anthropic", w);
      assert.equal(r.requestedModel, "claude-haiku-4-5", w);
      assert.match(r.singleKey!.reason, /LLM_API_KEY\/OPENAI_API_KEY is not set/);
    }
    assert.equal(resolveWorkload("copy").singleKey, null);
    assert.equal(resolveWorkload("copy").provider.name, "anthropic");
  });

  it("an explicit env model is never swapped — it falls back to mock, loudly", () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.LLM_MODEL_COPY = "claude-haiku-4-5";
    const r = resolveWorkload("copy");
    assert.equal(r.provider.name, "mock");
    assert.equal(r.singleKey, null);
    assert.equal(r.fallbackReason, "ANTHROPIC_API_KEY is not set");
    assert.ok(warnings.some((w) => /workload=copy .*→ mock/.test(w)));
  });

  it("the legacy LLM_MODEL is explicit too: not swapped", () => {
    process.env.ANTHROPIC_API_KEY = ANT;
    process.env.LLM_MODEL = "gpt-4o-mini";
    const r = resolveWorkload("bulk");
    assert.equal(r.source, "legacy");
    assert.equal(r.provider.name, "mock");
  });

  it("an empty LLM_API_KEY no longer masks OPENAI_API_KEY", () => {
    process.env.LLM_API_KEY = "";
    process.env.OPENAI_API_KEY = OAI;
    assert.equal(getLlmProviderFor("bulk").name, "openai-compatible");
  });

  it("is off under self-host", () => {
    process.env.LLM_SELF_HOST = "1";
    process.env.LLM_API_KEY = "dummy";
    process.env.LLM_BASE_URL = "http://localhost:8000/v1";
    // copy defaults to claude-haiku-4-5; no Anthropic key, no swap to OpenAI
    const r = resolveWorkload("copy");
    assert.equal(r.singleKey, null);
    assert.equal(r.provider.name, "mock");
  });

  it("no keys at all: everything is mock with a reason", () => {
    for (const w of ["copy", "bulk", "background"] as const) {
      const s = llmRoutingStatus()[w];
      assert.equal(s.isLive, false);
      assert.ok(s.fallback);
      assert.equal(s.singleKey, null);
    }
  });
});

describe("failover arming", () => {
  it("both keys: each live workload is wrapped with the other family's default", () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    const copy = resolveWorkload("copy");
    assert.ok(copy.provider instanceof FailoverLlmProvider);
    assert.equal(copy.provider.name, "anthropic", "reports as the primary");
    assert.equal(copy.failoverModel, "gpt-5.4-nano");
    const bulk = resolveWorkload("bulk");
    assert.equal(bulk.provider.name, "openai-compatible");
    assert.equal(bulk.failoverModel, "claude-haiku-4-5");
    const st = llmRoutingStatus();
    assert.equal(st.background.failover, "claude-haiku-4-5");
    assert.equal(st.copy.failover, "gpt-5.4-nano");
  });

  it("explicit env choices are failed over too (runtime outage, not config)", () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    process.env.LLM_MODEL_COPY = "claude-opus-5";
    assert.equal(resolveWorkload("copy").failoverModel, "gpt-5.4-nano");
  });

  it("LLM_FAILOVER=0 disables it", () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    process.env.LLM_FAILOVER = "0";
    const r = resolveWorkload("bulk");
    assert.equal(r.failoverModel, null);
    assert.ok(!(r.provider instanceof FailoverLlmProvider));
  });

  it("never under self-host (prompts stay on the operator's box)", () => {
    process.env.LLM_SELF_HOST = "1";
    process.env.LLM_API_KEY = "dummy";
    process.env.ANTHROPIC_API_KEY = ANT;
    process.env.LLM_MODEL_BULK = "qwen3.8-27b";
    const r = resolveWorkload("bulk");
    assert.equal(r.provider.name, "openai-compatible");
    assert.equal(r.failoverModel, null);
    assert.equal(resolveWorkload("copy").failoverModel, null);
  });

  it("no failover for mock primaries", () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    process.env.LLM_MODEL_BULK = "deepseek-flash";
    const r = resolveWorkload("bulk");
    assert.equal(r.provider.name, "mock");
    assert.equal(r.failoverModel, null);
  });

  it("only one key: nothing to fail over to", () => {
    process.env.ANTHROPIC_API_KEY = ANT;
    assert.equal(failoverModelFor("copy", "claude-haiku-4-5"), null);
  });
});

describe("allow-list and block-list bind every substitute and fallback", () => {
  it("every family default is routable (allow-listed, not blocked)", () => {
    for (const fam of ["anthropic", "openai"] as const) {
      for (const w of ["copy", "bulk", "background"] as const) {
        assert.equal(isRoutableHostedModel(FAMILY_WORKLOAD_DEFAULTS[fam][w]), true, `${fam}/${w}`);
      }
    }
  });

  it("blocked, self-host-only and unlisted models are never routable fallbacks", () => {
    for (const m of ["deepseek-flash", "gemini-3.8-flash", "qwen3.8-27b", "claude-fable-5", "gpt-4o-mini", "bogus"]) {
      assert.equal(isRoutableHostedModel(m), false, m);
    }
    for (const m of [...ANTHROPIC_ZDR_MODELS, ...OPENAI_ZDR_MODELS]) {
      assert.equal(isRoutableHostedModel(m), true, m);
    }
  });

  it("status and warnings never carry key material", () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    process.env.LLM_MODEL_COPY = "gemini-3.8-flash";
    const blob = JSON.stringify(llmRoutingStatus()) + warnings.join("\n");
    assert.ok(!blob.includes(OAI));
    assert.ok(!blob.includes(ANT));
  });
});

describe("end to end through the router (stubbed fetch)", () => {
  it("an OpenAI 503 on bulk fails over to Anthropic and returns its text", async () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    const realFetch = globalThis.fetch;
    const hits: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      hits.push(url);
      if (url.includes("/chat/completions")) return new Response("{}", { status: 503 });
      if (url.includes("/v1/messages")) {
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "served by the fallback" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    try {
      const p = getLlmProviderFor("bulk");
      const text = await p.generate("hello", { maxTokens: 16 });
      assert.equal(text, "served by the fallback");
      assert.equal(hits.filter((h) => h.includes("/chat/completions")).length, 2, "adapter retried once");
      assert.equal(hits.filter((h) => h.includes("/v1/messages")).length, 1);
      assert.ok(warnings.some((w) => /failing over to "claude-haiku-4-5"/.test(w)));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("an OpenAI 400 is surfaced, never sent to the other vendor", async () => {
    process.env.OPENAI_API_KEY = OAI;
    process.env.ANTHROPIC_API_KEY = ANT;
    const realFetch = globalThis.fetch;
    const hits: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      hits.push(url);
      return new Response(JSON.stringify({ error: { code: "invalid_request_error" } }), { status: 400 });
    }) as typeof fetch;
    try {
      await assert.rejects(getLlmProviderFor("bulk").generate("hello"), /HTTP 400/);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].includes("/chat/completions"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
