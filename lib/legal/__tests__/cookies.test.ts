// ShapesOS — beta legal pages (WS=legal): the cookie registry /cookies
// renders must name every cookie the code sets, and every one must be
// strictly necessary (no analytics or advertising cookies), which is why the
// site has no consent banner. The cookie NAMES are read from the modules
// that define them, so a renamed or added cookie fails here. Pure (no DB).
// Run: npx tsx --test lib/legal/__tests__/cookies.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COOKIES, COOKIE_CATEGORY_LABEL, cookieEntryFor, needsConsentBanner } from "../cookies";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** `export const NAME = "value"` from a source file (the modules pull in auth/prisma; we don't import them). */
function constant(file: string, name: string): string {
  const m = read(file).match(new RegExp(`export const ${name} = "([^"]+)"`));
  assert.ok(m, `${file} defines ${name}`);
  return m[1];
}

describe("cookie registry", () => {
  it("covers every first-party cookie the code sets, by its real name", () => {
    const expected = [
      ...["__Secure-authjs.session-token", "authjs.session-token"], // lib/auth/mfa/token.ts SESSION_COOKIE_NAMES
      constant("lib/session.ts", "ACTIVE_WORKSPACE_COOKIE"),
      constant("lib/preferences/shell.ts", "SHELL_COOKIE"),
      constant("lib/portal/core.ts", "PORTAL_COOKIE"),
      constant("lib/sandbox/preview.ts", "PREVIEW_COOKIE"),
      constant("lib/funding/viewer-verify.ts", "VIEWER_COOKIE"),
      "shapes_cart_<store id>", // lib/ops/store/cart.ts cartCookieName
      "authjs.csrf-token",
      "authjs.callback-url",
      "payload-token",
    ];
    for (const name of expected) assert.ok(cookieEntryFor(name), `registry misses ${name}`);
    // The names in lib/auth/mfa/token.ts are the ones Auth.js really uses.
    const names = read("lib/auth/mfa/token.ts").match(/SESSION_COOKIE_NAMES = \[([^\]]+)\]/)![1];
    for (const n of ["__Secure-authjs.session-token", "authjs.session-token"]) assert.ok(names.includes(`"${n}"`), n);
    assert.equal(read("lib/ops/store/cart.ts").includes("`shapes_cart_${"), true, "cart cookie prefix unchanged");
  });

  it("every cookie is strictly necessary, so no consent banner is shown", () => {
    for (const c of COOKIES) assert.equal(c.category, "strictly_necessary", `${c.name} is ${c.category}`);
    assert.equal(needsConsentBanner(), false);
    assert.ok(Object.keys(COOKIE_CATEGORY_LABEL).includes("strictly_necessary"));
  });

  it("names the lifetimes the code sets", () => {
    assert.match(cookieEntryFor("authjs.session-token")!.lifetime, /12 hours/); // auth.ts session.maxAge
    assert.match(cookieEntryFor("shapes_shell")!.lifetime, /1 year/); // SHELL_COOKIE_MAX_AGE
    assert.match(cookieEntryFor("shapes_portal")!.lifetime, /7 days/); // PORTAL_SESSION_TTL_MS
    assert.match(cookieEntryFor("shapes_preview")!.lifetime, /1 hour/); // PREVIEW_TOKEN_TTL_SECONDS
    assert.match(cookieEntryFor("shapes_cart_<store id>")!.lifetime, /30 days/); // CART_MAX_AGE_S
    assert.match(cookieEntryFor("marketr_active_workspace")!.lifetime, /1 year/);
    for (const c of COOKIES) assert.ok(c.httpOnly !== undefined && c.purpose.length > 20, c.name);
  });

  it("a cookie that is not in the registry is reported", () => {
    assert.equal(cookieEntryFor("_ga"), null);
  });
});
