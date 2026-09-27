// Marketr — Phase 11 "Canvas": Iconify integration tests.
// Run: npx tsx --test lib/design/__tests__/iconify.test.ts
//
// License-safety tests are load-bearing: the allowlist-equality test and the
// excluded-prefix tests MUST fail if someone adds openmoji/entypo (or any
// other set) to PERMISSIVE_PREFIXES.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EXCLUDED_PREFIXES,
  ICONIFY_API_BASE,
  ICONIFY_SEARCH_LIMIT,
  MAX_ICON_BODY_BYTES,
  PERMISSIVE_PREFIXES,
  IconifyApiError,
  IconifyBodyTooLargeError,
  IconifyPrefixError,
  assertBodySize,
  assertPrefixAllowed,
  buildSearchUrl,
  iconDataUrl,
  isPrefixAllowed,
  parseIconSvg,
  parseViewBoxSize,
  sanitizeSvgBody,
} from "../iconify";

describe("PERMISSIVE_PREFIXES", () => {
  it("contains exactly the expected permissive sets — any addition fails", () => {
    // If you are editing this list: each prefix must be MIT, Apache-2.0,
    // ISC, or CC0. Verify the license at the Iconify collection page first.
    // CC-BY sets need attribution UI; CC-BY-SA/GPL/NC sets are hard-banned.
    assert.deepEqual([...PERMISSIVE_PREFIXES], [
      "mdi",
      "material-symbols",
      "lucide",
      "tabler",
      "heroicons",
      "bi",
      "ph",
      "fluent",
      "ri",
      "carbon",
      "devicon",
      "simple-icons",
      "logos",
      "noto",
    ]);
  });

  it("never contains openmoji (CC BY-SA landmine)", () => {
    assert.ok(!PERMISSIVE_PREFIXES.includes("openmoji"));
    assert.ok(!isPrefixAllowed("openmoji"));
    assert.ok(!isPrefixAllowed("OpenMoji"));
  });

  it("never contains the CC-BY-SA / GPL / NC sets", () => {
    for (const bad of ["entypo", "arcticons", "dashicons", "gridicons", "wordpress", "et", "cbi", "ps"]) {
      assert.ok(!PERMISSIVE_PREFIXES.includes(bad), `${bad} must not be allowlisted`);
      assert.ok(!isPrefixAllowed(bad), `${bad} must be rejected by the guard`);
    }
  });

  it("never contains CC-BY sets (attribution required) in the default list", () => {
    // font-awesome / line-awesome / icomoon are commercial-safe but need
    // attribution; they stay out of the no-attribution default picker.
    for (const ccby of ["fa6-solid", "fa6-regular", "fa6-brands", "line-awesome", "icomoon-free"]) {
      assert.ok(!isPrefixAllowed(ccby), `${ccby} must not be in the default allowlist`);
    }
  });
});

describe("EXCLUDED_PREFIXES", () => {
  it("lists every banned set from the brief", () => {
    assert.deepEqual([...EXCLUDED_PREFIXES], [
      "entypo",
      "arcticons",
      "dashicons",
      "gridicons",
      "wordpress",
      "et",
      "cbi",
      "ps",
      "openmoji",
    ]);
  });

  it("rejects every excluded prefix via the guard", () => {
    for (const p of EXCLUDED_PREFIXES) {
      assert.equal(isPrefixAllowed(p), false);
      assert.throws(() => assertPrefixAllowed(p), IconifyPrefixError);
    }
  });
});

describe("isPrefixAllowed", () => {
  it("allows every allowlisted prefix", () => {
    for (const p of PERMISSIVE_PREFIXES) assert.equal(isPrefixAllowed(p), true);
  });

  it("normalizes case and whitespace", () => {
    assert.equal(isPrefixAllowed("  Lucide "), true);
    assert.equal(isPrefixAllowed("MDI"), true);
  });

  it("rejects unknown and malformed prefixes", () => {
    for (const bad of ["", "   ", "font-awesome", "../mdi", "mdi;drop", "mdi\nlucide", "openmoji "]) {
      // note: "openmoji " normalizes to "openmoji" — still rejected
      assert.equal(isPrefixAllowed(bad), false, JSON.stringify(bad));
    }
  });
});

describe("buildSearchUrl", () => {
  it("builds the documented search URL against the configurable host", () => {
    const url = new URL(buildSearchUrl("rocket", ["lucide", "tabler"]));
    assert.equal(url.origin + url.pathname, `${ICONIFY_API_BASE}/search`);
    assert.equal(url.searchParams.get("query"), "rocket");
    assert.equal(url.searchParams.get("limit"), String(ICONIFY_SEARCH_LIMIT));
    assert.equal(url.searchParams.get("prefixes"), "lucide,tabler");
  });

  it("defaults to the full allowlist when no prefixes are given", () => {
    const url = new URL(buildSearchUrl("arrow"));
    assert.equal(url.searchParams.get("prefixes"), [...PERMISSIVE_PREFIXES].join(","));
  });

  it("refuses to build a URL for a non-allowlisted prefix", () => {
    assert.throws(() => buildSearchUrl("smile", ["openmoji"]), IconifyPrefixError);
    assert.throws(() => buildSearchUrl("smile", ["entypo"]), IconifyPrefixError);
    assert.throws(() => buildSearchUrl("smile", ["lucide", "dashicons"]), IconifyPrefixError);
  });

  it("rejects empty queries", () => {
    assert.throws(() => buildSearchUrl("   "), IconifyApiError);
  });
});

