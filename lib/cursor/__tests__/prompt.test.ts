// Phase 19A (WS=server): the cursor's system prompt is byte-stable (Phase 17
// caching: per-turn data goes in the user turn), and the user turn carries
// the screenshots, the UI map and the words — never inside the system prompt.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CURSOR_SYSTEM_PROMPT, cursorUserTurn, screenSummary } from "../prompt";

describe("CURSOR_SYSTEM_PROMPT", () => {
  it("is one constant string with no per-turn placeholders", () => {
    assert.equal(typeof CURSOR_SYSTEM_PROMPT, "string");
    assert.ok(!/\$\{|\{\{|<context>|They said/.test(CURSOR_SYSTEM_PROMPT));
    // Fingerprint: a change here is deliberate (it resets every prompt cache).
    const sha = createHash("sha256").update(CURSOR_SYSTEM_PROMPT).digest("hex").slice(0, 16);
    console.log(`# cursor prompt sha256/16 = ${sha}, ${CURSOR_SYSTEM_PROMPT.length} chars`);
    assert.equal(CURSOR_SYSTEM_PROMPT, CURSOR_SYSTEM_PROMPT.normalize("NFC"));
  });
  it("teaches every contract tag and the never-claim rule", () => {
    for (const tag of ["[POINT:x,y:label:screenN]", "[POINT:#elementId:label]", "[DRAW:circle:", "[DRAW:arrow:", "[DRAW:step:", "[DICTATE:"]) {
      assert.ok(CURSOR_SYSTEM_PROMPT.includes(tag), tag);
    }
    assert.match(CURSOR_SYSTEM_PROMPT, /Never say you did something you only proposed/);
    assert.match(CURSOR_SYSTEM_PROMPT, /never approved by voice/);
    assert.match(CURSOR_SYSTEM_PROMPT, /prefer this form/);
  });
});

describe("cursorUserTurn", () => {
  const turn = cursorUserTurn({
    transcript: "Where do I approve a pay run?",
    screens: [{ screen: 0, width: 200, height: 100, scaleFactor: 2, primary: true, jpegBase64: "QUJD" }],
    uiMap: [{ id: "nav:/dashboard/approvals", label: "Approvals", role: "link", rect: { x: 1, y: 2, w: 3, h: 4 } }],
    app: { name: "ShapesOS", title: "Approvals", isShapesOS: true },
    mode: "answer",
  });
  it("puts context, then each screenshot, then the words", () => {
    assert.deepEqual(turn.map((b) => b.type), ["text", "text", "image", "text"]);
    const ctx = (turn[0] as { text: string }).text;
    assert.ok(ctx.includes("#nav:/dashboard/approvals — Approvals (link)"));
    assert.ok(ctx.includes("(this is ShapesOS)"));
    assert.ok((turn[3] as { text: string }).text.includes("Where do I approve a pay run?"));
  });
  it("the same input gives the same bytes", () => {
    const again = cursorUserTurn({
      transcript: "Where do I approve a pay run?",
      screens: [{ screen: 0, width: 200, height: 100, scaleFactor: 2, primary: true, jpegBase64: "QUJD" }],
      uiMap: [{ id: "nav:/dashboard/approvals", label: "Approvals", role: "link", rect: { x: 1, y: 2, w: 3, h: 4 } }],
      app: { name: "ShapesOS", title: "Approvals", isShapesOS: true },
      mode: "answer",
    });
    assert.deepEqual(again, turn);
  });
  it("the timeline summary is short text and never the image", () => {
    const s = screenSummary({ screens: [{ screen: 0, width: 1, height: 1, scaleFactor: 1, primary: true, jpegBase64: "QUJD".repeat(500) }], app: { name: "Mail", title: "x".repeat(400), isShapesOS: false } });
    assert.ok(s.length <= 200);
    assert.ok(!s.includes("QUJD"));
  });
});
