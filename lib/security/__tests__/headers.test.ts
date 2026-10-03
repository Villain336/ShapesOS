// Phase 1 (untrusted content): response security headers.
// Run: npx tsx --test lib/security/__tests__/headers.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  shouldSendHsts,
  USER_CONTENT_CSP,
} from "../headers";
import { brandLogoHeaders } from "../../brand-logo";
import { buildDownloadHeaders } from "../../filesystem/download";

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(";").map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")] as [string, string];
    }),
  );
}

describe("app-wide Content-Security-Policy", () => {
  const d = directives(buildContentSecurityPolicy());

  it("blocks inline event handlers (the H1/XSS sink) and plugins", () => {
    assert.equal(d.get("script-src-attr"), "'none'");
    assert.equal(d.get("object-src"), "'none'");
    assert.equal(d.get("base-uri"), "'self'");
    assert.equal(d.get("frame-ancestors"), "'self'");
    assert.equal(d.get("default-src"), "'self'");
  });

  it("keeps what the app needs (Next inline bootstrap, Monaco CDN, data:/blob: images, workers)", () => {
    assert.match(d.get("script-src")!, /'self'/);
    assert.match(d.get("script-src")!, /'unsafe-inline'/);
    assert.match(d.get("script-src")!, /https:/);
    assert.doesNotMatch(d.get("script-src")!, /(^|\s)http:/, "no cleartext script origins");
    assert.match(d.get("img-src")!, /data:/);
    assert.match(d.get("img-src")!, /blob:/);
    assert.match(d.get("worker-src")!, /blob:/);
    assert.doesNotMatch(d.get("script-src")!, /\*/);
  });

  it("does not emit upgrade-insecure-requests (would break plain-http LAN installs)", () => {
    assert.equal(d.has("upgrade-insecure-requests"), false);
  });
});

describe("security header set", () => {
  it("always carries CSP + nosniff + frame options; HSTS only when asked", () => {
    const keys = (h: Array<{ key: string }>) => h.map((x) => x.key);
    assert.ok(keys(buildSecurityHeaders({ hsts: false })).includes("Content-Security-Policy"));
    assert.ok(keys(buildSecurityHeaders({ hsts: false })).includes("X-Content-Type-Options"));
    assert.ok(!keys(buildSecurityHeaders({ hsts: false })).includes("Strict-Transport-Security"));
    assert.ok(keys(buildSecurityHeaders({ hsts: true })).includes("Strict-Transport-Security"));
  });

  it("sends HSTS in production unless NEXTAUTH_URL is explicitly http://", () => {
    assert.equal(shouldSendHsts({ NODE_ENV: "production" }), true);
    assert.equal(shouldSendHsts({ NODE_ENV: "production", NEXTAUTH_URL: "https://app.example" }), true);
    assert.equal(shouldSendHsts({ NODE_ENV: "production", NEXTAUTH_URL: "http://10.0.0.5:3000" }), false);
    assert.equal(shouldSendHsts({ NODE_ENV: "development", NEXTAUTH_URL: "https://app.example" }), false);
  });

  it("next.config.ts wires the headers and disables X-Powered-By", () => {
    const src = readFileSync(new URL("../../../next.config.ts", import.meta.url), "utf8");
    assert.match(src, /poweredByHeader:\s*false/);
    assert.match(src, /buildSecurityHeaders\(/);
    assert.match(src, /source:\s*"\/:path\*",\s*headers:\s*securityHeaders/);
  });
});

describe("user-content responses", () => {
  it("logo: SVG is an attachment with a sandbox CSP; raster stays inline", () => {
    const svg = brandLogoHeaders({ bytes: Buffer.from("<svg/>"), mime: "image/svg+xml", filename: 'wl-x.svg"\r\nX: y' }, "public");
    assert.match(svg["Content-Disposition"], /^attachment;/);
    assert.equal(svg["X-Content-Type-Options"], "nosniff");
    assert.equal(svg["Content-Security-Policy"], USER_CONTENT_CSP);
    assert.match(USER_CONTENT_CSP, /^sandbox;/);
    assert.doesNotMatch(svg["Content-Disposition"], /[\r\n]/);
    const png = brandLogoHeaders({ bytes: Buffer.alloc(1), mime: "image/png", filename: "wl-x.png" }, "public");
    assert.match(png["Content-Disposition"], /^inline;/);
    assert.equal(png["Content-Security-Policy"], USER_CONTENT_CSP);
  });

  it("project file download: forced attachment + nosniff + sandbox", () => {
    const h = buildDownloadHeaders("image/png", 'evil".html', { forceAttachment: true });
    assert.match(h["content-disposition"], /^attachment;/);
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.equal(h["content-security-policy"], "sandbox");
    assert.match(buildDownloadHeaders("image/png", "a.png")["content-disposition"], /^inline;/);
  });
});
