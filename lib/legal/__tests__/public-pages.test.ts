// ShapesOS — beta legal pages (WS=legal): the public page registry is the
// ONE list the website footer, the sign-in footer, host routing and the page
// files are checked against. Pure (no DB).
// Run: npx tsx --test lib/legal/__tests__/public-pages.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FOOTER_GROUPS,
  LEGAL_DRAFT_PENDING_REVIEW,
  LEGAL_PAGES,
  SUPPORT_EMAIL_UNSET,
  legalPage,
  supportEmail,
} from "../public-pages";
import { APP_ONLY_PATHS, WEBSITE_ONLY_PATHS, decideHostRoute } from "@/lib/hosting/host-routing";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("public legal pages registry", () => {
  it("lists exactly the beta's public pages", () => {
    assert.deepEqual(
      LEGAL_PAGES.map((p) => p.path),
      ["/terms", "/privacy", "/dpa", "/subprocessors", "/security", "/acceptable-use", "/cookies", "/contact", "/status"],
    );
  });

  it("every page has a page file under app/", () => {
    for (const p of LEGAL_PAGES) assert.ok(existsSync(join(ROOT, "app", p.path.slice(1), "page.tsx")), `${p.path} has no app${p.path}/page.tsx`);
  });

  it("every page is a website page: on the app host it moves to the website host, like /pricing", () => {
    const config = { websiteHost: "shapesos.com", appHost: "app.shapesos.com" };
    for (const p of LEGAL_PAGES) {
      assert.ok((WEBSITE_ONLY_PATHS as readonly string[]).includes(p.path), `${p.path} missing from WEBSITE_ONLY_PATHS`);
      const d = decideHostRoute({ method: "GET", host: "app.shapesos.com", pathname: p.path, search: "", forwardedProto: "https" }, config);
      assert.deepEqual(d, { action: "redirect", location: `https://shapesos.com${p.path}`, status: 308 }, p.path);
      const w = decideHostRoute({ method: "GET", host: "shapesos.com", pathname: p.path, search: "", forwardedProto: "https" }, config);
      assert.deepEqual(w, { action: "pass" }, `${p.path} must be served on the website host`);
    }
  });

  it("/security is public but /security/setup (two-factor setup) still belongs to the app host", () => {
    const config = { websiteHost: "shapesos.com", appHost: "app.shapesos.com" };
    assert.ok(!(APP_ONLY_PATHS as readonly string[]).includes("/security"));
    const d = decideHostRoute({ method: "GET", host: "shapesos.com", pathname: "/security/setup", search: "", forwardedProto: "https" }, config);
    assert.deepEqual(d, { action: "redirect", location: "https://app.shapesos.com/security/setup", status: 308 });
    const s = decideHostRoute({ method: "GET", host: "app.shapesos.com", pathname: "/security/setup", search: "", forwardedProto: "https" }, config);
    assert.deepEqual(s, { action: "pass" });
  });

  it("the website footer links every page, and the sign-in card links terms, privacy, status and contact", () => {
    const inFooter = [...FOOTER_GROUPS.legal, ...FOOTER_GROUPS.trust].sort();
    assert.deepEqual(inFooter, LEGAL_PAGES.map((p) => p.key).sort(), "the footer groups list every page exactly once");
    const footer = read("components/site/SiteFooter.tsx");
    assert.ok(footer.includes("FOOTER_GROUPS.legal") && footer.includes("FOOTER_GROUPS.trust"), "SiteFooter renders both groups");
    const shell = read("components/auth/AuthShell.tsx");
    for (const path of ["/terms", "/privacy", "/status", "/contact"]) assert.ok(shell.includes(`"${path}"`), `AuthShell misses ${path}`);
    // The marketing pages carry the same footer.
    assert.ok(read("app/page.tsx").includes("SiteFooter"));
    assert.ok(read("app/pricing/page.tsx").includes("SiteFooter"));
  });

  it("sign-up shows the consent line (terms + privacy) above the submit button", () => {
    const signup = read("app/signup/SignupClient.tsx");
    assert.ok(signup.includes("legal.consent"), "SignupClient uses the legal.consent strings");
    assert.ok(signup.indexOf("legal.consent") < signup.indexOf('type="submit"'), "consent line comes before the submit button");
  });

  it("the draft flag is one boolean the owner flips after lawyer review", () => {
    assert.equal(typeof LEGAL_DRAFT_PENDING_REVIEW, "boolean");
    // Every legal page renders the draft banner through this flag (grep guard).
    for (const p of LEGAL_PAGES) {
      if (p.path === "/status" || p.path === "/contact") continue;
      const src = read(`app${p.path}/page.tsx`);
      assert.ok(src.includes("LegalPage"), `${p.path} renders through LegalPage (which carries the draft banner)`);
    }
  });

  it("the support address comes from SUPPORT_EMAIL, with an honest placeholder when unset", () => {
    assert.equal(supportEmail({}), SUPPORT_EMAIL_UNSET);
    assert.equal(SUPPORT_EMAIL_UNSET, "set SUPPORT_EMAIL");
    assert.equal(supportEmail({ SUPPORT_EMAIL: "  Help@Example.com " }), "help@example.com");
    assert.equal(supportEmail({ SUPPORT_EMAIL: "not an address" }), SUPPORT_EMAIL_UNSET);
    assert.equal(supportEmail({ SUPPORT_EMAIL: "" }), SUPPORT_EMAIL_UNSET);
  });

  it("legalPage() resolves a path and knows the revision date", () => {
    const terms = legalPage("/terms");
    assert.ok(terms);
    assert.match(terms.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(legalPage("/nope"), null);
  });
});
