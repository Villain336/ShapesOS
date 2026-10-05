// Phase 1 (untrusted content) + Phase 3 (nonce CSP): response security headers.
// Run: npx tsx --test lib/security/__tests__/headers.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  API_CONTENT_SECURITY_POLICY,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  contentSecurityPolicyFor,
  generateCspNonce,
  isUserFileRequest,
  shouldSendHsts,
  USER_CONTENT_CSP,
  USER_FILE_VIEW_CSP,
} from "../headers";
import { brandLogoHeaders } from "../../brand-logo";
import { buildDownloadHeaders } from "../../filesystem/download";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(";").map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name, rest.join(" ")] as [string, string];
    }),
  );
}

const NONCE = "AAECAwQFBgcICQoLDA0ODw==";
const escapeRe = (s: string) => s.replace(/[+/=]/g, "\\$&");

describe("CSP nonce", () => {
  it("is base64 of 128 random bits and fresh every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = generateCspNonce();
      assert.match(n, /^[A-Za-z0-9+/]{22}==$/);
      assert.equal(Buffer.from(n, "base64").length, 16);
      seen.add(n);
    }
    assert.equal(seen.size, 200);
  });

  it("is what Next's renderer extracts from the policy (so its scripts get stamped)", () => {
    const n = generateCspNonce();
    assert.equal(getScriptNonceFromHeader(buildContentSecurityPolicy({ nonce: n })), n);
    assert.equal(getScriptNonceFromHeader(buildContentSecurityPolicy({ nonce: n, dev: true })), n);
  });

  it("rejects a malformed nonce instead of emitting a policy Next can't parse", () => {
    assert.throws(() => buildContentSecurityPolicy({ nonce: "" }));
    assert.throws(() => buildContentSecurityPolicy({ nonce: "abcdefghijklmnop' 'unsafe-inline" }));
    assert.throws(() => buildContentSecurityPolicy({ nonce: "short" }));
  });
});

describe("page Content-Security-Policy (nonce-based)", () => {
  const d = directives(buildContentSecurityPolicy({ nonce: NONCE }));
  const script = d.get("script-src")!;

  it("runs only nonce'd scripts (+ what they load): no 'unsafe-inline', no eval in production", () => {
    assert.match(script, new RegExp(`'nonce-${escapeRe(NONCE)}'`));
    assert.match(script, /'strict-dynamic'/);
    assert.doesNotMatch(script, /'unsafe-inline'/);
    assert.doesNotMatch(script, /'unsafe-eval'/);
    assert.doesNotMatch(script, /(^|\s)http:/, "no cleartext script origins");
    assert.doesNotMatch(script, /\*/);
  });

  it("allows eval only in dev (React dev error-stack reconstruction)", () => {
    const dev = directives(buildContentSecurityPolicy({ nonce: NONCE, dev: true }));
    assert.match(dev.get("script-src")!, /'unsafe-eval'/);
    assert.doesNotMatch(dev.get("script-src")!, /'unsafe-inline'/);
  });

  it("blocks inline event handlers and plugins; locks base/framing", () => {
    assert.equal(d.get("script-src-attr"), "'none'");
    assert.equal(d.get("object-src"), "'none'");
    assert.equal(d.get("base-uri"), "'self'");
    assert.equal(d.get("frame-ancestors"), "'self'");
    assert.equal(d.get("default-src"), "'self'");
  });

  it("keeps what the app needs (inline styles, data:/blob: images, blob workers)", () => {
    assert.match(d.get("style-src")!, /'unsafe-inline'/);
    assert.match(d.get("img-src")!, /data:/);
    assert.match(d.get("img-src")!, /blob:/);
    assert.match(d.get("worker-src")!, /blob:/);
  });

  it("does not emit upgrade-insecure-requests (would break plain-http LAN installs)", () => {
    assert.equal(d.has("upgrade-insecure-requests"), false);
  });

  it("puts script-src before script-src-attr (Next reads the first script-src* directive)", () => {
    const csp = buildContentSecurityPolicy({ nonce: NONCE });
    assert.ok(csp.indexOf("script-src ") < csp.indexOf("script-src-attr"));
  });
});

