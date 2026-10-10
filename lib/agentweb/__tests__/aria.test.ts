// Phase 21A (WS=agentweb): reading Playwright's AI-mode aria snapshot. The
// sample is the real output of page.ariaSnapshot({ mode: "ai" }) (Playwright
// 1.63) for a small shop page.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAriaSnapshot } from "../aria";

const SAMPLE = `- generic [active] [ref=e1]:
  - heading "Shop" [level=1] [ref=e2]
  - link "About us" [ref=e3] [cursor=pointer]:
    - /url: /about
  - generic [ref=e4]:
    - text: Email
    - textbox "Email" [ref=e5]
    - textbox "Password" [ref=e6]
    - combobox [ref=e7]:
      - option "One" [selected]
    - button "Place order" [ref=e8]
  - button "Menu" [ref=e9]: ☰`;

describe("parseAriaSnapshot", () => {
  it("returns the actionable controls with their refs, in order, and skips structure", () => {
    assert.deepEqual(parseAriaSnapshot(SAMPLE), [
      { ref: "e3", role: "link", name: "About us", url: "/about" },
      { ref: "e5", role: "textbox", name: "Email" },
      { ref: "e6", role: "textbox", name: "Password" },
      { ref: "e7", role: "combobox", name: "" },
      { ref: "e8", role: "button", name: "Place order" },
      { ref: "e9", role: "button", name: "Menu" },
    ]);
  });
  it("unescapes quotes in names and notes disabled controls", () => {
    assert.deepEqual(parseAriaSnapshot(`- button "Say \\"hi\\"" [disabled] [ref=e2]`), [{ ref: "e2", role: "button", name: 'Say "hi"', disabled: true }]);
  });
  it("ignores nodes without a ref and an empty tree", () => {
    assert.deepEqual(parseAriaSnapshot(`- button "No ref"`), []);
    assert.deepEqual(parseAriaSnapshot(""), []);
  });
});
