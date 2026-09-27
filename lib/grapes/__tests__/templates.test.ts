// Marketr — Phase 12 (Worker 1): GrapesJS seed-template tests.
// Run: npx tsx --test lib/grapes/__tests__/templates.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyBrand,
  BRAND_TOKENS,
  DEFAULT_BRAND,
  getGrapesTemplate,
  GRAPES_TEMPLATES,
  grapesTemplatesByKind,
} from "../templates";

describe("grapes seed templates", () => {
  it("ships 6 landing + 2 email templates", () => {
    assert.equal(grapesTemplatesByKind("landing").length, 6);
    assert.equal(grapesTemplatesByKind("email").length, 2);
    assert.equal(GRAPES_TEMPLATES.length, 8);
  });

  it("has unique keys and required metadata", () => {
    const keys = GRAPES_TEMPLATES.map((t) => t.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const t of GRAPES_TEMPLATES) {
      assert.match(t.key, /^[a-z0-9-]+$/);
      assert.ok(t.name.length > 0);
      assert.ok(t.description.length > 0);
      assert.ok(t.html.includes("<"));
    }
  });

  it("exposes the required template set", () => {
    for (const key of ["hero-saas", "webinar", "newsletter-landing", "product-launch", "event", "coming-soon"]) {
      const t = getGrapesTemplate(key);
      assert.ok(t, key);
      assert.equal(t!.kind, "landing");
    }
    for (const key of ["email-newsletter", "email-promo"]) {
      const t = getGrapesTemplate(key);
      assert.ok(t, key);
      assert.equal(t!.kind, "email");
    }
    assert.equal(getGrapesTemplate("nope"), undefined);
  });

  it("email templates are table-based (email-client safe)", () => {
    for (const t of grapesTemplatesByKind("email")) {
      assert.ok(t.html.includes("<table"), `${t.key} must use tables`);
      assert.ok(t.html.includes('width="600"'), `${t.key} must be 600px wide`);
    }
  });

  it("substitutes every brand token and leaves none behind", () => {
    for (const t of GRAPES_TEMPLATES) {
      const { html, css } = applyBrand(t.html, t.css, {
        primary: "#111111",
        secondary: "#222222",
        accent: "#333333",
        text: "#444444",
        headingFont: "Georgia, serif",
        bodyFont: "Arial, sans-serif",
      });
      for (const tok of BRAND_TOKENS) {
        assert.ok(!html.includes(tok), `${t.key} html still has ${tok}`);
        assert.ok(!css.includes(tok), `${t.key} css still has ${tok}`);
      }
      assert.ok(html.includes("#111111") || css.includes("#111111"), `${t.key} missing primary`);
    }
  });

  it("defaults keep templates renderable with no brand kit", () => {
    for (const t of GRAPES_TEMPLATES) {
      const { html, css } = applyBrand(t.html, t.css, {});
      for (const tok of BRAND_TOKENS) assert.ok(!html.includes(tok));
      assert.ok(
        html.includes(DEFAULT_BRAND.primary) || css.includes(DEFAULT_BRAND.primary),
        `${t.key} missing default primary`,
      );
    }
  });

  it("contains no emoji in template copy (Lucide-only UI rule)", () => {
    // ✦/◈/●/✓ are geometric glyphs used as logo marks, not emoji — allowlist them.
    const stripped = (s: string) => s.replace(/[✦◈●✓]/g, "");
    const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const t of GRAPES_TEMPLATES) {
      assert.ok(!emojiRe.test(stripped(t.html)), `${t.key} html has emoji`);
      assert.ok(!emojiRe.test(stripped(t.css)), `${t.key} css has emoji`);
    }
  });
});
