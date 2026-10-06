// Deploy PR: website host vs app host routing (lib/hosting/host-routing.ts)
// and its wiring in proxy.ts.
// Run: npx tsx --test lib/hosting/__tests__/host-routing.test.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  APP_ONLY_PATHS,
  SHARED_PATHS,
  WEBSITE_ONLY_PATHS,
  decideHostRoute,
  hostRoutingConfig,
  normalizeHost,
  type HostRouteRequest,
} from "../host-routing";
import { proxy } from "../../../proxy";
import { API_CONTENT_SECURITY_POLICY } from "../../security/headers";

const CONFIG = { websiteHost: "shapesos.com", appHost: "app.shapesos.com" };

const get = (host: string | null, pathname: string, extra: Partial<HostRouteRequest> = {}): HostRouteRequest => ({
  method: "GET",
  host,
  pathname,
  search: "",
  forwardedProto: "https",
  ...extra,
});

describe("normalizeHost", () => {
  it("lowercases, strips scheme, path and trailing dot; keeps a port", () => {
    assert.equal(normalizeHost("App.ShapesOS.com"), "app.shapesos.com");
    assert.equal(normalizeHost("https://app.shapesos.com/"), "app.shapesos.com");
    assert.equal(normalizeHost("https://app.shapesos.com/dashboard?x=1"), "app.shapesos.com");
    assert.equal(normalizeHost("shapesos.com."), "shapesos.com");
    assert.equal(normalizeHost("app.localhost:3000"), "app.localhost:3000");
    assert.equal(normalizeHost("  shapesos.com  "), "shapesos.com");
  });
  it("rejects empty and malformed values", () => {
    for (const v of [undefined, null, "", "   ", "bad host", "-x.com", ".x.com", "x.com:abc", "a@b.com"]) {
      assert.equal(normalizeHost(v), null, String(v));
    }
  });
});

describe("hostRoutingConfig", () => {
  it("is on only when both hosts are set, valid and different", () => {
    assert.deepEqual(hostRoutingConfig({ WEBSITE_HOST: "shapesos.com", APP_HOST: "app.shapesos.com" }), CONFIG);
    assert.equal(hostRoutingConfig({}), null);
    assert.equal(hostRoutingConfig({ WEBSITE_HOST: "shapesos.com" }), null);
    assert.equal(hostRoutingConfig({ APP_HOST: "app.shapesos.com" }), null);
    assert.equal(hostRoutingConfig({ WEBSITE_HOST: "", APP_HOST: "app.shapesos.com" }), null);
    assert.equal(hostRoutingConfig({ WEBSITE_HOST: "shapesos.com", APP_HOST: "SHAPESOS.com" }), null);
    assert.equal(hostRoutingConfig({ WEBSITE_HOST: "not a host", APP_HOST: "app.shapesos.com" }), null);
  });
});

