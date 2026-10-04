// Phase 6: pin the built-in connector registry so its count, its mock-only
// set and the comments describing them cannot drift apart again (they said
// "12 built-in" / "7 mock-only" long after the code moved on).
// Run: npx tsx --test lib/connectors/m21/__tests__/registry.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUILT_IN_CONNECTORS,
  MOCK_ONLY_ADAPTER_KEYS,
  hasLiveWiring,
  resolveAdapter,
} from "../registry";
import { getOAuthConfig } from "@/lib/vault/oauth";

/** The built-in connectors, in registry order. Adding one means updating this list. */
const EXPECTED_KEYS = [
  "google-search-console",
  "ga4",
  "wordpress",
  "webflow",
  "google-drive",
  "notion",
  "buffer",
  "resend",
  "dataforseo",
  "meta-ads",
  "google-ads",
  "gmail",
  "google-calendar",
  "google-business-profile",
  "outlook",
  "outlook-calendar",
  "slack",
  "hubspot",
  // Phase 11 (devtools).
  "linear",
  "jira",
  "airtable",
  "supabase",
  "netlify",
  "shopify", // Phase 11 (bizsync)
  "quickbooks", // Phase 11 (bizsync)
  "xero", // Phase 11 (bizsync)
];

const ROOT = join(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("built-in connector registry", () => {
  it("has exactly the expected built-in connectors (E2E mock provider excluded)", () => {
    assert.notEqual(process.env.E2E_MOCK_OAUTH, "1", "unit tests run without the E2E seam");
    assert.deepEqual(
      BUILT_IN_CONNECTORS.map((c) => c.key),
      EXPECTED_KEYS,
    );
    assert.equal(BUILT_IN_CONNECTORS.length, 26); // Phase 11: +5 devtools (linear, jira, airtable, supabase, netlify), +3 bizsync (shopify, quickbooks, xero)
  });

  it("every key resolves to an adapter with the same key, auth type and at least one tool", () => {
    for (const meta of BUILT_IN_CONNECTORS) {
      const adapter = resolveAdapter(meta.key);
      assert.equal(adapter.key, meta.key);
      assert.equal(adapter.authType, meta.authType, meta.key);
      const tools = adapter.listTools();
      assert.ok(tools.length > 0, meta.key);
      assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, `${meta.key}: duplicate tool names`);
    }
  });

  it("the mock-only set is exactly empty and every built-in has live wiring", () => {
    assert.deepEqual([...MOCK_ONLY_ADAPTER_KEYS], []);
    for (const key of EXPECTED_KEYS) assert.equal(hasLiveWiring(key), true, key);
  });

  it("the six Phase 6 adapters are read-only and expose a live health check", () => {
    for (const key of ["google-search-console", "ga4", "google-drive", "notion", "meta-ads", "google-ads"]) {
      const adapter = resolveAdapter(key);
      assert.equal(typeof adapter.healthCheck, "function", key);
      for (const t of adapter.listTools()) assert.equal(t.mutating, false, `${key}.${t.name} must stay read-only`);
    }
  });

  it("every oauth2 connector has a vault OAuth config with the registry's scopes", () => {
    for (const meta of BUILT_IN_CONNECTORS.filter((c) => c.authType === "oauth2")) {
      const cfg = getOAuthConfig(meta.key);
      assert.ok(cfg, `${meta.key} has no OAuth entry in lib/vault/oauth.ts (connect would throw "does not support OAuth2")`);
      assert.deepEqual(cfg.scopes, meta.oauth?.scopes ?? [], `${meta.key} scopes`);
    }
    assert.deepEqual(getOAuthConfig("google-ads")?.scopes, ["https://www.googleapis.com/auth/adwords"]);
  });

  it("the comments that state the counts match the code", () => {
    const n = BUILT_IN_CONNECTORS.length;
    const claims: Array<[string, RegExp]> = [
      ["lib/connectors/m21/registry.ts", /the (\d+) built-in\s+\/\/\s*connectors/],
      ["lib/connectors/m21/registry.ts", /All (\d+)\s+\/\/\s*built-in adapters have live wiring/],
      ["lib/connectors/m21/types.ts", /\((\d+) built-in native adapters/],
      ["lib/connectors/health.ts", /0 of the (\d+)\s+\/\/\s*built-ins are mock-only/],
      ["scripts/verify-m21-connectors.mts", /all (\d+) native adapters resolve/],
    ];
    for (const [file, re] of claims) {
      const m = re.exec(read(file));
      assert.ok(m, `${file}: count comment not found (${re})`);
      assert.equal(Number(m[1]), n, `${file} says ${m[1]}, the registry has ${n}`);
    }
    // The old drifted claims must not come back.
    for (const file of ["lib/connectors/m21/registry.ts", "lib/connectors/m21/types.ts", "lib/connectors/health.ts"]) {
      assert.doesNotMatch(read(file), /\b(12|13) built-in|\b7 mock-only/, file);
    }
  });
});
