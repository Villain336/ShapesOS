// Marketr — Phase 10 M4: snapshot normalization tests.
// Run: npx tsx --test lib/intelligence/fleet/__tests__/snapshots.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractMeta, normalizeText, snapshotKey, SNAPSHOT_TEXT_CAP } from "../snapshots";

describe("normalizeText", () => {
  it("strips scripts/styles/comments and collapses whitespace", () => {
    const html = `<html><head><style>.x{color:red}</style><script>track()</script></head>
      <body><!-- hidden --><h1>  Hello   <b>World</b> </h1><p>&nbsp;hi&nbsp;</p></body></html>`;
    const t = normalizeText(html);
    assert.ok(!t.includes("track()"), "script content stripped");
    assert.ok(!t.includes("color:red"), "style content stripped");
    assert.ok(!t.includes("hidden"), "comments stripped");
    assert.ok(t.includes("Hello World"), `tags → spaces, got: ${t}`);
    assert.ok(!/  /.test(t), "whitespace collapsed");
  });

  it("decodes common entities", () => {
    assert.equal(normalizeText("<p>&amp; &lt; &gt; &quot;</p>"), "& < > \"");
  });

  it("caps length at SNAPSHOT_TEXT_CAP", () => {
    const t = normalizeText(`<p>${"x ".repeat(10000)}</p>`);
    assert.ok(t.length <= SNAPSHOT_TEXT_CAP);
  });

  it("identical pages normalize identically (layout churn ignored)", () => {
    const a = normalizeText("<html><body><div class='wrap'><p>Pricing</p></div></body></html>");
    const b = normalizeText("<html><body><section id='main'><p>Pricing</p></section></body></html>");
    assert.equal(a, b);
  });
});

describe("extractMeta", () => {
  it("extracts title and meta description (either attribute order)", () => {
    const m = extractMeta(
      `<html><head><title>My Page</title>
       <meta name="description" content="The description."></head></html>`,
    );
    assert.equal(m.title, "My Page");
    assert.equal(m.metaDescription, "The description.");
  });

  it("returns undefined when absent", () => {
    const m = extractMeta("<html><body>no head</body></html>");
    assert.equal(m.title, undefined);
    assert.equal(m.metaDescription, undefined);
  });
});

describe("snapshotKey", () => {
  it("namespaces fleet snapshots away from the business-graph namespace", () => {
    const k = snapshotKey("watch_123");
    assert.ok(k.startsWith("fleet-snapshot:"), k);
    assert.ok(!k.startsWith("competitor:"), "must not collide with the CSA competitor namespace");
  });
});
