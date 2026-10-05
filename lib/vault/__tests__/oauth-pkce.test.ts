// Phase 11 (devtools): OAuth vault extensions — PKCE (S256, verifier sealed
// inside the AES-GCM state), the "json" and "form_basic" token-request
// styles, and the code exchange sending code_verifier. No network, no DB.
// Run: npx tsx --test lib/vault/__tests__/oauth-pkce.test.ts

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildTokenRequest, parseOAuthState, pkceChallenge, startOAuthFlow, OAUTH_CONFIGS, type OAuthProviderConfig } from "../oauth";
import { exchangeCodeForTokens } from "../callback";
import { jsonResponse, scriptedFetch } from "@/lib/connectors/m21/live/__tests__/fixtures";

before(() => {
  process.env.MARKETR_CREDENTIALS_KEY ||= "0".repeat(64);
});

const PKCE_CFG: OAuthProviderConfig = {
  authorizeUrl: "https://provider.example.com/authorize",
  tokenUrl: "https://provider.example.com/token",
  scopes: ["a", "b"],
  clientIdEnv: "PKCE_TEST_CLIENT_ID",
  clientSecretEnv: "PKCE_TEST_CLIENT_SECRET",
  tokenRequest: "form_basic",
  pkce: true,
};

describe("PKCE", () => {
  it("pkceChallenge is the RFC 7636 S256 transform (appendix B vector)", () => {
    assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("startOAuthFlow adds code_challenge (S256) and seals the verifier in the encrypted state", () => {
    // Airtable is the registered PKCE provider.
    assert.equal(OAUTH_CONFIGS.airtable.pkce, true);
    const prev = process.env.AIRTABLE_OAUTH_CLIENT_ID;
    process.env.AIRTABLE_OAUTH_CLIENT_ID = "air-client";
    try {
      const { url, state } = startOAuthFlow("u1", "ws1", "airtable", "https://app.example.com");
      const u = new URL(url);
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      const challenge = u.searchParams.get("code_challenge") ?? "";
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      const parsed = parseOAuthState(state);
      assert.match(parsed.cv ?? "", /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!url.includes(parsed.cv!), "the verifier itself never appears in the URL");
      assert.equal(createHash("sha256").update(parsed.cv!).digest("base64url"), challenge);
      // A second flow gets a fresh verifier.
      const again = parseOAuthState(startOAuthFlow("u1", "ws1", "airtable", "https://app.example.com").state);
      assert.notEqual(again.cv, parsed.cv);
    } finally {
      if (prev === undefined) delete process.env.AIRTABLE_OAUTH_CLIENT_ID;
      else process.env.AIRTABLE_OAUTH_CLIENT_ID = prev;
    }
  });

  it("non-PKCE providers carry no verifier", () => {
    process.env.LINEAR_OAUTH_CLIENT_ID ||= "lin";
    const { url, state } = startOAuthFlow("u1", "ws1", "linear", "https://app.example.com");
    assert.equal(new URL(url).searchParams.get("code_challenge"), null);
    assert.equal(parseOAuthState(state).cv, undefined);
  });

  it("the code exchange sends code_verifier", async () => {
    // Test-only env names (bracket access: they are not app config).
    const env = process.env as Record<string, string | undefined>;
    env[PKCE_CFG.clientIdEnv] = "cid";
    env[PKCE_CFG.clientSecretEnv] = "csecret";
    const f = scriptedFetch([jsonResponse(200, { access_token: "at", refresh_token: "rt", expires_in: 3600 })]);
    const tok = await exchangeCodeForTokens(PKCE_CFG, "pkce-test", "the-code", "https://app.example.com/cb", f.fetchImpl, "verifier-123");
    assert.equal(tok.access_token, "at");
    const body = f.calls[0].body as Record<string, string>;
    assert.equal(body.code_verifier, "verifier-123");
    assert.equal(body.grant_type, "authorization_code");
    assert.equal(body.client_secret, undefined, "form_basic keeps the secret out of the body");
    assert.equal(f.calls[0].headers.authorization, `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
  });
});

describe("token request styles", () => {
  it("json: JSON body with the client credentials (Atlassian)", () => {
    const init = buildTokenRequest({ tokenRequest: "json" }, { grant_type: "refresh_token", refresh_token: "r" }, "id", "sec");
    assert.equal((init.headers as Record<string, string>)["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(init.body)), { grant_type: "refresh_token", refresh_token: "r", client_id: "id", client_secret: "sec" });
  });

  it("form_basic: form body without the secret + Basic auth (Airtable)", () => {
    const init = buildTokenRequest({ tokenRequest: "form_basic" }, { grant_type: "refresh_token", refresh_token: "r" }, "id", "sec");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(headers.Authorization, `Basic ${Buffer.from("id:sec").toString("base64")}`);
    assert.deepEqual(Object.fromEntries(init.body as URLSearchParams), { grant_type: "refresh_token", refresh_token: "r" });
  });

  it("default form style is unchanged", () => {
    const init = buildTokenRequest({}, { grant_type: "authorization_code", code: "c" }, "id", "sec");
    assert.deepEqual(Object.fromEntries(init.body as URLSearchParams), { grant_type: "authorization_code", code: "c", client_id: "id", client_secret: "sec" });
  });
});
