// Phase 11 (devtools): Netlify as an m21 connector — it reuses the Phase 9
// deploy adapter (lib/deploy/netlify.ts) and the hosting-connection
// credentials (no second Netlify client): request shapes for sites, deploys
// and the build trigger, the never-retried trigger, error mapping with the
// token scrubbed, credential resolution (hosting reference / PAT / demo) and
// the grant mapping. fetch is scripted (no network, no DB).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/netlify-connector.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NetlifyM21Adapter, type HostingConfigLoader } from "../../native/netlify";
import { NetlifyDeployTarget } from "@/lib/deploy/netlify";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, ctxWith } from "./fixtures";

const SITE = "3970e0fe-8564-4903-9a55-c5f8de49fb8b";
const DEPLOY = "5f8a1b2c3d4e5f6a7b8c9d0e";
const hostingCred = { kind: "api_key" as const, payload: { hostingConnectionId: "hc_1" } };
const patCred = (token = "nfp_pat_123456789") => ({ kind: "api_key" as const, payload: { apiKey: token } });

function adapter(script: Parameters<typeof scriptedFetch>[0], hosting: Record<string, unknown> | null = { token: "nfp_hosting_tok_1", siteId: SITE }) {
  const f = scriptedFetch(script);
  const loads: Array<[string, string]> = [];
  const loadHostingConfig: HostingConfigLoader = async (id, ws) => {
    loads.push([id, ws]);
    return hosting;
  };
  return { a: new NetlifyM21Adapter({ fetchImpl: f.fetchImpl, loadHostingConfig }), f, loads };
}

