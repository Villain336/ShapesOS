// ShapesOS Phase 15.1 — sidecar tenancy gate (pure + module behaviour, no DB).
// Hosted + no workspace instance → the shared env instance is REFUSED with a
// "connect your own" message; self-hosted → env exactly as before; a
// workspace's own instance always wins and never mixes with env values.
// Run: npx tsx --test lib/integrations/__tests__/sidecar-tenancy.test.ts

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SIDECAR_KEYS,
  currentSidecarSource,
  overrideToEnv,
  runWithSidecarOverrides,
  sidecarDecision,
  sidecarEnv,
  sidecarRefusalMessage,
} from "../sidecar-tenancy";
import { sidecarEnvVars } from "@/lib/providers/workspace-credentials";
import { getPostizConfig, postizStatus, listPostizChannels } from "../postiz";
import { getListmonkConfig, listmonkStatus } from "../listmonk";
import { getPlaneConfig } from "../plane";
import { ghostStatus } from "../ghost";
import { documensoStatus } from "../documenso";
import { umamiSnippetConfig } from "../umami";
import { chatwootWidgetConfig } from "../chatwoot";

const VARS = ["DEPLOYMENT_MODE", "POSTIZ_URL", "POSTIZ_API_KEY", "LISTMONK_URL", "LISTMONK_USER", "LISTMONK_TOKEN", "PLANE_BASE_URL", "PLANE_API_KEY", "PLANE_WORKSPACE_SLUG", "GHOST_URL", "GHOST_ADMIN_API_KEY", "DOCUMENSO_URL", "DOCUMENSO_API_KEY", "UMAMI_WEBSITE_ID", "UMAMI_SCRIPT_URL", "CHATWOOT_BASE_URL", "CHATWOOT_WEBSITE_TOKEN", "CHATWOOT_WIDGET_ENABLED"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  // The SHARED instance every workspace would otherwise reach.
  Object.assign(process.env, {
    POSTIZ_URL: "https://shared-postiz.example",
    POSTIZ_API_KEY: "shared-postiz-key",
    LISTMONK_URL: "https://shared-listmonk.example",
    LISTMONK_USER: "api",
    LISTMONK_TOKEN: "shared-token",
    PLANE_BASE_URL: "https://shared-plane.example",
    PLANE_API_KEY: "shared-plane",
    PLANE_WORKSPACE_SLUG: "shared",
    GHOST_URL: "https://shared-ghost.example",
    GHOST_ADMIN_API_KEY: "id:abcd",
    DOCUMENSO_URL: "https://shared-sign.example",
    DOCUMENSO_API_KEY: "shared-doc",
    UMAMI_WEBSITE_ID: "shared-site",
    UMAMI_SCRIPT_URL: "https://shared-umami.example/script.js",
    CHATWOOT_BASE_URL: "https://shared-chat.example",
    CHATWOOT_WEBSITE_TOKEN: "shared-chat-token",
    CHATWOOT_WIDGET_ENABLED: "true",
  });
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("sidecarDecision (pure)", () => {
  it("hosted + no own instance → refused; self-hosted → env; own instance → workspace", () => {
    assert.equal(sidecarDecision({ mode: "hosted", hasOverride: false }), "refused");
    assert.equal(sidecarDecision({ mode: "self_hosted", hasOverride: false }), "env");
    assert.equal(sidecarDecision({ mode: "hosted", hasOverride: true }), "workspace");
    assert.equal(sidecarDecision({ mode: "self_hosted", hasOverride: true }), "workspace");
  });
});

describe("self-hosted keeps using env exactly as today", () => {
  it("every sidecar reads the env instance", () => {
    delete process.env.DEPLOYMENT_MODE;
    assert.equal(getPostizConfig().url, "https://shared-postiz.example");
    assert.equal(postizStatus().configured, true);
    assert.equal(getListmonkConfig().token, "shared-token");
    assert.equal(getPlaneConfig().workspaceSlug, "shared");
    assert.equal(ghostStatus().configured, true);
    assert.equal(documensoStatus().configured, true);
    assert.deepEqual(umamiSnippetConfig(), { websiteId: "shared-site", scriptUrl: "https://shared-umami.example/script.js" });
    assert.ok(chatwootWidgetConfig());
    assert.equal(currentSidecarSource("postiz"), "env");
  });
});

describe("hosted refuses the shared instance unless the workspace has its own", () => {
  it("no scope (an unwrapped caller) and a scope without an override are both refused", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    for (const read of [() => postizStatus().configured, () => getListmonkConfig().url !== "", () => ghostStatus().configured, () => documensoStatus().configured]) {
      assert.equal(read(), false);
      assert.equal(runWithSidecarOverrides("ws-1", {}, read), false);
    }
    assert.equal(umamiSnippetConfig(), null);
    assert.equal(chatwootWidgetConfig(), null);
    for (const k of SIDECAR_KEYS) {
      const env = sidecarEnv(k);
      for (const v of sidecarEnvVars(k)) assert.equal(env[v], undefined, `${k}: ${v} leaked from the shared instance`);
    }
    await assert.rejects(listPostizChannels(), (e: Error) => e.message === sidecarRefusalMessage("postiz") && /connect your own Postiz/.test(e.message));
  });

  it("a workspace's own instance is used, and never mixed with env values", () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    const own = { postiz: overrideToEnv("postiz", { url: "https://acme-postiz.example", apiKey: "acme-key" }) };
    runWithSidecarOverrides("ws-acme", own, () => {
      assert.deepEqual(getPostizConfig(), { url: "https://acme-postiz.example", apiKey: "acme-key" });
      assert.equal(currentSidecarSource("postiz"), "workspace");
      // Another sidecar the workspace did not configure stays refused.
      assert.equal(getListmonkConfig().url, "");
    });
    // A partial override (no API key) does not borrow the shared key.
    const partial = { postiz: overrideToEnv("postiz", { url: "https://acme-postiz.example" }) };
    runWithSidecarOverrides("ws-acme", partial, () => {
      assert.deepEqual(getPostizConfig(), { url: "https://acme-postiz.example", apiKey: "" });
    });
  });

  it("scopes are isolated per workspace (concurrent requests)", async () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    const a = { postiz: overrideToEnv("postiz", { url: "https://a.example", apiKey: "a" }) };
    const b = { postiz: overrideToEnv("postiz", { url: "https://b.example", apiKey: "b" }) };
    const [ua, ub] = await Promise.all([
      runWithSidecarOverrides("A", a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getPostizConfig().url;
      }),
      runWithSidecarOverrides("B", b, async () => getPostizConfig().url),
    ]);
    assert.deepEqual([ua, ub], ["https://a.example", "https://b.example"]);
  });

  it("Chatwoot's own instance turns its widget on", () => {
    process.env.DEPLOYMENT_MODE = "hosted";
    const own = { chatwoot: overrideToEnv("chatwoot", { baseUrl: "https://chat.acme.example", websiteToken: "tok" }) };
    runWithSidecarOverrides("ws-acme", own, () => {
      assert.ok(chatwootWidgetConfig());
    });
    assert.equal(listmonkStatus().configured, false);
  });
});
