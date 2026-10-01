// Marketr — Phase 18 slice 2 tests: Amazon Ads OAuth round-trip.
// Run: npx tsx --test lib/adplatforms/amazon/__tests__/oauth.test.ts
//
// The full callback: state validation → code exchange → vault storage →
// profile linking, against a mocked token endpoint and stub stores. No live
// Amazon credentials are used anywhere.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { secrets } from "@/lib/secrets";
import { startAdsOAuth, parseAdsOAuthState, vaultTokenRef, AdsOAuthError } from "../../oauth";
import {
  exchangeAmazonCode,
  handleAmazonOAuthCallback,
  type AmazonCallbackStore,
} from "../callback";
import { parseTokenRef, AmazonTokenError } from "../tokens";

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const PROFILES_URL = "https://advertising-api.amazon.com/v2/profiles";

function setTestEnv() {
  process.env.AMAZON_ADS_CLIENT_ID = "test-client-id";
  process.env.AMAZON_ADS_CLIENT_SECRET = "test-client-secret";
  // Test-only envelope key (never a real credential).
  process.env.MARKETR_CREDENTIALS_KEY = "0".repeat(64);
}

const savedEnv = { ...process.env };
beforeEach(() => setTestEnv());
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  Object.assign(process.env, savedEnv);
});

