// Phase 15.4 (zernio): Zernio is the DEFAULT social publisher on hosted when
// ZERNIO_API_KEY is set; Postiz stays first on self-hosted when it is
// configured; Zernio needs a workspace (its own profile); without either the
// existing labelled mock / "not connected" behaviour is unchanged.
// Run: npx tsx --test lib/zernio/__tests__/zernio-social-select.test.ts

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { getSocialProvider, setSocialProviderForTests } from "@/lib/social/provider";

const KEYS = ["NODE_ENV", "DEPLOYMENT_MODE", "ZERNIO_API_KEY", "POSTIZ_URL", "POSTIZ_API_KEY", "SOCIAL_MOCK_MODE"] as const;
let saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;
function set(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete env[k];
  for (const [k, v] of Object.entries(values)) env[k] = v;
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, env[k]]));
  setSocialProviderForTests(undefined);
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

describe("social publisher selection (Phase 15.4)", () => {
  it("hosted + ZERNIO_API_KEY → Zernio, even when a shared Postiz is configured", () => {
    set({ NODE_ENV: "production", DEPLOYMENT_MODE: "hosted", ZERNIO_API_KEY: "zk", POSTIZ_URL: "https://postiz.example", POSTIZ_API_KEY: "p" });
    assert.equal(getSocialProvider("ws_1")?.name, "zernio");
  });

  it("self-hosted keeps Postiz first when it is configured; Zernio when it is the only one", () => {
    set({ NODE_ENV: "production", ZERNIO_API_KEY: "zk", POSTIZ_URL: "https://postiz.example", POSTIZ_API_KEY: "p" });
    assert.equal(getSocialProvider("ws_1")?.name, "postiz");
    set({ NODE_ENV: "production", ZERNIO_API_KEY: "zk" });
    assert.equal(getSocialProvider("ws_1")?.name, "zernio");
  });

  it("Zernio is per workspace: no workspace → not Zernio", () => {
    set({ NODE_ENV: "production", DEPLOYMENT_MODE: "hosted", ZERNIO_API_KEY: "zk" });
    assert.equal(getSocialProvider(), null);
    assert.equal(getSocialProvider(null), null);
  });

  it("without a key nothing changes: production says not connected, dev keeps the labelled mock", () => {
    set({ NODE_ENV: "production", DEPLOYMENT_MODE: "hosted" });
    assert.equal(getSocialProvider("ws_1"), null);
    set({ NODE_ENV: "development" });
    assert.equal(getSocialProvider("ws_1")?.name, "mock", "the fake Zernio is never used for social publishing");
  });
});
