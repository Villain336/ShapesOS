// Marketr — Phase 11 "Canvas": brand-AI lib tests (integration #10).
// Covers Colormind request shaping + response parsing + the fail-closed
// disabled state, and texture manifest integrity + provenance metadata.
// Run: npx tsx --test lib/design/__tests__/brand-ai.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  COLORMIND_DISABLED_REASON,
  COLORMIND_ENABLED,
  ColormindRequestError,
  buildPaletteRequest,
  colormindStatus,
  fetchColormindPalette,
  hexToRgb,
  parsePaletteResponse,
  rgbToHex,
} from "../colormind";
import {
  TEXTURE_LICENSE,
  TEXTURE_LICENSE_URL,
  TEXTURE_SOURCE_URL,
  TEXTURES,
  getTexture,
  hasTexture,
  textureFillProps,
  textureProvenance,
  withTextureProvenance,
} from "../textures";

describe("hexToRgb / rgbToHex", () => {
  it("converts a valid 6-digit hex color to an RGB triple", () => {
    assert.deepEqual(hexToRgb("#7c3aed"), [124, 58, 237]);
    assert.deepEqual(hexToRgb("7C3AED"), [124, 58, 237]);
  });
  it("rejects anything that is not a 6-digit hex color", () => {
    for (const bad of ["", "#fff", "red", "#gggggg", "#12345", "rgb(1,2,3)"]) {
      assert.throws(() => hexToRgb(bad), ColormindRequestError);
    }
  });
  it("round-trips RGB through hex", () => {
    assert.equal(rgbToHex([124, 58, 237]), "#7c3aed");
    assert.equal(rgbToHex([0, 0, 0]), "#000000");
    assert.equal(rgbToHex([300, -5, 128.6]), "#ff0081"); // clamps + rounds
  });
});

describe("buildPaletteRequest", () => {
  it("locks the brand color in slot 1 and leaves four N placeholders", () => {
    assert.deepEqual(buildPaletteRequest("#2c2c2c"), {
      model: "default",
      input: [[44, 44, 44], "N", "N", "N", "N"],
    });
  });
  it("honors a custom model name", () => {
    assert.equal(buildPaletteRequest("#ffffff", "ui").model, "ui");
  });
  it("rejects a missing or malformed brand color", () => {
    assert.throws(() => buildPaletteRequest(""), ColormindRequestError);
    assert.throws(() => buildPaletteRequest("not-a-color"), ColormindRequestError);
  });
});

describe("parsePaletteResponse", () => {
  const good = { result: [[44, 43, 44], [90, 83, 82], [133, 155, 143], [226, 209, 167], [235, 198, 126]] };
  it("parses a well-formed 5-color response into hex strings", () => {
    assert.deepEqual(parsePaletteResponse(good), ["#2c2b2c", "#5a5352", "#859b8f", "#e2d1a7", "#ebc67e"]);
  });
  it("rejects malformed responses instead of inventing palettes", () => {
    for (const bad of [null, {}, { result: [] }, { result: [[1, 2]] }, { result: "nope" }, 42]) {
      assert.throws(() => parsePaletteResponse(bad), ColormindRequestError);
    }
  });
});

describe("colormind disabled state (fail-closed licensing)", () => {
  it("the integration is hard-disabled until commercial terms clear", () => {
    assert.equal(COLORMIND_ENABLED, false);
  });
  it("status() reports disabled with the honest reason", () => {
    const s = colormindStatus();
    assert.equal(s.name, "colormind");
    assert.equal(s.enabled, false);
    assert.equal(s.reason, COLORMIND_DISABLED_REASON);
  });
  it("the disabled message names the non-commercial restriction and the contact", () => {
    assert.match(COLORMIND_DISABLED_REASON, /non-commercial/i);
    assert.match(COLORMIND_DISABLED_REASON, /jack@colormind\.io/);
  });
  it("fetchColormindPalette refuses without touching the network", async () => {
    let called = false;
    await assert.rejects(
      () =>
        fetchColormindPalette("#2c2c2c", "default", async () => {
          called = true;
          return new Response("{}");
        }),
      ColormindRequestError,
    );
    assert.equal(called, false, "disabled integration must not issue HTTP requests");
  });
});

describe("texture manifest integrity", () => {
  it("ships a curated set of 8–12 textures", () => {
    assert.ok(TEXTURES.length >= 8 && TEXTURES.length <= 12, `expected 8–12, got ${TEXTURES.length}`);
  });
  it("every entry carries id, name, source, license string, and a local path", () => {
    const ids = new Set<string>();
    for (const t of TEXTURES) {
      assert.ok(t.id && typeof t.id === "string", "id required");
      assert.ok(!ids.has(t.id), `duplicate texture id ${t.id}`);
      ids.add(t.id);
      assert.ok(t.name && typeof t.name === "string", `name required for ${t.id}`);
      assert.equal(t.source, "ambientCG");
      assert.ok(t.license.includes(TEXTURE_LICENSE), `license string required for ${t.id}`);
      assert.ok(t.path.startsWith("/textures/"), `path must be a local bundle under /textures/, got ${t.path} for ${t.id}`);
      assert.match(t.sourceUrl, /^https:\/\/ambientcg\.com\/a\/[A-Za-z0-9]+$/, `bad sourceUrl for ${t.id}`);
      assert.ok(t.baseFill && /^#[0-9a-f]{6}$/i.test(t.baseFill), `baseFill must be hex for ${t.id}`);
    }
  });
  it("every texture is CC0 with a license URL", () => {
    assert.equal(TEXTURE_LICENSE, "CC0 1.0 Universal");
    assert.match(TEXTURE_LICENSE_URL, /^https:\/\//);
    assert.equal(TEXTURE_SOURCE_URL, "https://ambientcg.com");
  });
  it("getTexture resolves ids and returns null for unknown ids", () => {
    const first = TEXTURES[0];
    assert.equal(getTexture(first.id), first);
    assert.equal(getTexture("does-not-exist"), null);
  });
});

describe("texture provenance metadata", () => {
  const t = TEXTURES[0];
  it("provenance names the provider, asset, license, and timestamp", () => {
    const p = textureProvenance(t);
    assert.equal(p.provider, "ambientcg");
    assert.equal(p.textureId, t.id);
    assert.equal(p.sourceUrl, t.sourceUrl);
    assert.ok(String(p.license).includes("CC0"));
    assert.ok(p.licenseUrl);
    assert.ok(p.appliedAt);
  });
  it("withTextureProvenance merges into the custom bag without clobbering", () => {
    const merged = withTextureProvenance({ campaignId: "c1" }, t);
    assert.equal(merged.campaignId, "c1");
    assert.equal((merged.texture as Record<string, unknown>).textureId, t.id);
    assert.equal(hasTexture(merged), true);
    assert.equal(hasTexture({ campaignId: "c1" }), false);
  });
  it("withTextureProvenance(null) clears the texture only", () => {
    const cleared = withTextureProvenance({ campaignId: "c1", texture: textureProvenance(t) }, null);
    assert.equal(cleared.campaignId, "c1");
    assert.equal(hasTexture(cleared), false);
    assert.ok(!("texture" in cleared));
  });
  it("textureFillProps spreads cleanly onto Konva nodes", () => {
    assert.deepEqual(textureFillProps(null), {});
    const img = {} as HTMLImageElement;
    assert.deepEqual(textureFillProps(img), { fillPatternImage: img, fillPatternRepeat: "repeat" });
  });
});
