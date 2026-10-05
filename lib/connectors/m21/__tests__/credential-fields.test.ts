// Phase 14 (connectors): per-connector credential field schemas — the
// generic api-key route stores exactly the declared fields, refuses OAuth-only
// and no-auth connectors, and every field name is one the adapter reads.
// Run: npx tsx --test lib/connectors/m21/__tests__/credential-fields.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_KEY_MODE, credentialModesFor, parseCredentialFields, publicCredentialModes } from "../credential-fields";
import { BUILT_IN_CONNECTORS, getBuiltinMeta } from "../registry";

const meta = (key: string) => getBuiltinMeta(key);
const ROOT = join(__dirname, "..", "..", "..", "..");

describe("credential modes per connector", () => {
  it("every api_key connector has at least one mode; OAuth-only and no-auth connectors have none", () => {
    for (const m of BUILT_IN_CONNECTORS) {
      const modes = credentialModesFor(m);
      if (m.authType === "api_key") assert.ok(modes.length > 0, m.key);
      else if (m.key !== "shopify") assert.deepEqual(modes, [], m.key);
    }
    // Shopify is OAuth (hosted app) AND has the single-store alternative.
    assert.deepEqual(credentialModesFor(meta("shopify")).map((x) => x.id), ["client_credentials", "admin_token"]);
  });

  it("declares the fields the brief names", () => {
    const fields = (key: string, mode?: string) => (credentialModesFor(meta(key)).find((x) => !mode || x.id === mode)?.fields ?? []).map((f) => `${f.name}:${f.kind}:${f.required ? "req" : "opt"}`);
    assert.deepEqual(fields("wordpress"), ["baseUrl:url:req", "username:text:req", "apiKey:secret:req"]);
    assert.deepEqual(fields("dataforseo"), ["apiKey:text:req", "password:secret:req"]);
    assert.deepEqual(fields("shopify", "client_credentials"), ["shop:shop_domain:req", "client_id:text:req", "client_secret:secret:req"]);
    assert.deepEqual(fields("shopify", "admin_token"), ["shop:shop_domain:req", "access_token:secret:req", "webhook_secret:secret:opt"]);
    // Single-key connectors are unchanged: one apiKey.
    for (const key of ["resend", "supabase", "netlify"]) assert.deepEqual(fields(key), ["apiKey:secret:req"], key);
  });

  it("every declared field is read by the connector's adapter (field name = payload key)", () => {
    const sources: Record<string, string> = {
      wordpress: "lib/connectors/m21/native/wordpress.ts",
      dataforseo: "lib/connectors/m21/native/dataforseo.ts",
      resend: "lib/connectors/m21/native/resend.ts",
      supabase: "lib/connectors/m21/native/supabase.ts",
    };
    for (const [key, file] of Object.entries(sources)) {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const mode of credentialModesFor(meta(key))) {
        for (const f of mode.fields) assert.match(src, new RegExp(`\\.${f.name}\\b`), `${key}: adapter never reads payload.${f.name}`);
      }
    }
    // Shopify: shopifyAuthFrom reads access_token + shop; tierw reads webhook_secret.
    assert.match(readFileSync(join(ROOT, "lib/connectors/m21/native/shopify.ts"), "utf8"), /payload\?\.access_token[\s\S]*payload\?\.shop/);
    assert.match(readFileSync(join(ROOT, "lib/substrate/graph/connectors/tierw.ts"), "utf8"), /payload\?\.webhook_secret/);
  });

  it("the public modes carry no secret values", () => {
    const modes = publicCredentialModes(meta("shopify"));
    assert.ok(!JSON.stringify(modes).includes("shpat_x"));
    assert.equal(publicCredentialModes(meta("ga4")).length, 0);
  });
});

