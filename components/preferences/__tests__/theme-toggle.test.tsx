// ShapesOS — regression: the sidebar theme toggle must render on the SERVER.
// "use client" components still SSR in the App Router; the first version of
// this component read document.documentElement during render, which threw
// `ReferenceError: document is not defined` and 500'd every shell page in
// the production build (e2e: 23 failures, one shared digest). The painted
// theme is now read after mount; this test renders the component in plain
// Node (no DOM) so a render-scope browser-global access fails loudly here
// instead of in production.
// Run: npx tsx --test components/preferences/__tests__/theme-toggle.test.tsx

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeToggle } from "../ThemeToggle";

describe("ThemeToggle (server render)", () => {
  it("renders without a DOM (no document/window access during render)", () => {
    assert.equal(typeof (globalThis as Record<string, unknown>).document, "undefined");
    assert.equal(typeof (globalThis as Record<string, unknown>).window, "undefined");
    const html = renderToStaticMarkup(<ThemeToggle />);
    assert.match(html, /<button/);
    assert.match(html, /aria-label="/);
  });

  it("is disabled until preferences load (no optimistic toggle without state)", () => {
    const html = renderToStaticMarkup(<ThemeToggle />);
    assert.match(html, /disabled/);
  });
});
