// Marketr — Phase 11 "Canvas": mockup frame tests.
// Run: npx tsx --test lib/design/__tests__/mockup-frames.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  blankDocument,
  type DesignElement,
  type ImageElement,
} from "../types";
import {
  buildMockupElements,
  isMockupScreen,
  MOCKUP_FRAME_MAP,
  MOCKUP_FRAMES,
  mockupTagOf,
  SCREEN_PLACEHOLDER_SRC,
} from "../mockup-frames";
import { validateDesignDocument } from "../validate";
import { elementToSvg, exportPageToSvg } from "../export-svg";

const HEX = /^#[0-9a-fA-F]{6}$/;
const PATH_CHARS = /^[-\d\s.,MLHVQCZTAeE]*$/;

describe("mockup frame definitions", () => {
  it("ships exactly 20 frames", () => {
    assert.equal(MOCKUP_FRAMES.length, 20);
  });

  it("has unique ids and names", () => {
    const ids = MOCKUP_FRAMES.map((f) => f.id);
    const names = MOCKUP_FRAMES.map((f) => f.name);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(new Set(names).size, names.length);
    for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
  });

  it("declares a screen rect inside the art bounds", () => {
    for (const f of MOCKUP_FRAMES) {
      const s = f.screen;
      assert.ok(s.w > 0 && s.h > 0, `${f.id}: screen must have positive size`);
      assert.ok(s.x >= 0 && s.y >= 0, `${f.id}: screen must not start outside`);
      assert.ok(s.x + s.w <= 24, `${f.id}: screen exceeds art width`);
      assert.ok(s.y + s.h <= f.artH, `${f.id}: screen exceeds art height`);
      assert.ok(f.artH > 0, `${f.id}: artH must be positive`);
      assert.ok(f.defaultW > 0, `${f.id}: defaultW must be positive`);
    }
  });

  it("has valid SVG path data and hex fills", () => {
    for (const f of MOCKUP_FRAMES) {
      assert.ok(f.body.length > 0, `${f.id}: body path empty`);
      assert.ok(PATH_CHARS.test(f.body), `${f.id}: body has unexpected chars`);
      assert.match(f.bodyFill, HEX, `${f.id}: bodyFill not hex`);
      if (f.detail !== undefined) {
        assert.ok(f.detail.length > 0, `${f.id}: detail path empty`);
        assert.ok(PATH_CHARS.test(f.detail), `${f.id}: detail has unexpected chars`);
        assert.ok(f.detailFill !== undefined, `${f.id}: detail needs detailFill`);
        assert.match(f.detailFill!, HEX, `${f.id}: detailFill not hex`);
      }
    }
  });

  it("covers the required frame set", () => {
    const ids = new Set(MOCKUP_FRAMES.map((f) => f.id));
    for (const id of [
      "phone-front",
      "phone-angled",
      "tablet",
      "laptop-front",
      "laptop-angled",
      "desktop-monitor",
      "browser-window",
      "social-post",
      "billboard",
      "poster-frame",
      "business-card",
      "book",
      "coffee-mug",
      "t-shirt",
      "shopping-bag",
      "app-icon-grid",
      "smartwatch",
      "tv-widescreen",
      "signage-board",
      "packaging-box",
    ]) {
      assert.ok(ids.has(id), `missing frame: ${id}`);
      assert.equal(MOCKUP_FRAME_MAP[id]?.id, id);
    }
  });
});