describe("parseCredentialFields", () => {
  it("WordPress: stores exactly baseUrl + username + application password", () => {
    const r = parseCredentialFields(meta("wordpress"), { fields: { baseUrl: " https://blog.example.com/ ", username: " ada ", apiKey: " abcd efgh " } });
    assert.ok(r.ok);
    assert.deepEqual(r.values, { baseUrl: "https://blog.example.com", username: "ada", apiKey: " abcd efgh " });
    assert.equal(r.mode.id, "application_password");
  });

  it("WordPress: refuses a missing field, a bad URL, credentials in the URL and unknown fields", () => {
    assert.match(String((parseCredentialFields(meta("wordpress"), { fields: { baseUrl: "https://x.test", apiKey: "k" } }) as { error: string }).error), /Username is required/);
    assert.match(String((parseCredentialFields(meta("wordpress"), { fields: { baseUrl: "not a url", username: "a", apiKey: "k" } }) as { error: string }).error), /full URL/);
    assert.match(String((parseCredentialFields(meta("wordpress"), { fields: { baseUrl: "ftp://x.test", username: "a", apiKey: "k" } }) as { error: string }).error), /http\(s\)/);
    assert.match(String((parseCredentialFields(meta("wordpress"), { fields: { baseUrl: "https://u:p@x.test", username: "a", apiKey: "k" } }) as { error: string }).error), /username or password/);
    assert.match(String((parseCredentialFields(meta("wordpress"), { fields: { baseUrl: "https://x.test", username: "a", apiKey: "k", token: "t" } }) as { error: string }).error), /Unexpected field.*token/);
  });

  it("DataForSEO: login + password; a lone legacy apiKey is refused (it can't go live)", () => {
    const ok = parseCredentialFields(meta("dataforseo"), { fields: { apiKey: "login@x.test", password: "pw" } });
    assert.ok(ok.ok);
    assert.deepEqual(ok.values, { apiKey: "login@x.test", password: "pw" });
    const legacy = parseCredentialFields(meta("dataforseo"), { legacyApiKey: "login@x.test" });
    assert.equal(legacy.ok, false);
    assert.match((legacy as { error: string }).error, /API password is required/);
  });

  it("single-key connectors accept the legacy { apiKey } body unchanged (whitespace kept)", () => {
    const r = parseCredentialFields(meta("resend"), { legacyApiKey: " re_123 " });
    assert.ok(r.ok);
    assert.deepEqual(r.values, { apiKey: " re_123 " });
    assert.equal(parseCredentialFields(meta("resend"), { legacyApiKey: "   " }).ok, false);
  });

  it("refuses OAuth-only and no-auth connectors (authType is validated)", () => {
    const r = parseCredentialFields(meta("ga4"), { legacyApiKey: "x" });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /connects with OAuth/);
    assert.equal(parseCredentialFields({ key: "x", authType: "none" }, { legacyApiKey: "x" }).ok, false);
    assert.deepEqual(credentialModesFor({ key: "y", authType: "api_key" }), [API_KEY_MODE]);
  });

  it("Shopify: client credentials by default, store domain normalized; unknown mode refused", () => {
    const r = parseCredentialFields(meta("shopify"), { fields: { shop: "https://My-Store.myshopify.com/admin", client_id: "cid", client_secret: "csecret" } });
    assert.ok(r.ok);
    assert.equal(r.mode.id, "client_credentials");
    assert.deepEqual(r.values, { shop: "my-store.myshopify.com", client_id: "cid", client_secret: "csecret" });
    const bad = parseCredentialFields(meta("shopify"), { fields: { shop: "evil.example.com", client_id: "c", client_secret: "s" } });
    assert.match((bad as { error: string }).error, /myshopify\.com/);
    const tok = parseCredentialFields(meta("shopify"), { mode: "admin_token", fields: { shop: "my-store", access_token: "shpat_x" } });
    assert.ok(tok.ok);
    assert.deepEqual(tok.values, { shop: "my-store.myshopify.com", access_token: "shpat_x" });
    assert.match((parseCredentialFields(meta("shopify"), { mode: "oauth", fields: {} }) as { error: string }).error, /Unknown connection mode/);
  });

  it("refuses non-string values and over-long fields", () => {
    assert.equal(parseCredentialFields(meta("resend"), { fields: { apiKey: 5 as unknown as string } }).ok, false);
    assert.equal(parseCredentialFields(meta("wordpress"), { fields: { baseUrl: `https://x.test/${"a".repeat(600)}`, username: "a", apiKey: "k" } }).ok, false);
  });
});
