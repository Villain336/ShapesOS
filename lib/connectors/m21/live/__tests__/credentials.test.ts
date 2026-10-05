// Phase 4b: vault credential loader (proactive refresh near expiry, one-shot
// refresher persisted through refreshConnection), the manual liveness probe,
// and the health verdict mapping. Prisma and the vault are stubbed.
// Run: node --import tsx --experimental-test-module-mocks --test lib/connectors/m21/live/__tests__/credentials.test.ts

import { describe, it, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { scriptedFetch, jsonResponse } from "./fixtures";

type Cred = { kind: "oauth2"; payload: Record<string, unknown> } | null;

const state = {
  credential: null as Cred,
  expiresAt: null as Date | null,
  refreshOutcome: "refreshed" as "refreshed" | "needs_reauth",
  refreshed: 0,
  connection: { connectorKey: "ga4", workspaceId: "ws", userId: "u" } as Record<string, string> | null,
};

// probeConnection builds the adapter with default deps, so safeFetch's
// address check would do a real DNS lookup: answer with a public address.
mock.module("node:dns/promises", {
  namedExports: { lookup: async () => [{ address: "142.250.80.10", family: 4 }] },
});

mock.module("@/lib/prisma", {
  namedExports: {
    prisma: {
      connectorCredential: { findUnique: async () => (state.expiresAt ? { expiresAt: state.expiresAt } : null) },
      connectorConnection: { findUnique: async () => state.connection },
    },
  },
});

mock.module("@/lib/vault/refresh", {
  namedExports: {
    getDecryptedCredential: async () => state.credential,
    refreshConnection: async () => {
      state.refreshed += 1;
      if (state.refreshOutcome === "refreshed") {
        state.credential = { kind: "oauth2", payload: { access_token: "fresh", refresh_token: "r" } };
      }
      return state.refreshOutcome;
    },
    getConnectionAuthType: async () => "oauth2",
  },
});

let loadLiveCredential: typeof import("../credentials").loadLiveCredential;
let liveCheckVerdict: typeof import("@/lib/connectors/health").liveCheckVerdict;
let probeConnection: typeof import("../probe").probeConnection;
let registry: typeof import("../../registry");

before(async () => {
  ({ loadLiveCredential } = await import("../credentials"));
  ({ liveCheckVerdict } = await import("@/lib/connectors/health"));
  ({ probeConnection } = await import("../probe"));
  registry = await import("../../registry");
});

beforeEach(() => {
  state.credential = { kind: "oauth2", payload: { access_token: "old", refresh_token: "r" } };
  state.expiresAt = null;
  state.refreshOutcome = "refreshed";
  state.refreshed = 0;
  state.connection = { connectorKey: "ga4", workspaceId: "ws", userId: "u" };
});

describe("loadLiveCredential", () => {
  it("returns the stored credential when the token is not near expiry", async () => {
    state.expiresAt = new Date(Date.now() + 10 * 60_000);
    const { credential } = await loadLiveCredential("c1");
    assert.equal(credential?.payload.access_token, "old");
    assert.equal(state.refreshed, 0);
  });

  it("refreshes up front when the token expires within 60s", async () => {
    state.expiresAt = new Date(Date.now() + 30_000);
    const { credential, refreshCredential } = await loadLiveCredential("c1");
    assert.equal(credential?.payload.access_token, "fresh");
    assert.equal(state.refreshed, 1);
    // The refresher is one-shot per invocation.
    assert.equal(await refreshCredential(), null);
    assert.equal(state.refreshed, 1);
  });

  it("a failed proactive refresh hands the adapter no credential", async () => {
    state.expiresAt = new Date(Date.now() - 1000);
    state.refreshOutcome = "needs_reauth";
    const { credential } = await loadLiveCredential("c1");
    assert.equal(credential, null);
  });

  it("the 401 refresher persists through refreshConnection and returns the new credential", async () => {
    const { refreshCredential } = await loadLiveCredential("c1");
    const next = await refreshCredential();
    assert.equal(next?.payload.access_token, "fresh");
    assert.equal(state.refreshed, 1);
  });
});

describe("probeConnection + verdicts", () => {
  it("ok when the adapter health check succeeds (refreshing on 401)", async () => {
    const f = scriptedFetch([jsonResponse(401, {}), jsonResponse(200, { accountSummaries: [] })]);
    const orig = globalThis.fetch;
    globalThis.fetch = f.fetchImpl;
    try {
      assert.deepEqual(await probeConnection("c1"), { ok: true });
    } finally {
      globalThis.fetch = orig;
    }
    assert.equal(f.calls[0].headers.authorization, "Bearer old");
    assert.equal(f.calls[1].headers.authorization, "Bearer fresh");
  });

  it("maps a provider rejection to a closed code; unknown connection → null", async () => {
    const f = scriptedFetch([jsonResponse(403, { error: { message: "denied" } })]);
    const orig = globalThis.fetch;
    globalThis.fetch = f.fetchImpl;
    try {
      assert.deepEqual(await probeConnection("c1"), { ok: false, errorCode: "forbidden" });
    } finally {
      globalThis.fetch = orig;
    }
    state.connection = null;
    assert.equal(await probeConnection("c1"), null);
    state.connection = { connectorKey: "wordpress", workspaceId: "ws", userId: "u" };
    assert.equal(await probeConnection("c1"), null, "api-key adapters have no live probe");
  });

  it("liveCheckVerdict maps codes onto health states", () => {
    assert.deepEqual(liveCheckVerdict("auth_rejected"), { status: "needs_reauth", code: "auth_rejected" });
    assert.deepEqual(liveCheckVerdict("rate_limited"), { status: "degraded", code: "provider_unreachable" });
    assert.deepEqual(liveCheckVerdict("config_missing"), { status: "error", code: "config_missing" });
    assert.deepEqual(liveCheckVerdict(undefined), { status: "error", code: "unknown_error" });
  });

  it("no built-in adapter is mock-only any more; the six are live-wired with health checks", () => {
    assert.equal(registry.MOCK_ONLY_ADAPTER_KEYS.size, 0);
    for (const k of ["google-search-console", "ga4", "google-drive", "notion", "meta-ads", "google-ads", "google-business-profile"]) {
      assert.equal(registry.hasLiveWiring(k), true, k);
      assert.equal(typeof registry.resolveAdapter(k).healthCheck, "function", k);
    }
  });
});
