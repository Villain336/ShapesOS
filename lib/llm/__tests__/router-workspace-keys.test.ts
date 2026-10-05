// ShapesOS Phase 15.1 — per-workspace model keys in the router (offline).
// A workspace key replaces the platform key for its family and is marked
// keySource "workspace"; the block-list, ZDR allow-lists and the retention
// opt-in apply exactly as for platform keys; a workspace OpenAI key only
// ever goes to api.openai.com and is unused under LLM_SELF_HOST=1.
// Run: npx tsx --test lib/llm/__tests__/router-workspace-keys.test.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OPENAI_OFFICIAL_BASE_URL, llmRoutingStatus, resolveWorkload } from "../router";
import { FailoverLlmProvider } from "../failover";
import { AnthropicLlmProvider } from "../anthropic";
import { OpenAiCompatibleLlmProvider } from "../openai";

const VARS = [
  "LLM_MODEL_COPY", "LLM_MODEL_BULK", "LLM_MODEL_BACKGROUND", "LLM_MODEL_LEAD", "LLM_MODEL_SUBAGENT",
  "LLM_MODEL_CODE", "LLM_MODEL_CODE_MAX", "LLM_ALLOW_RETENTION_MODELS", "LLM_MODEL", "LLM_API_KEY",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "LLM_BASE_URL", "ANTHROPIC_API_KEY", "LLM_SELF_HOST", "LLM_FAILOVER",
];
const saved: Record<string, string | undefined> = {};
const realWarn = console.warn;

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
  console.warn = () => {};
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  console.warn = realWarn;
});

const primary = (p: unknown) => (p instanceof FailoverLlmProvider ? (p as unknown as { primary: unknown }).primary : p);

describe("router with a workspace's own model keys", () => {
  it("a workspace key makes the workload live with no platform key, as keySource workspace", () => {
    assert.equal(resolveWorkload("lead").provider.isLive, false, "no platform key → mock");
    const r = resolveWorkload("lead", { workspaceKeys: { anthropic: "sk-ant-workspace" } });
    assert.equal(r.provider.isLive, true);
    assert.equal(r.keySource, "workspace");
    assert.equal(r.requestedModel, "claude-opus-5-5");
    assert.equal((r.provider as AnthropicLlmProvider).keySource, "workspace");
  });

  it("the workspace key wins over the platform key for its family; the other family stays platform", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-platform";
    process.env.OPENAI_API_KEY = "sk-platform";
    const lead = resolveWorkload("lead", { workspaceKeys: { anthropic: "sk-ant-workspace" } });
    assert.equal(lead.keySource, "workspace");
    const bulk = resolveWorkload("bulk", { workspaceKeys: { anthropic: "sk-ant-workspace" } });
    assert.equal(bulk.requestedModel, "gpt-5-nano");
    assert.equal(bulk.keySource, "platform");
    // The failover (other family) is built with that family's own source.
    const fb = (lead.provider as unknown as { fallback: OpenAiCompatibleLlmProvider }).fallback;
    assert.ok(lead.provider instanceof FailoverLlmProvider);
    assert.equal(fb.keySource, "platform");
  });

  it("single-key mode counts a workspace key (OpenAI-only workspace runs the agents on gpt-5.5)", () => {
    const r = resolveWorkload("lead", { workspaceKeys: { openai: "sk-workspace" } });
    assert.equal(r.provider.isLive, true);
    assert.equal(r.requestedModel, "gpt-5.5");
    assert.equal(r.keySource, "workspace");
  });

  it("a workspace OpenAI key always goes to api.openai.com, never an operator base URL", () => {
    process.env.OPENAI_BASE_URL = "https://proxy.operator.example/v1";
    const r = resolveWorkload("bulk", { workspaceKeys: { openai: "sk-workspace" } });
    const p = primary(r.provider) as unknown as { baseUrl: string; keySource: string };
    assert.equal(p.baseUrl, OPENAI_OFFICIAL_BASE_URL);
    assert.equal(p.keySource, "workspace");
    process.env.OPENAI_API_KEY = "sk-platform";
    const plat = primary(resolveWorkload("bulk").provider) as unknown as { baseUrl: string };
    assert.equal(plat.baseUrl, "https://proxy.operator.example/v1", "the platform key keeps the operator's base URL");
  });

  it("the block-list and ZDR allow-list still apply to BYOK", () => {
    process.env.LLM_MODEL_LEAD = "deepseek-chat";
    const blocked = resolveWorkload("lead", { workspaceKeys: { anthropic: "k", openai: "k" } });
    assert.equal(blocked.provider.isLive, false);
    assert.match(blocked.fallbackReason ?? "", /blocked/);
    process.env.LLM_MODEL_LEAD = "gpt-4o";
    const notZdr = resolveWorkload("lead", { workspaceKeys: { openai: "k" } });
    assert.equal(notZdr.provider.isLive, false);
    assert.match(notZdr.fallbackReason ?? "", /ZDR/);
  });

  it("the retention opt-in still applies to BYOK (Fable swapped for Opus at max effort)", () => {
    const r = resolveWorkload("code_max", { workspaceKeys: { anthropic: "k" } });
    assert.equal(r.requestedModel, "claude-opus-5-5");
    assert.ok(r.retention);
  });

  it("under LLM_SELF_HOST=1 a workspace OpenAI key is not used (local endpoint)", () => {
    process.env.LLM_SELF_HOST = "1";
    process.env.LLM_MODEL_BULK = "qwen3-32b";
    process.env.OPENAI_API_KEY = "local";
    const r = resolveWorkload("bulk", { workspaceKeys: { openai: "sk-workspace" } });
    assert.equal(r.keySource, "self_host");
  });

  it("routing status reports the key source per workload and never key material", () => {
    process.env.OPENAI_API_KEY = "sk-platform-secret-value";
    const status = llmRoutingStatus({ workspaceKeys: { anthropic: "sk-ant-workspace-secret-value" } });
    assert.equal(status.lead.keySource, "workspace");
    assert.equal(status.bulk.keySource, "platform");
    const json = JSON.stringify(status);
    assert.ok(!json.includes("secret-value"));
    assert.ok(primary(resolveWorkload("lead", { workspaceKeys: { anthropic: "x" } }).provider) instanceof AnthropicLlmProvider);
  });
});