describe("decideHostRoute", () => {
  it("does nothing when routing is off (self-host, dev, CI, e2e)", () => {
    for (const path of ["/", "/dashboard", "/pricing", "/login", "/api/health"]) {
      assert.deepEqual(decideHostRoute(get("shapesos.com", path), null), { action: "pass" });
      assert.deepEqual(decideHostRoute(get("localhost:3000", path), null), { action: "pass" });
    }
  });

  it("website host: every OS path moves to the app host with path and query (308)", () => {
    for (const p of APP_ONLY_PATHS) {
      for (const path of [p, `${p}/deep/page`]) {
        const d = decideHostRoute(get("shapesos.com", path, { search: "?next=%2Fx&a=1" }), CONFIG);
        assert.deepEqual(d, { action: "redirect", location: `https://app.shapesos.com${path}?next=%2Fx&a=1`, status: 308 }, path);
      }
    }
  });

  it("website host: website pages, '/', unknown paths and look-alike prefixes stay", () => {
    for (const path of ["/", "/pricing", "/legal/terms", "/docs/x", "/download", "/about", "/dashboards", "/login-help", "/administrator"]) {
      assert.deepEqual(decideHostRoute(get("shapesos.com", path), CONFIG), { action: "pass" }, path);
    }
  });

  it("app host: '/' goes to the dashboard (307, temporary) and keeps the query", () => {
    assert.deepEqual(decideHostRoute(get("app.shapesos.com", "/", { search: "?ref=x" }), CONFIG), {
      action: "redirect",
      location: "https://app.shapesos.com/dashboard?ref=x",
      status: 307,
    });
  });

  it("app host: website pages move to the website host (308)", () => {
    for (const p of WEBSITE_ONLY_PATHS) {
      const d = decideHostRoute(get("app.shapesos.com", `${p}/x`, { search: "?plan=pro" }), CONFIG);
      assert.deepEqual(d, { action: "redirect", location: `https://shapesos.com${p}/x?plan=pro`, status: 308 }, p);
    }
  });

  it("app host: OS paths and unknown paths stay", () => {
    for (const path of ["/dashboard", "/login", "/signup", "/portal/projects", "/admin", "/security/setup", "/whatever"]) {
      assert.deepEqual(decideHostRoute(get("app.shapesos.com", path), CONFIG), { action: "pass" }, path);
    }
  });

  it("API, auth callbacks, assets, well-known and public share pages are never redirected on either host", () => {
    const paths = [
      ...SHARED_PATHS,
      "/api/auth/callback/google",
      "/api/connectors/slack/callback",
      "/api/health/live",
      "/_next/static/chunks/x.js",
      "/.well-known/apple-app-site-association",
      "/r/review/tok",
      "/s/tok",
      "/book/tok",
      "/events/launch",
      "/shop/acme",
      "/mcp/authorize",
      "/cms-api/users",
    ];
    for (const host of ["shapesos.com", "app.shapesos.com"]) {
      for (const path of paths) {
        assert.deepEqual(decideHostRoute(get(host, path), CONFIG), { action: "pass" }, `${host}${path}`);
      }
    }
  });

  it("tenant custom domains, the CNAME target and the platform hostname are never redirected", () => {
    for (const host of ["reviews.acme.com", "domains.shapesos.com", "shapesos-web.onrender.com", "www.shapesos.com", "localhost:3000", "10.0.0.5:10000"]) {
      for (const path of ["/", "/dashboard", "/login", "/pricing"]) {
        assert.deepEqual(decideHostRoute(get(host, path), CONFIG), { action: "pass" }, `${host}${path}`);
      }
    }
  });

  it("only GET and HEAD are redirected; HEAD behaves like GET", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      assert.deepEqual(decideHostRoute(get("shapesos.com", "/login", { method }), CONFIG), { action: "pass" }, method);
    }
    assert.equal(decideHostRoute(get("shapesos.com", "/login", { method: "head" }), CONFIG).action, "redirect");
  });

  it("matches hosts case-insensitively and ignores the port unless the config names one", () => {
    assert.equal(decideHostRoute(get("ShapesOS.com:443", "/dashboard"), CONFIG).action, "redirect");
    assert.equal(decideHostRoute(get("APP.shapesos.com", "/pricing"), CONFIG).action, "redirect");
    const local = { websiteHost: "localhost:3000", appHost: "app.localhost:3000" };
    assert.deepEqual(decideHostRoute(get("localhost:3000", "/dashboard", { forwardedProto: null, protocol: "http:" }), local), {
      action: "redirect",
      location: "http://app.localhost:3000/dashboard",
      status: 308,
    });
    assert.deepEqual(decideHostRoute(get("localhost:4000", "/dashboard"), local), { action: "pass" });
  });

  it("scheme: X-Forwarded-Proto (first value) wins, then the request protocol, then https", () => {
    const loc = (extra: Partial<HostRouteRequest>) => {
      const d = decideHostRoute(get("shapesos.com", "/login", extra), CONFIG);
      return d.action === "redirect" ? d.location : "";
    };
    assert.equal(loc({ forwardedProto: "http, https" }), "http://app.shapesos.com/login");
    assert.equal(loc({ forwardedProto: null, protocol: "http:" }), "http://app.shapesos.com/login");
    assert.equal(loc({ forwardedProto: "garbage", protocol: "https:" }), "https://app.shapesos.com/login");
    assert.equal(loc({ forwardedProto: undefined, protocol: undefined }), "https://app.shapesos.com/login");
  });

  it("a missing or garbled Host header passes", () => {
    assert.deepEqual(decideHostRoute(get(null, "/dashboard"), CONFIG), { action: "pass" });
    assert.deepEqual(decideHostRoute(get("bad host", "/dashboard"), CONFIG), { action: "pass" });
  });
});

describe("proxy.ts host routing", () => {
  const saved = { WEBSITE_HOST: process.env.WEBSITE_HOST, APP_HOST: process.env.APP_HOST };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(new URL(url), init);

  it("redirects across hosts and keeps the CSP and request id on the redirect", async () => {
    process.env.WEBSITE_HOST = "shapesos.com";
    process.env.APP_HOST = "app.shapesos.com";
    const res = await proxy(req("https://shapesos.com/dashboard/settings?tab=keys", { headers: { host: "shapesos.com" } }));
    assert.equal(res.status, 308);
    assert.equal(res.headers.get("location"), "https://app.shapesos.com/dashboard/settings?tab=keys");
    assert.ok(res.headers.get("content-security-policy"));
    assert.ok(res.headers.get("x-request-id"));

    const home = await proxy(req("https://app.shapesos.com/", { headers: { host: "app.shapesos.com" } }));
    assert.equal(home.status, 307);
    assert.equal(home.headers.get("location"), "https://app.shapesos.com/dashboard");
  });

  it("leaves API routes and tenant domains alone even with routing on", async () => {
    process.env.WEBSITE_HOST = "shapesos.com";
    process.env.APP_HOST = "app.shapesos.com";
    const api = await proxy(req("https://shapesos.com/api/health/live", { headers: { host: "shapesos.com" } }));
    assert.equal(api.headers.get("location"), null);
    assert.equal(api.headers.get("content-security-policy"), API_CONTENT_SECURITY_POLICY);
    const tenant = await proxy(req("https://reviews.acme.com/dashboard", { headers: { host: "reviews.acme.com" } }));
    assert.equal(tenant.headers.get("location"), null);
  });

  it("changes nothing when the env vars are unset", async () => {
    delete process.env.WEBSITE_HOST;
    delete process.env.APP_HOST;
    const res = await proxy(req("https://shapesos.com/dashboard", { headers: { host: "shapesos.com" } }));
    assert.equal(res.headers.get("location"), null);
    assert.ok(res.headers.get("content-security-policy"));
  });
});
