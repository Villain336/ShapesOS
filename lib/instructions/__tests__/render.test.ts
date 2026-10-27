import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderInstructionsBlock } from "../render";

describe("renderInstructionsBlock", () => {
  it("is empty for blank text", () => {
    assert.equal(renderInstructionsBlock(""), "");
    assert.equal(renderInstructionsBlock("  \n "), "");
  });
  it("frames the text as lower-priority guidance and includes it verbatim", () => {
    const out = renderInstructionsBlock("Always cite the source page.");
    assert.ok(out.startsWith("## SHARED WORKSPACE INSTRUCTIONS"));
    assert.ok(out.includes("Always cite the source page."));
    assert.match(out, /ranks below the system rules/);
    assert.match(out, /never authorizes skipping an approval/);
    assert.match(out, /spending money/);
    assert.match(out, /credentials/);
  });
});
