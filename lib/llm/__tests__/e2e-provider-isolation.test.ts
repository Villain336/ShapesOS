// ShapesOS - the e2e suite must never reach a real model provider.
// scripts/e2e/run.sh starts the app with the env it exports; this reads those
// exports (not a copy) and asserts what the router does with exactly that env:
// every workload falls back to the mock provider, and the base URLs are loopback.
// Run: npx tsx --test lib/llm/__tests__/e2e-provider-isolation.test.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LLM_WORKLOADS, openAiApiKey, openAiBaseUrl, resolveWorkload } from "../router";

const script = readFileSync("scripts/e2e/run.sh", "utf8");

/** `export NAME="value"` lines of run.sh with a literal value (no ${...} defaults, no $(...)). */
function literalExports(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of script.matchAll(/^export ([A-Z0-9_]+)="([^"$`]*)"\s*$/gm)) out[m[1]] = m[2];
  return out;
}

const WATCHED = [
  "LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_MODEL", "LLM_MODEL_COPY", "LLM_MODEL_BULK",
  "LLM_MODEL_BACKGROUND", "LLM_MODEL_LEAD", "LLM_MODEL_SUBAGENT", "LLM_MODEL_CODE", "LLM_MODEL_CODE_MAX",
  "LLM_SELF_HOST", "LLM_BASE_URL", "OPENAI_BASE_URL", "LLM_FAILOVER",
];
const saved: Record<string, string | undefined> = {};
const realWarn = console.warn;

beforeEach(() => {
  for (const k of WATCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  console.warn = () => undefined;
});
afterEach(() => {
  for (const k of WATCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  console.warn = realWarn;
});

describe("e2e provider-network isolation (scripts/e2e/run.sh)", () => {
  it("forces every credential and model override empty, never inheriting the caller's", () => {
    const ex = literalExports();
    for (const k of ["LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_MODEL", "LLM_MODEL_LEAD", "LLM_MODEL_SUBAGENT", "LLM_MODEL_CODE", "LLM_MODEL_CODE_MAX", "LLM_MODEL_BULK", "LLM_MODEL_COPY", "LLM_MODEL_BACKGROUND", "LLM_SELF_HOST"]) {
      assert.equal(ex[k], "", `${k} must be forced to the empty string`);
    }
    assert.ok(!/\$\{(LLM_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)[:-]/.test(script), "no key may fall back to an inherited value");
    assert.ok(!/e2e-no-llm/.test(script), "the placeholder key counts as a real OpenAI key to the router");
  });

  it("points both base URLs at loopback", () => {
    const ex = literalExports();
    for (const k of ["LLM_BASE_URL", "OPENAI_BASE_URL"]) {
      assert.match(ex[k] ?? "", /^http:\/\/127\.0\.0\.1:\d+$/, `${k} must be loopback`);
    }
  });

  it("with exactly that env, every workload resolves to the mock provider (no live provider, no network)", () => {
    // Start from a hostile shell: real-looking keys in the caller's env must be overwritten by run.sh.
    process.env.OPENAI_API_KEY = "sk-inherited-should-be-blanked";
    process.env.ANTHROPIC_API_KEY = "inherited-should-be-blanked";
    Object.assign(process.env, literalExports());
    assert.equal(openAiApiKey(), "");
    assert.match(openAiBaseUrl(), /^http:\/\/127\.0\.0\.1:/);
    for (const w of LLM_WORKLOADS) {
      const r = resolveWorkload(w);
      assert.equal(r.provider.name, "mock", `${w} must be mock`);
      assert.equal(r.provider.isLive, false, `${w} must not be live`);
      assert.equal(r.keySource, null, `${w} must carry no key`);
    }
  });

  it("control: the old placeholder env did route live (this is what the test guards against)", () => {
    process.env.LLM_API_KEY = "e2e-no-llm";
    process.env.LLM_MODEL = "e2e-no-model";
    const lead = resolveWorkload("lead");
    assert.equal(lead.provider.isLive, true);
  });
});