describe("API Content-Security-Policy", () => {
  const d = directives(API_CONTENT_SECURITY_POLICY);

  it("is scriptless and sandboxed — at least as strict as the per-route user-content policies it supersedes", () => {
    assert.equal(d.get("default-src"), "'none'");
    assert.equal(d.has("script-src"), false);
    assert.match(d.get("sandbox") ?? "", /allow-forms/);
    assert.doesNotMatch(d.get("sandbox") ?? "", /allow-scripts|allow-same-origin/);
    assert.equal(d.get("frame-ancestors"), "'self'");
    assert.equal(d.get("base-uri"), "'none'");
  });

  it("is chosen for /api paths; everything else gets the nonce policy", () => {
    assert.equal(contentSecurityPolicyFor("/api/projects", { nonce: NONCE }), API_CONTENT_SECURITY_POLICY);
    assert.equal(contentSecurityPolicyFor("/api", { nonce: NONCE }), API_CONTENT_SECURITY_POLICY);
    for (const p of ["/", "/dashboard", "/apiary", "/admin", "/r/funding/x", "/s/abc"]) {
      assert.equal(getScriptNonceFromHeader(contentSecurityPolicyFor(p, { nonce: NONCE })), NONCE, p);
    }
  });
});

describe("user file view Content-Security-Policy (outside /api)", () => {
  const d = directives(USER_FILE_VIEW_CSP);

  it("is sandboxed and scriptless, like the project-download policy", () => {
    assert.equal(d.has("sandbox"), true);
    assert.equal(d.get("sandbox"), "", "no allow-* tokens: no scripts, forms, popups or same-origin");
    assert.equal(d.get("default-src"), "'none'");
    assert.equal(d.has("script-src"), false);
    assert.equal(d.get("frame-ancestors"), "'self'", "only our own viewer page may frame it");
    assert.equal(d.get("form-action"), "'none'");
  });

  it("is chosen only for the data-room file stream", () => {
    assert.equal(isUserFileRequest("/r/funding/abc", "?dl=1"), true);
    assert.equal(isUserFileRequest("/r/funding/abc", new URLSearchParams("v=1&dl=1")), true);
    assert.equal(isUserFileRequest("/r/funding/abc", "?v=1"), false);
    assert.equal(isUserFileRequest("/r/funding/abc/views/x", "?dl=1"), false);
    assert.equal(isUserFileRequest("/dashboard", "?dl=1"), false);
    assert.equal(contentSecurityPolicyFor("/r/funding/abc", { nonce: NONCE, search: "?dl=1" }), USER_FILE_VIEW_CSP);
    assert.equal(contentSecurityPolicyFor("/api/files/x", { nonce: NONCE, search: "?dl=1" }), API_CONTENT_SECURITY_POLICY);
    assert.equal(getScriptNonceFromHeader(contentSecurityPolicyFor("/r/funding/abc", { nonce: NONCE })), NONCE);
  });
});

describe("security header set", () => {
  it("carries nosniff + frame options, never a CSP (proxy.ts owns it); HSTS only when asked", () => {
    const keys = (h: Array<{ key: string }>) => h.map((x) => x.key);
    assert.ok(!keys(buildSecurityHeaders({ hsts: true })).includes("Content-Security-Policy"));
    assert.ok(keys(buildSecurityHeaders({ hsts: false })).includes("X-Content-Type-Options"));
    assert.ok(keys(buildSecurityHeaders({ hsts: false })).includes("X-Frame-Options"));
    assert.ok(!keys(buildSecurityHeaders({ hsts: false })).includes("Strict-Transport-Security"));
    assert.ok(keys(buildSecurityHeaders({ hsts: true })).includes("Strict-Transport-Security"));
  });

  it("sends HSTS in production unless NEXTAUTH_URL is explicitly http://", () => {
    assert.equal(shouldSendHsts({ NODE_ENV: "production" }), true);
    assert.equal(shouldSendHsts({ NODE_ENV: "production", NEXTAUTH_URL: "https://app.example" }), true);
    assert.equal(shouldSendHsts({ NODE_ENV: "production", NEXTAUTH_URL: "http://10.0.0.5:3000" }), false);
    assert.equal(shouldSendHsts({ NODE_ENV: "development", NEXTAUTH_URL: "https://app.example" }), false);
  });

  it("next.config.ts wires the static headers, sends no CSP of its own, disables X-Powered-By", () => {
    const src = readFileSync(new URL("../../../next.config.ts", import.meta.url), "utf8");
    assert.match(src, /poweredByHeader:\s*false/);
    assert.match(src, /buildSecurityHeaders\(/);
    assert.match(src, /source:\s*"\/:path\*",\s*headers:\s*securityHeaders/);
    assert.doesNotMatch(src, /buildContentSecurityPolicy|key:\s*"Content-Security-Policy"/);
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
