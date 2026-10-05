// Phase 11 (conncore): no fake success in production.
//
// Enumerates (1) every built-in connector in the m21 registry, every tool,
// invoked with NO credential, and (2) every fake-by-default integration
// listed in lib/connectors/no-fakes.ts. With NODE_ENV=production (and no
// ALLOW_FAKE_PROVIDERS opt-in) each must say "not connected"; in dev/test
// the labelled mocks still work, and the demo opt-in brings them back.
// Run: npx tsx --test lib/connectors/__tests__/no-fakes.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN_CONNECTORS, resolveAdapter } from "../m21/registry";
import { FAKE_SURFACES } from "../no-fakes";

const ENV_KEYS = [
  "NODE_ENV",
  "ALLOW_FAKE_PROVIDERS",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "COMPOSIO_API_KEY",
  "MESSAGING_SMS_PROVIDER",
  "MESSAGING_EMAIL_PROVIDER",
  "CALLS_PROVIDER",
  "ENRICHMENT_PROVIDERS",
  "VIBE_TEST_MODE",
  "TESTLAB_REAL_SEND",
] as const;

let saved: Record<string, string | undefined> = {};
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const env = process.env as Record<string, string | undefined>;
  for (const k of ENV_KEYS) delete env[k];
  for (const [k, v] of Object.entries(values)) env[k] = v;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const ctx = { workspaceId: "ws_test", userId: "user_test" };

/** Plausible args for every tool so validation never masks the guard. */
function argsFor(schema: { properties: Record<string, { type: string }>; required?: string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema.properties)) {
    out[k] = v.type === "number" ? 1 : v.type === "boolean" ? false : k.toLowerCase().includes("date") ? "2026-01-01" : "x";
  }
  out.kind = "page";
  return out;
}

describe("built-in connector registry: no fake success in production", () => {
  it("every tool of every built-in connector returns not_connected without a credential", async () => {
    setEnv({ NODE_ENV: "production" });
    let checked = 0;
    for (const meta of BUILT_IN_CONNECTORS) {
      const adapter = resolveAdapter(meta.key);
      for (const tool of adapter.listTools()) {
        const res = await adapter.invoke(tool.name, argsFor(tool.argsSchema), null, ctx);
        assert.equal(res.ok, false, `${meta.key}.${tool.name} must not succeed in production without a credential`);
        assert.equal(res.errorCode, "not_connected", `${meta.key}.${tool.name}`);
        assert.notEqual(res.mock, true, `${meta.key}.${tool.name}`);
        assert.match(res.error ?? "", /is not connected/);
        checked += 1;
      }
    }
    assert.ok(checked >= BUILT_IN_CONNECTORS.length, "every connector contributed at least one tool");
  });

  it("a mock result is refused in production even with a (demo) credential", async () => {
    setEnv({ NODE_ENV: "production" });
    const wp = resolveAdapter("wordpress");
    const demoCredential = {
      kind: "api_key" as const,
      payload: { apiKey: "x", username: "u", baseUrl: "https://demo-wp.local", demo: true },
    };
    const res = await wp.invoke("test_connection", {}, demoCredential, ctx);
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, "not_connected");
  });

  it("dev/test keep the labelled mocks, and the production demo opt-in brings them back", async () => {
    for (const env of [{ NODE_ENV: "test" }, { NODE_ENV: "production", ALLOW_FAKE_PROVIDERS: "1" }]) {
      setEnv(env);
      const ga4 = resolveAdapter("ga4");
      const res = await ga4.invoke("list_properties", {}, null, ctx);
      assert.equal(res.ok, true, JSON.stringify(env));
      assert.equal(res.mock, true, "mock data stays labelled");
    }
  });
});

describe("fake-by-default integrations: not connected in production", () => {
  it("lists every audited surface once", () => {
    const keys = FAKE_SURFACES.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.length >= 20, `audit covers ${keys.length} surfaces`);
  });

  for (const surface of FAKE_SURFACES) {
    it(`${surface.label} (${surface.where}) refuses in production`, async () => {
      setEnv({ NODE_ENV: "production" });
      assert.equal(await surface.probe(), "refused");
    });
  }

  it("the same surfaces still serve labelled fakes in dev/test (the guard is what changed)", async () => {
    setEnv({ NODE_ENV: "test" });
    for (const surface of FAKE_SURFACES) {
      assert.equal(await surface.probe(), "fake", surface.key);
    }
  });
});