function mockFetch(routes: Record<string, { status?: number; json: unknown }>) {
  const calls: { url: string; body: URLSearchParams | undefined }[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    let body: URLSearchParams | undefined;
    if (init?.body instanceof URLSearchParams) body = init.body;
    calls.push({ url: u, body });
    const route = routes[u] ?? routes["*"];
    const status = route?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.json ?? {},
      text: async () => JSON.stringify(route?.json ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stubStore() {
  const connections: { id: string; blob: string }[] = [];
  const accounts: { id: string; externalAccountId: string; tokenRef: string }[] = [];
  let n = 0;
  const store: AmazonCallbackStore = {
    async storeTokens({ token }) {
      const id = `conn_${++n}`;
      // Mirror the production vault write: AES-256-GCM envelope, never plaintext.
      const blob = secrets().encrypt(
        JSON.stringify({ access_token: token.access_token, refresh_token: token.refresh_token }),
      );
      connections.push({ id, blob });
      return { id };
    },
    async linkAccount({ externalAccountId, tokenRef }) {
      const id = `acct_${++n}`;
      accounts.push({ id, externalAccountId, tokenRef });
      return { id };
    },
  };
  return { store, connections, accounts };
}

function validState() {
  return startAdsOAuth("amazon", "user_1", "ws_1", "https://marketr.test").state;
}

describe("parseAdsOAuthState", () => {
  it("round-trips a state built by startAdsOAuth", () => {
    const state = validState();
    const parsed = parseAdsOAuthState(state, "amazon-ads");
    assert.equal(parsed.userId, "user_1");
    assert.equal(parsed.workspaceId, "ws_1");
    assert.equal(parsed.connectorKey, "amazon-ads");
    assert.equal(parsed.adsPlatform, "amazon");
  });

  it("rejects a tampered state", () => {
    const state = validState();
    const tampered = state.slice(0, -4) + "AAAA";
    assert.throws(
      () => parseAdsOAuthState(tampered, "amazon-ads"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "INVALID_STATE",
    );
  });

  it("rejects garbage", () => {
    assert.throws(
      () => parseAdsOAuthState("not-a-state", "amazon-ads"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "INVALID_STATE",
    );
  });

  it("rejects an expired state", () => {
    const expired = secrets().encrypt(
      JSON.stringify({
        userId: "user_1",
        workspaceId: "ws_1",
        connectorKey: "amazon-ads",
        adsPlatform: "amazon",
        exp: Date.now() - 1000,
        nonce: "n",
      }),
    );
    assert.throws(
      () => parseAdsOAuthState(expired, "amazon-ads"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "STATE_EXPIRED",
    );
  });

  it("rejects a state minted for a different connector", () => {
    const other = secrets().encrypt(
      JSON.stringify({
        userId: "user_1",
        workspaceId: "ws_1",
        connectorKey: "google-search-console",
        adsPlatform: "amazon",
        exp: Date.now() + 60000,
        nonce: "n",
      }),
    );
    assert.throws(
      () => parseAdsOAuthState(other, "amazon-ads"),
      (e: unknown) => e instanceof AdsOAuthError && e.code === "INVALID_STATE",
    );
  });
});

describe("exchangeAmazonCode", () => {
  it("posts the authorization_code grant to the LWA token endpoint", async () => {
    const { fetchImpl, calls } = mockFetch({
      [TOKEN_URL]: { json: { access_token: "tok_live_abc", refresh_token: "rt_xyz", expires_in: 3600 } },
    });
    const token = await exchangeAmazonCode("authcode_123", "https://marketr.test/api/ads/oauth/callback", fetchImpl);
    assert.equal(token.access_token, "tok_live_abc");
    assert.equal(token.refresh_token, "rt_xyz");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, TOKEN_URL);
    assert.equal(calls[0].body?.get("grant_type"), "authorization_code");
    assert.equal(calls[0].body?.get("code"), "authcode_123");
    assert.equal(calls[0].body?.get("client_id"), "test-client-id");
  });

  it("throws when the token endpoint rejects the code", async () => {
    const { fetchImpl } = mockFetch({ [TOKEN_URL]: { status: 400, json: { error: "invalid_grant" } } });
    await assert.rejects(
      () => exchangeAmazonCode("badcode", "https://marketr.test/api/ads/oauth/callback", fetchImpl),
      /Token exchange failed/,
    );
  });

  it("throws when the client secret env var is missing", async () => {
    delete process.env.AMAZON_ADS_CLIENT_SECRET;
    const { fetchImpl } = mockFetch({});
    await assert.rejects(
      () => exchangeAmazonCode("code", "https://x.test/cb", fetchImpl),
      /not configured/,
    );
  });
});

describe("handleAmazonOAuthCallback", () => {
  it("completes the round-trip: exchange → vault → one account per profile", async () => {
    const { fetchImpl } = mockFetch({
      [TOKEN_URL]: { json: { access_token: "tok_live_abc", refresh_token: "rt_xyz", expires_in: 3600 } },
      [PROFILES_URL]: {
        json: [
          { profileId: 777, countryCode: "US", currencyCode: "USD", accountInfo: { type: "seller", name: "Acme Store" } },
          { profileId: 778, countryCode: "CA", currencyCode: "CAD", accountInfo: { type: "seller" } },
        ],
      },
    });
    const { store, connections, accounts } = stubStore();
    const result = await handleAmazonOAuthCallback({
      state: validState(),
      code: "authcode_123",
      redirectUri: "https://marketr.test/api/ads/oauth/callback",
      fetchImpl,
      store,
    });

    assert.equal(result.connectionId, "conn_1");
    assert.equal(result.profileCount, 2);
    assert.equal(result.accountIds.length, 2);
    assert.equal(result.tokenRef, vaultTokenRef("amazon", "conn_1"));

    // The vault blob is encrypted: plaintext token appears only after decrypt.
    assert.equal(connections.length, 1);
    assert.ok(!connections[0].blob.includes("tok_live_abc"), "token must never sit plaintext in the vault blob");
    const decrypted = JSON.parse(secrets().decrypt(connections[0].blob)) as { access_token: string };
    assert.equal(decrypted.access_token, "tok_live_abc");

    // Accounts linked per profile with the opaque tokenRef.
    assert.deepEqual(
      accounts.map((a) => a.externalAccountId).sort(),
      ["777", "778"],
    );
    for (const a of accounts) {
      assert.equal(a.tokenRef, "vault:oauth:amazon:conn_1");
      const parsed = parseTokenRef(a.tokenRef);
      assert.equal(parsed.connectionId, "conn_1");
    }
  });

  it("rejects a bad state BEFORE any network call", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const { store } = stubStore();
    const err = await handleAmazonOAuthCallback({
      state: "garbage-state",
      code: "authcode_123",
      redirectUri: "https://marketr.test/api/ads/oauth/callback",
      fetchImpl,
      store,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AdsOAuthError && err.code === "INVALID_STATE");
    assert.equal(calls.length, 0, "no network call may precede state validation");
  });

  it("rejects a state minted for a different ads platform", async () => {
    const other = secrets().encrypt(
      JSON.stringify({
        userId: "user_1",
        workspaceId: "ws_1",
        connectorKey: "amazon-ads",
        adsPlatform: "walmart",
        exp: Date.now() + 60000,
        nonce: "n",
      }),
    );
    const { fetchImpl, calls } = mockFetch({});
    const { store } = stubStore();
    const err = await handleAmazonOAuthCallback({
      state: other,
      code: "authcode_123",
      redirectUri: "https://marketr.test/api/ads/oauth/callback",
      fetchImpl,
      store,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AdsOAuthError && err.code === "INVALID_STATE");
    assert.equal(calls.length, 0);
  });

  it("rejects a missing authorization code", async () => {
    const { fetchImpl, calls } = mockFetch({});
    const { store } = stubStore();
    const err = await handleAmazonOAuthCallback({
      state: validState(),
      code: "",
      redirectUri: "https://marketr.test/api/ads/oauth/callback",
      fetchImpl,
      store,
    }).catch((e: unknown) => e);
    assert.ok(err instanceof AdsOAuthError && err.code === "MISSING_CODE");
    assert.equal(calls.length, 0);
  });
});

describe("parseTokenRef", () => {
  it("parses the vault tokenRef scheme", () => {
    assert.deepEqual(parseTokenRef("vault:oauth:amazon:conn_9"), { platform: "amazon", connectionId: "conn_9" });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["", "conn_9", "vault:oauth:amazon", "bearer:tok_123"]) {
      assert.throws(
        () => parseTokenRef(bad),
        (e: unknown) => e instanceof AmazonTokenError && e.code === "BAD_TOKEN_REF",
        `expected BAD_TOKEN_REF for ${JSON.stringify(bad)}`,
      );
    }
  });
});