describe("sanitizeSvgBody", () => {
  it("strips script elements", () => {
    const out = sanitizeSvgBody(`<path d="M0 0h24v24H0z"/><script>alert("xss")</script><SCRIPT>evil()</SCRIPT>`);
    assert.ok(!/script/i.test(out));
    assert.ok(out.includes("<path"));
  });

  it("strips event-handler attributes", () => {
    const out = sanitizeSvgBody(
      `<path d="M0 0h24v24H0z" onclick="steal()" ONLOAD='x' onmouseover=hover() fill="red"/>`,
    );
    assert.ok(!/on(click|load|mouseover)/i.test(out));
    assert.ok(out.includes('fill="red"'));
    assert.ok(out.includes('d="M0 0h24v24H0z"'));
  });

  it("strips style elements and inline style attributes", () => {
    const out = sanitizeSvgBody(
      `<style>.a{fill:red}@keyframes x{}</style><path d="M0 0" style="fill:red;stroke:blue" class="a"/>`,
    );
    assert.ok(!/style/i.test(out));
    assert.ok(out.includes('class="a"'));
  });

  it("strips SMIL animation elements", () => {
    const out = sanitizeSvgBody(
      `<circle cx="12" cy="12" r="5"><animate attributeName="r" values="5;10" dur="1s" repeatCount="indefinite"/></circle><set attributeName="fill" to="red"/><animateTransform attributeName="transform" type="rotate" from="0" to="360"/>`,
    );
    assert.ok(!/animate|set attributeName/i.test(out));
    assert.ok(out.includes("<circle"));
  });

  it("strips foreignObject", () => {
    const out = sanitizeSvgBody(
      `<foreignObject width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject><path d="M0 0"/>`,
    );
    assert.ok(!/foreignObject|div/i.test(out));
    assert.ok(out.includes("<path"));
  });

  it("strips javascript: hrefs but keeps internal fragment refs", () => {
    const out = sanitizeSvgBody(
      `<use href="javascript:alert(1)"/><use xlink:href="data:text/html,<h1>x</h1>"/><use href="#grad1"/>`,
    );
    assert.ok(!/javascript:|data:text\/html/i.test(out));
    assert.ok(out.includes('href="#grad1"'));
  });

  it("strips comments", () => {
    const out = sanitizeSvgBody(`<!-- tracker --><path d="M0 0"/>`);
    assert.ok(!/tracker/.test(out));
  });

  it("leaves a clean icon body untouched", () => {
    const body = `<path fill="currentColor" d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/>`;
    assert.equal(sanitizeSvgBody(body), body);
  });
});

describe("assertBodySize", () => {
  it("accepts bodies at the cap and rejects anything larger", () => {
    assert.doesNotThrow(() => assertBodySize("x".repeat(MAX_ICON_BODY_BYTES)));
    assert.throws(
      () => assertBodySize("x".repeat(MAX_ICON_BODY_BYTES + 1)),
      IconifyBodyTooLargeError,
    );
  });
});

describe("parseIconSvg", () => {
  it("extracts the viewBox and inner body", () => {
    const { body, viewBox } = parseIconSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>`,
    );
    assert.equal(viewBox, "0 0 24 24");
    assert.equal(body, `<path d="M0 0h24v24H0z"/>`);
  });

  it("refuses SVGs without a viewBox", () => {
    assert.throws(
      () => parseIconSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>`),
      IconifyApiError,
    );
  });
});

describe("parseViewBoxSize", () => {
  it("parses width/height from a viewBox", () => {
    assert.deepEqual(parseViewBoxSize("0 0 24 24"), { w: 24, h: 24 });
    assert.deepEqual(parseViewBoxSize("0 0 48 16"), { w: 48, h: 16 });
  });

  it("falls back to 24x24 on garbage", () => {
    assert.deepEqual(parseViewBoxSize(""), { w: 24, h: 24 });
    assert.deepEqual(parseViewBoxSize("bogus"), { w: 24, h: 24 });
  });
});

describe("iconDataUrl", () => {
  it("builds a self-contained data URL with the fill as color", () => {
    const url = iconDataUrl(`<path d="M0 0"/>`, "0 0 24 24", "#7c3aed");
    assert.ok(url.startsWith("data:image/svg+xml,"));
    const decoded = decodeURIComponent(url.slice("data:image/svg+xml,".length));
    assert.ok(decoded.includes("viewBox=\"0 0 24 24\""));
    assert.ok(decoded.includes('color="#7c3aed"'));
    assert.ok(decoded.includes("<path"));
    assert.ok(!decoded.startsWith("http"));
  });
});
