// Marketr — Phase 16 slice 9: brand-kit CSS tests.
// Run: npx tsx --test lib/reports/__tests__/brand-css.test.ts
//
// Proves the dynamic-theming law: default violet when no brand kit is set, and
// the tenant kit's colors/fonts/wordmark override the :root block (the proof's
// injection mechanism). Malformed values fall back safely (no CSS injection).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildBrandOverrideCss,
  brandKitRowToInput,
  DEFAULT_REPORT_BRAND,
} from "@/lib/reports/brand-css";

describe("brand-kit → report CSS", () => {
  it("defaults to violet with no kit", () => {
    const css = buildBrandOverrideCss(null);
    assert.match(css, new RegExp(`--brand-primary: ${DEFAULT_REPORT_BRAND.primary}`));
    assert.match(css, /--brand-wordmark: "MARKETR"/);
  });

  it("overrides tokens from the tenant kit", () => {
    const css = buildBrandOverrideCss(
      brandKitRowToInput({
        name: "Acme Co",
        colors: { primary: "#0e7c86", secondary: "#07333a", text: "#111111", muted: "#444444" },
        fonts: { heading: "Georgia", body: "Helvetica" },
      }),
    );
    assert.match(css, /--brand-primary: #0e7c86/);
    assert.match(css, /--brand-primary-deep: #07333a/);
    assert.match(css, /--brand-wordmark: "ACME CO"/);
    assert.match(css, /--brand-font-display: "Georgia"/);
    assert.match(css, /--brand-font-body: "Helvetica"/);
  });

  it("falls back on malformed colors and rejects CSS injection", () => {
    const css = buildBrandOverrideCss(
      brandKitRowToInput({
        name: 'evil"; } .x { color: red',
        colors: { primary: "not-a-color", text: "#12345" },
        fonts: { heading: 'x"; } body{color:red' },
      }),
    );
    assert.match(css, new RegExp(`--brand-primary: ${DEFAULT_REPORT_BRAND.primary}`));
    assert.doesNotMatch(css, /\.x \{ color: red/);
    assert.doesNotMatch(css, /body\{color:red/);
  });

  it("tolerates unknown row shapes", () => {
    const input = brandKitRowToInput({ colors: { primary: 42 }, fonts: null } as never);
    assert.equal(input.colors?.primary, undefined);
    assert.doesNotThrow(() => buildBrandOverrideCss(input));
  });
});
