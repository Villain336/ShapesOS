// ShapesOS — Agentic OS design-system guard (Phase 4c).
// The Tailwind default-palette compat block is gone from app/globals.css:
// docs/design/tailwind.css clears Tailwind's default colors, so a stone-500 /
// violet-600 / emerald-50 class would now emit NO CSS and render unstyled.
// This scan fails on any default-palette utility or arbitrary hex color class
// in app UI code. Use the Agentic OS tokens (docs/design/DESIGN.md).
// Run: npx tsx --test lib/design/__tests__/no-legacy-palette.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");

const PALETTE =
  /\b(?:bg|text|border|ring|from|to|via|fill|stroke|divide|outline|placeholder|accent|caret|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;
const HEX_CLASS = /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|decoration|shadow)-\[#[0-9a-fA-F]{3,8}\]/g;

// Files that emit markup for a DIFFERENT stylesheet, not the app's.
const ALLOW: Record<string, string> = {
  // Generated customer websites load their own Tailwind (CDN) build.
  "app/api/websites/generate/route.ts": "generated-site template with its own Tailwind",
};

function uiFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "app", "components", "lib"], { cwd: ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .filter((f) => /\.(tsx|ts|jsx)$/.test(f) && !f.includes("__tests__/"));
}

describe("Agentic OS tokens only", () => {
  it("no Tailwind default-palette classes in app UI code", () => {
    const hits: string[] = [];
    for (const f of uiFiles()) {
      if (ALLOW[f]) continue;
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const m of src.matchAll(PALETTE)) hits.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(hits.slice(0, 20), [], `${hits.length} legacy palette class(es) — use Agentic OS tokens`);
  });

  it("no arbitrary hex color classes in app UI code", () => {
    const hits: string[] = [];
    for (const f of uiFiles()) {
      if (ALLOW[f]) continue;
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const m of src.matchAll(HEX_CLASS)) hits.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(hits.slice(0, 20), [], `${hits.length} hex color class(es) — use Agentic OS tokens`);
  });

  it("globals.css no longer re-anchors the default palettes", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    assert.doesNotMatch(css, /--color-(?:stone|slate|gray|zinc|neutral|violet|emerald|red|rose|amber|blue)-\d{2,3}\s*:/);
  });
});
