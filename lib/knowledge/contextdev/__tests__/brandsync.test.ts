// Marketr — Wave 2 context.dev slice 5 tests: brand-kit diff (pure).
// Run: npx tsx --test lib/knowledge/contextdev/__tests__/brandsync.test.ts
//
// Pure: no database, no network. Covers the approval-gating diff — what
// changes get proposed, what gets ignored, and the new-kit case.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { diffBrandKit, type BrandKitSnapshot } from "../brandsync";
import type { BrandProfile } from "../client";

function profile(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return { domain: "example.com", raw: {}, ...overrides };
}

function kit(overrides: Partial<BrandKitSnapshot> = {}): BrandKitSnapshot {
  return {
    name: "Example",
    colors: { primary: "#7c3aed" },
    fonts: { heading: "Inter", body: "Inter" },
    logoPath: null,
    ...overrides,
  };
}

describe("diffBrandKit", () => {
  it("returns an empty diff when nothing changed", () => {
    const d = diffBrandKit(
      kit(),
      profile({ name: "Example", colors: ["#7c3aed"], fonts: ["Inter"] }),
    );
    assert.deepEqual(d, []);
  });

  it("proposes changed colors, name, and fonts", () => {
    const d = diffBrandKit(
      kit(),
      profile({
        name: "Example Inc",
        colors: ["#ff0000", "#00ff00"],
        fonts: ["Space Grotesk", "IBM Plex Sans"],
      }),
    );
    const byField = Object.fromEntries(d.map((e) => [e.field, e]));
    assert.equal(byField["name"].proposed, "Example Inc");
    assert.equal(byField["name"].current, "Example");
    assert.equal(byField["colors.primary"].proposed, "#ff0000");
    assert.equal(byField["colors.secondary"].proposed, "#00ff00");
    assert.equal(byField["fonts.heading"].proposed, "Space Grotesk");
    assert.equal(byField["fonts.body"].proposed, "IBM Plex Sans");
  });

  it("ignores non-hex vendor color garbage", () => {
    const d = diffBrandKit(kit(), profile({ colors: ["red", "not-a-color"] }));
    assert.ok(!d.some((e) => e.field.startsWith("colors")));
  });

  it("compares hex case-insensitively", () => {
    const d = diffBrandKit(kit(), profile({ colors: ["#7C3AED"] }));
    assert.ok(!d.some((e) => e.field === "colors.primary"));
  });

  it("proposes the logo URL from the profile", () => {
    const d = diffBrandKit(kit(), profile({ logos: [{ url: "https://example.com/logo.png" }] }));
    const logo = d.find((e) => e.field === "logo");
    assert.equal(logo?.proposed, "https://example.com/logo.png");
    assert.equal(logo?.current, null);
  });

  it("treats a null kit (create-on-approve) as all-new", () => {
    const d = diffBrandKit(
      null,
      profile({ name: "New Co", colors: ["#123456"], fonts: ["Manrope"] }),
    );
    assert.ok(d.length > 0);
    assert.ok(d.every((e) => e.current === null));
    assert.ok(d.some((e) => e.field === "name" && e.proposed === "New Co"));
  });

  it("is deterministic", () => {
    const k = kit();
    const p = profile({ name: "X", colors: ["#abcdef"] });
    assert.deepEqual(diffBrandKit(k, p), diffBrandKit(k, p));
  });
});