describe("buildMockupElements", () => {
  it("throws on unknown frame id", () => {
    assert.throws(() => buildMockupElements("nope", 1080, 1080), /unknown mockup frame/);
  });

  it("builds a frame + screen set with unique ids and mockup tags", () => {
    for (const f of MOCKUP_FRAMES) {
      const els = buildMockupElements(f.id, 1080, 1080);
      const roles = els.map((e) => mockupTagOf(e)?.role);
      assert.deepEqual(
        roles,
        f.detail ? ["frame", "detail", "screen"] : ["frame", "screen"],
        `${f.id}: roles`,
      );
      const ids = els.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, `${f.id}: ids unique`);
      for (const e of els) {
        assert.equal(mockupTagOf(e)?.frameId, f.id, `${f.id}: tag frameId`);
      }
    }
  });

  it("keeps svg elements at the art aspect ratio", () => {
    for (const f of MOCKUP_FRAMES) {
      const els = buildMockupElements(f.id, 1080, 1080);
      for (const e of els) {
        if (e.type !== "svg") continue;
        assert.ok(e.width > 0 && e.height > 0);
        // width/24 must equal height/artH (uniform scale of 24-wide art space)
        assert.ok(
          Math.abs(e.width / 24 - e.height / f.artH) < 0.01,
          `${f.id}: aspect drift`,
        );
      }
    }
  });

  it("places the screen exactly on the declared screen rect", () => {
    for (const f of MOCKUP_FRAMES) {
      const els = buildMockupElements(f.id, 1080, 1080);
      const frame = els[0]!;
      const screen = els[els.length - 1]!;
      assert.equal(screen.type, "image");
      assert.ok(isMockupScreen(screen));
      if (frame.type !== "svg") throw new Error("frame must be svg");
      const scale = frame.width / 24;
      const img = screen as ImageElement;
      assert.ok(Math.abs(img.x - (frame.x + f.screen.x * scale)) < 0.01, `${f.id}: screen x`);
      assert.ok(Math.abs(img.y - (frame.y + f.screen.y * scale)) < 0.01, `${f.id}: screen y`);
      assert.ok(Math.abs(img.width - f.screen.w * scale) < 0.01, `${f.id}: screen w`);
      assert.ok(Math.abs(img.height - f.screen.h * scale) < 0.01, `${f.id}: screen h`);
    }
  });

  it("centers the frame on the page", () => {
    const els = buildMockupElements("phone-front", 1080, 1080);
    const frame = els[0]!;
    assert.equal(frame.type, "svg");
    assert.ok(Math.abs(frame.x - (1080 - frame.width) / 2) < 0.01);
    assert.ok(Math.abs(frame.y - (1080 - frame.height) / 2) < 0.01);
  });

  it("produces elements that validate as a document", () => {
    for (const f of MOCKUP_FRAMES) {
      const doc = blankDocument(1080, 1080);
      doc.pages[0]!.elements = buildMockupElements(f.id, 1080, 1080);
      const res = validateDesignDocument(doc);
      assert.ok(res.ok, `${f.id}: ${!res.ok ? res.error : ""}`);
    }
  });
});

describe("mockup helpers", () => {
  it("isMockupScreen only matches mockup screens", () => {
    const els = buildMockupElements("phone-front", 1080, 1080);
    assert.ok(isMockupScreen(els[els.length - 1]!));
    assert.ok(!isMockupScreen(els[0]!));
    const plain: DesignElement = {
      id: "x",
      type: "image",
      name: "X",
      x: 0,
      y: 0,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      src: "data:image/png;base64,AAA",
      width: 10,
      height: 10,
      cornerRadius: 0,
    };
    assert.ok(!isMockupScreen(plain));
    assert.equal(mockupTagOf(plain), undefined);
  });

  it("placeholder src is a decodable inline SVG", () => {
    assert.ok(SCREEN_PLACEHOLDER_SRC.startsWith("data:image/svg+xml"));
    const decoded = decodeURIComponent(SCREEN_PLACEHOLDER_SRC.split(",")[1]!);
    assert.ok(decoded.includes("<svg"));
    assert.ok(decoded.includes("YOUR DESIGN"));
  });
});

describe("mockup SVG export", () => {
  it("serializes an inserted frame through the existing export path", () => {
    const doc = blankDocument(1080, 1080);
    const els = buildMockupElements("laptop-front", 1080, 1080);
    doc.pages[0]!.elements = els;
    const res = exportPageToSvg(doc, doc.pages[0]!.id);
    assert.ok(res.ok, !res.ok ? res.error : "");
    const svg = res.ok ? res.svg : "";
    // Frame body path lands in the output…
    assert.ok(svg.includes("<path d=\"M"), "frame path serialized");
    // …and the screen becomes an <image> with the placeholder embedded.
    assert.ok(svg.includes("<image"), "screen image serialized");
    assert.ok(svg.includes("data:image/svg+xml"), "placeholder embedded");
  });

  it("embeds a user-set screen image verbatim", () => {
    const doc = blankDocument(800, 600);
    const els = buildMockupElements("phone-front", 800, 600);
    const screen = els[els.length - 1]!;
    assert.equal(screen.type, "image");
    (screen as ImageElement).src = "data:image/png;base64,USERIMAGE";
    doc.pages[0]!.elements = els;
    const elSvg = elementToSvg(screen, {});
    assert.ok(elSvg.includes("data:image/png;base64,USERIMAGE"));
  });
});