describe("Netlify connector: credentials", () => {
  it("a hosting-connection reference loads that connection's token, scoped to the caller's workspace", async () => {
    const { a, f, loads } = adapter([jsonResponse(200, [])]);
    const r = await a.invoke("list_sites", {}, hostingCred, ctxWith({ workspaceId: "ws-9" }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(loads, [["hc_1", "ws-9"]]);
    assert.equal(f.calls[0].headers.authorization, "Bearer nfp_hosting_tok_1");
  });

  it("a personal access token works too", async () => {
    const { a, f } = adapter([jsonResponse(200, [])]);
    await a.invoke("list_sites", {}, patCred("nfp_direct_987654"), ctxWith());
    assert.equal(f.calls[0].headers.authorization, "Bearer nfp_direct_987654");
  });

  it("a removed hosting connection is not_found (never a fake success)", async () => {
    const { a, f } = adapter([], null);
    const r = await a.invoke("list_sites", {}, hostingCred, ctxWith());
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "not_found");
    assert.equal(f.calls.length, 0);
  });

  it("a demo hosting connection gives the labelled mock (refused in production by the no-fakes guard)", async () => {
    const { a, f } = adapter([], { token: "", demo: true });
    const r = await a.invoke("trigger_deploy", {}, hostingCred, ctxWith());
    assert.equal(r.mock, true);
    assert.equal((r.data as { triggered: boolean }).triggered, false);
    assert.equal(f.calls.length, 0);
  });
});

describe("Netlify connector: reads (Phase 9 adapter)", () => {
  it("list_sites: GET /api/v1/sites?filter=all with repo + published deploy", async () => {
    const { a, f } = adapter([
      jsonResponse(200, [
        {
          id: SITE,
          name: "acme",
          ssl_url: "https://acme.netlify.app",
          admin_url: "https://app.netlify.com/sites/acme",
          build_settings: { repo_url: "https://github.com/acme/site", repo_branch: "main" },
          published_deploy: { id: DEPLOY },
          updated_at: "2026-10-01T00:00:00Z",
        },
      ]),
    ]);
    const r = await a.invoke("list_sites", { limit: 5 }, hostingCred, ctxWith());
    assert.deepEqual(r.data, [
      { id: SITE, name: "acme", url: "https://acme.netlify.app", adminUrl: "https://app.netlify.com/sites/acme", repo: "https://github.com/acme/site", branch: "main", publishedDeployId: DEPLOY, updatedAt: "2026-10-01T00:00:00Z" },
    ]);
    assert.equal(f.calls[0].url.href, "https://api.netlify.com/api/v1/sites?filter=all&per_page=5");
  });

  it("list_deploys: defaults to the hosting connection's site; projectConfig.siteId and args override", async () => {
    const deploys = [{ id: DEPLOY, state: "ready", deploy_ssl_url: `https://${DEPLOY}--acme.netlify.app` }];
    const { a, f } = adapter([jsonResponse(200, deploys), jsonResponse(200, deploys), jsonResponse(200, deploys)]);
    const r = await a.invoke("list_deploys", {}, hostingCred, ctxWith());
    assert.deepEqual(r.data, { siteId: SITE, deploys: [{ id: DEPLOY, url: `https://${DEPLOY}--acme.netlify.app`, status: "ready", mock: false }] });
    assert.equal(f.calls[0].url.pathname, `/api/v1/sites/${SITE}/deploys`);
    await a.invoke("list_deploys", {}, hostingCred, ctxWith({ projectConfig: { siteId: "other-site" } }));
    assert.equal(f.calls[1].url.pathname, "/api/v1/sites/other-site/deploys");
    await a.invoke("list_deploys", { siteId: "third", limit: 3 }, hostingCred, ctxWith());
    assert.equal(f.calls[2].url.search, "?per_page=3");
  });

  it("list_deploys with a PAT and no site is bad_request (no call)", async () => {
    const { a, f } = adapter([]);
    const r = await a.invoke("list_deploys", {}, patCred(), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.equal(f.calls.length, 0);
  });

  it("get_deploy validates the id", async () => {
    const { a, f } = adapter([jsonResponse(200, { id: DEPLOY, state: "building" })]);
    const ok = await a.invoke("get_deploy", { deployId: DEPLOY }, hostingCred, ctxWith());
    assert.equal((ok.data as { status: string }).status, "building");
    const bad = await a.invoke("get_deploy", { deployId: "../sites" }, hostingCred, ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    assert.equal(f.calls.length, 1);
  });
});

describe("Netlify connector: trigger_deploy (gated, never retried)", () => {
  it("POST /api/v1/sites/{id}/builds (clear_cache when asked) → build + deploy ids", async () => {
    const { a, f } = adapter([jsonResponse(200, { id: "b1", deploy_id: DEPLOY, created_at: "2026-10-04T00:00:00Z", done: false })]);
    const r = await a.invoke("trigger_deploy", { clearCache: true }, hostingCred, ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { siteId: SITE, buildId: "b1", deployId: DEPLOY, createdAt: "2026-10-04T00:00:00Z", done: false });
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].url.href, `https://api.netlify.com/api/v1/sites/${SITE}/builds`);
    assert.deepEqual(f.calls[0].body, { clear_cache: true });
  });

  it("429 / 5xx are reported, not retried; the token is scrubbed from errors", async () => {
    for (const [status, code] of [[429, "rate_limited"], [502, "provider_error"], [401, "auth_rejected"], [422, "bad_request"]] as const) {
      const { a, f } = adapter([jsonResponse(status, { message: "nope nfp_hosting_tok_1" })]);
      const r = await a.invoke("trigger_deploy", {}, hostingCred, ctxWith());
      assert.equal(r.errorCode, code, String(status));
      assert.doesNotMatch(r.error ?? "", /nfp_hosting_tok_1/);
      assert.equal(f.calls.length, 1, `HTTP ${status} must not be retried`);
    }
  });

  it("a network failure is provider_unreachable", async () => {
    const { a } = adapter([new TypeError("fetch failed")]);
    const r = await a.invoke("trigger_deploy", {}, hostingCred, ctxWith());
    assert.equal(r.errorCode, "provider_unreachable");
  });
});

describe("Netlify connector: wiring", () => {
  it("grants: site group; trigger_deploy is publish_owned (asks unless a rule allows)", () => {
    assert.equal(connectorGroup("netlify"), "site");
    assert.equal(connectorAction("netlify", "trigger_deploy"), "publish_owned");
  });

  it("reuses the Phase 9 adapter: no second Netlify client in lib/connectors", () => {
    const src = readFileSync(join(__dirname, "..", "..", "native", "netlify.ts"), "utf8");
    assert.match(src, /from "@\/lib\/deploy\/netlify"/);
    assert.doesNotMatch(src, /api\.netlify\.com/, "the connector must not talk to Netlify directly");
    assert.equal(typeof NetlifyDeployTarget.prototype.listSites, "function");
    assert.equal(typeof NetlifyDeployTarget.prototype.triggerBuild, "function");
  });

  it("no credential → labelled mock in dev/test", async () => {
    const r = await new NetlifyM21Adapter().invoke("list_sites", {}, null, ctxWith());
    assert.equal(r.mock, true);
  });
});
