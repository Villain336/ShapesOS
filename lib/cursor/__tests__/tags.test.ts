// Phase 19A (WS=server): the cursor tag parser — good, bad and edge cases,
// coordinate clamping, multi-screen, streaming splits, and the rule that
// spoken text never carries a tag.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CursorTagStream, parseCursorReply, parseTag, toScreenPoint, type CursorScreen, type TagContext } from "../tags";

const MAIN: CursorScreen = { screen: 0, width: 2880, height: 1800, scaleFactor: 2, primary: true }; // 1440×900 pt
const SIDE: CursorScreen = { screen: 1, width: 1920, height: 1080, scaleFactor: 1, primary: false };
const ctx: TagContext = { screens: [MAIN, SIDE], elementIds: new Set(["nav:/dashboard/approvals", "approval:a1:approve", "kit:composer:send"]) };

describe("parseTag: POINT", () => {
  it("points on the named screen, converted to points", () => {
    assert.deepEqual(parseTag("POINT:400,300:Save button:screen0", ctx), { type: "point", screen: 0, x: 200, y: 150, label: "Save button" });
    assert.deepEqual(parseTag("POINT:400,300:Save:screen1", ctx), { type: "point", screen: 1, x: 400, y: 300, label: "Save" });
  });
  it("defaults to the primary screen when none is named", () => {
    assert.deepEqual(parseTag("POINT:10,20:File menu", ctx), { type: "point", screen: 0, x: 5, y: 10, label: "File menu" });
  });
  it("clamps coordinates inside that screen", () => {
    assert.deepEqual(parseTag("POINT:99999,-50:Far:screen0", ctx), { type: "point", screen: 0, x: 1439, y: 0, label: "Far" });
    assert.deepEqual(parseTag("POINT:5000,5000:Far:screen1", ctx), { type: "point", screen: 1, x: 1919, y: 1079, label: "Far" });
  });
  it("drops a screen that was not sent", () => {
    assert.equal(parseTag("POINT:10,10:x:screen7", ctx), null);
  });
  it("points at a registry element by id (ids may contain colons)", () => {
    assert.deepEqual(parseTag("POINT:#nav:/dashboard/approvals:Approvals", ctx), { type: "point", elementId: "nav:/dashboard/approvals", label: "Approvals" });
    assert.deepEqual(parseTag("POINT:#approval:a1:approve:Approve this one", ctx), { type: "point", elementId: "approval:a1:approve", label: "Approve this one" });
  });
  it("drops an element id that is not on the page", () => {
    assert.equal(parseTag("POINT:#nav:/dashboard/nowhere:Nope", ctx), null);
    assert.equal(parseTag("POINT:#kit:composer:send:Send", { screens: [MAIN] }), null);
  });
  it("POINT:none and malformed points produce nothing", () => {
    assert.equal(parseTag("POINT:none", ctx), null);
    assert.equal(parseTag("POINT:abc,def:x", ctx), null);
    assert.equal(parseTag("POINT:", ctx), null);
    assert.equal(parseTag("POINT:1e9", ctx), null);
  });
  it("with several screens and no primary, an unnamed screen is dropped", () => {
    const two: TagContext = { screens: [{ ...MAIN, primary: false }, SIDE] };
    assert.equal(parseTag("POINT:1,1:x", two), null);
  });
});

describe("parseTag: DRAW and DICTATE", () => {
  it("circle, arrow and step", () => {
    assert.deepEqual(parseTag("DRAW:circle:200,200:here:screen0", ctx), { type: "draw", kind: "circle", screen: 0, points: [{ x: 100, y: 100 }], label: "here" });
    assert.deepEqual(parseTag("DRAW:arrow:0,0;100,50:go:screen1", ctx), {
      type: "draw",
      kind: "arrow",
      screen: 1,
      points: [{ x: 0, y: 0 }, { x: 100, y: 50 }],
      label: "go",
    });
    assert.deepEqual(parseTag("DRAW:step:2:40,40:Then this:screen0", ctx), { type: "draw", kind: "step", screen: 0, points: [{ x: 20, y: 20 }], step: 2, label: "Then this" });
  });
  it("refuses bad shapes", () => {
    assert.equal(parseTag("DRAW:arrow:0,0:one point", ctx), null);
    assert.equal(parseTag("DRAW:step:0:1,1:x", ctx), null);
    assert.equal(parseTag("DRAW:step:x:1,1", ctx), null);
    assert.equal(parseTag("DRAW:blob:1,1", ctx), null);
    assert.equal(parseTag("DRAW:circle:1,1:x:screen9", ctx), null);
  });
  it("dictation keeps the text", () => {
    assert.deepEqual(parseTag("DICTATE:Thanks, see you Friday.", ctx), { type: "dictation", text: "Thanks, see you Friday." });
    assert.equal(parseTag("DICTATE:   ", ctx), null);
  });
  it("unknown tags are dropped", () => {
    assert.equal(parseTag("CLICK:10,10", ctx), null);
    assert.equal(parseTag("TYPE:hello", ctx), null);
  });
});

describe("parseCursorReply", () => {
  it("strips every tag from the spoken text", () => {
    const r = parseCursorReply("Click Save [POINT:400,300:Save:screen0] then Done [DRAW:step:2:10,10:Done:screen0].", ctx);
    assert.equal(r.text, "Click Save then Done.");
    assert.equal(r.events.length, 2);
    assert.ok(!/\[|\]/.test(r.text));
  });
  it("unknown and malformed tags are dropped from text too", () => {
    const r = parseCursorReply("Ok [CLICK:1,1] [POINT:x,y:bad] done", ctx);
    assert.equal(r.text, "Ok done");
    assert.equal(r.events.length, 0);
  });
  it("ordinary brackets stay as text", () => {
    assert.equal(parseCursorReply("Use [optional] flags or [x]", ctx).text, "Use [optional] flags or [x]");
  });
  it("an unclosed tag at the end is never spoken", () => {
    const r = parseCursorReply("Look here [POINT:10,10:Save", ctx);
    assert.equal(r.text, "Look here");
    assert.equal(r.events.length, 0);
  });
});

describe("CursorTagStream", () => {
  it("handles a tag split across many deltas", () => {
    const s = new CursorTagStream(ctx);
    const chunks = ["Press ", "[PO", "INT:4", "00,30", "0:Sa", "ve:scr", "een0]", " now"];
    let text = "";
    const events = [];
    for (const c of chunks) {
      const r = s.push(c);
      text += r.text;
      events.push(...r.events);
      assert.ok(!r.text.includes("["), `delta leaked a tag: ${r.text}`);
    }
    text += s.end().text;
    assert.equal(text, "Press now");
    assert.deepEqual(events, [{ type: "point", screen: 0, x: 200, y: 150, label: "Save" }]);
  });
  it("a non-tag bracket flushes as soon as it is clearly not a tag", () => {
    const s = new CursorTagStream(ctx);
    assert.equal(s.push("see [o").text, "see [o");
  });
});

describe("toScreenPoint", () => {
  it("treats a bad scale factor as 1", () => {
    assert.deepEqual(toScreenPoint({ ...SIDE, scaleFactor: 0 }, 10, 10), { x: 10, y: 10 });
  });
});
