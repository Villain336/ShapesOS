// Phase 21A (WS=agentweb): the static control list of a page (the a11y-tree
// approximation used when no browser is involved, and by the evals).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { controlsOf } from "../elements";

const PAGE = `
<h1>Shop</h1>
<a href="/about">About us</a>
<a href="https://other.test/x" aria-label="Partner site">p</a>
<form action="/checkout/pay" method="post">
  <label for="em">Email address</label><input id="em" name="email" type="email" autocomplete="email">
  <input name="card" type="text" autocomplete="cc-number" placeholder="Card number">
  <input name="pw" type="password">
  <button type="submit">Place order</button>
</form>
<div hidden><button>Hidden button</button></div>
<button>   Menu
</button>
`;

describe("controlsOf", () => {
  const els = controlsOf(PAGE, "https://shop.test/start");

  it("lists links, fields and buttons with stable refs, skipping hidden ones", () => {
    assert.deepEqual(
      els.map((e) => [e.ref, e.role, e.name]),
      [
        ["e1", "link", "About us"],
        ["e2", "link", "Partner site"],
        ["e3", "textbox", "Email address"],
        ["e4", "textbox", "Card number"],
        ["e5", "textbox", "pw"],
        ["e6", "button", "Place order"],
        ["e7", "button", "Menu"],
      ],
    );
  });

  it("resolves hrefs and describes the form a control sits in", () => {
    assert.equal(els[0]!.href, "https://shop.test/about");
    const order = els[5]!;
    assert.equal(order.form?.action, "https://shop.test/checkout/pay");
    assert.equal(order.form?.method, "post");
    assert.deepEqual(order.form?.fields.map((f) => [f.type, f.autocomplete]), [["email", "email"], ["text", "cc-number"], ["password", undefined]]);
  });

  it("reports input type and autocomplete on the field itself", () => {
    assert.equal(els[3]!.autocomplete, "cc-number");
    assert.equal(els[4]!.type, "password");
  });

  it("caps names and strips control characters", () => {
    const e = controlsOf(`<button>a\u0000b‮${"x".repeat(300)}</button>`, "https://a.test/")[0]!;
    assert.equal(e.name.length <= 120, true);
    assert.equal(/[\u0000‮]/.test(e.name), false);
  });
});
