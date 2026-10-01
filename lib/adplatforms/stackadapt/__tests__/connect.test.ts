// Marketr — Phase 18 slice 3 tests: StackAdapt API-key connect flow.
// Run: npx tsx --test lib/adplatforms/stackadapt/__tests__/connect.test.ts
//
// The validate → store → link flow against a mocked StackAdapt API.
// Bad-key auth failure handled (AUTH_FAILED, nothing stored); empty key,
// no-advertiser seats, and vault-scheme tokenRefs all covered. Pure:
// injected fetch/store/link stubs, no DB, no real key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { connectStackAdaptKey } from "../connect";
import { StackAdaptError } from "../client";

function mockFetch(handler: (body: { query: string; variables: Record<string, unknown> }) => {
  status: number;
  json: unknown;
}) {
  return (async (_url: string, init: { body: string }) => {
    const { status, json } = handler(JSON.parse(init.body) as { query: string; variables: Record<string, unknown> });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;
}

function validKeyFetch(advertisers: Array<{ id: string; name?: string }> = [{ id: "adv_9", name: "Tenant Seat" }]) {
  return mockFetch((body) => {
    if (body.query.includes("tokenInfo")) return { status: 200, json: { data: { tokenInfo: { __typename: "TokenInfo" } } } };
    if (body.query.includes("advertisers")) {
      return {
        status: 200,
        json: {
          data: {
            advertisers: {
              totalCount: advertisers.length,
              nodes: advertisers,
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    }
    return { status: 200, json: { data: {} } };
  });
}

function stubStoreAndLink() {
  const stored: Array<{ label: string; apiKey: string }> = [];
  const linked: Array<{ externalAccountId: string; tokenRef: string; name?: string }> = [];
  return {
    stored,
    linked,
    deps: {
      storeKey: async (s: { label: string; apiKey: string }) => {
        stored.push({ label: s.label, apiKey: s.apiKey });
        return { id: "conn_1" };
      },
      link: (async (l: { externalAccountId: string; tokenRef: string; name?: string }) => {
        linked.push(l);
        return { id: "acct_1", ...l };
      }) as never,
    },
  };
}

describe("connectStackAdaptKey", () => {
  it("validates the key, stores it, and links the advertiser", async () => {
    const { stored, linked, deps } = stubStoreAndLink();
    const result = await connectStackAdaptKey(
      { userId: "u1", workspaceId: "ws1", apiKey: "good-key", label: "Seat A" },
      { fetchImpl: validKeyFetch(), ...deps },
    );
    assert.equal(result.advertiserId, "adv_9");
    assert.equal(result.accountId, "acct_1");
    assert.equal(result.connectionId, "conn_1");
    // The key went to the vault stub; the account row got the opaque ref.
    assert.equal(stored.length, 1);
    assert.equal(stored[0].apiKey, "good-key");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].externalAccountId, "adv_9");
    assert.equal(linked[0].tokenRef, "vault:oauth:stackadapt:conn_1");
    assert.ok(!linked[0].tokenRef.includes("good-key"), "tokenRef must not contain the key");
  });

  it("rejects an empty key before any network call", async () => {
    const { stored, deps } = stubStoreAndLink();
    await assert.rejects(
      connectStackAdaptKey({ userId: "u1", workspaceId: "ws1", apiKey: "   " }, { fetchImpl: validKeyFetch(), ...deps }),
      (e: Error) => e instanceof StackAdaptError && e.code === "INVALID_KEY",
    );
    assert.equal(stored.length, 0);
  });

  it("fails closed on a bad key and stores nothing (AUTH_FAILED)", async () => {
    const { stored, linked, deps } = stubStoreAndLink();
    const badFetch = mockFetch(() => ({
      status: 401,
      json: { errors: [{ message: "Schema introspection requires authentication." }] },
    }));
    await assert.rejects(
      connectStackAdaptKey({ userId: "u1", workspaceId: "ws1", apiKey: "bad-key" }, { fetchImpl: badFetch, ...deps }),
      (e: Error) => e instanceof StackAdaptError && e.code === "AUTH_FAILED",
    );
    assert.equal(stored.length, 0, "bad key must never reach the vault");
    assert.equal(linked.length, 0, "bad key must never link an account");
  });

  it("fails closed when the key exposes no advertisers", async () => {
    const { stored, linked, deps } = stubStoreAndLink();
    await assert.rejects(
      connectStackAdaptKey(
        { userId: "u1", workspaceId: "ws1", apiKey: "good-key" },
        { fetchImpl: validKeyFetch([]), ...deps },
      ),
      (e: Error) => e instanceof StackAdaptError && e.code === "NO_ADVERTISERS",
    );
    assert.equal(stored.length, 0);
    assert.equal(linked.length, 0);
  });
});
