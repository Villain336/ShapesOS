// Phase 21A (WS=agentweb): the page-aware tier classifier, one fixture per
// page class. Expected tiers come from the plan, not from the code:
//   money / destructive / saved-password sign-in -> Tier 3 (never auto, click on the card)
//   sending / posting                            -> Tier 2 (always asks)
//   unknown                                      -> ask (Tier 2)
//   benign                                       -> may run
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { controlsOf } from "../elements";
import { classifyStep } from "../classify";
import type { ElementInfo, PageContext } from "../types";

const page = (path: string, origin = "https://shop.test"): PageContext => ({ url: `${origin}${path}`, origin });
const find = (html: string, pageUrl: string, name: RegExp): ElementInfo => {
  const el = controlsOf(html, pageUrl).find((e) => name.test(e.name));
  if (!el) throw new Error(`no control matching ${name}`);
  return el;
};
const click = (html: string, path: string, name: RegExp) => classifyStep({ action: "click", element: find(html, `https://shop.test${path}`, name), page: page(path) });

describe("classifyStep: money", () => {
  it("a Place order button in a checkout form is money, Tier 3", () => {
    const r = click(`<form action="/checkout/pay" method="post"><input name="card" autocomplete="cc-number"><button>Place order</button></form>`, "/checkout", /Place order/);
    assert.deepEqual([r.klass, r.tier], ["money", 3]);
  });
  it("Pay now with no form context is still money", () => {
    assert.deepEqual(click(`<button>Pay now</button>`, "/cart", /Pay now/).tier, 3);
  });
  it("a plan Subscribe button on a pricing page is money", () => {
    const r = click(`<form action="/billing/subscribe" method="post"><button>Subscribe</button></form>`, "/pricing", /Subscribe/);
    assert.deepEqual([r.klass, r.tier], ["money", 3]);
  });
  it("a Subscribe button on a newsletter form is a send (Tier 2), not money", () => {
    const r = click(`<form action="/newsletter" method="post"><input name="email" type="email"><button>Subscribe</button></form>`, "/blog", /Subscribe/);
    assert.deepEqual([r.klass, r.tier], ["send", 2]);
  });
  it("typing into a card field is a credential step, Tier 3, whatever the value", () => {
    const el = find(`<form action="/pay"><input name="c" autocomplete="cc-number" placeholder="Card number"></form>`, "https://shop.test/pay", /Card/);
    const r = classifyStep({ action: "type", element: el, page: page("/pay"), value: "anything" });
    assert.deepEqual([r.klass, r.tier], ["credential", 3]);
  });
});

describe("classifyStep: destructive", () => {
  it("Delete account is destructive, Tier 3", () => {
    const r = click(`<form action="/account/delete" method="post"><button>Delete account</button></form>`, "/account", /Delete/);
    assert.deepEqual([r.klass, r.tier], ["destructive", 3]);
  });
  it("Close my account, even with an innocent label, is caught by the form destination", () => {
    const r = click(`<form action="/account/delete" method="post"><button>Yes, continue</button></form>`, "/account", /continue/);
    assert.deepEqual([r.klass, r.tier], ["destructive", 3]);
  });
  it("look-alike letters and zero-width characters do not hide it", () => {
    const r = click(`<button>Dеl​eтe accоunt</button>`, "/account", /acc/);
    assert.deepEqual([r.klass, r.tier], ["destructive", 3]);
  });
  it("fullwidth letters do not hide it either", () => {
    assert.equal(click(`<button>Ｄｅｌｅｔｅ project</button>`, "/p", /project/).tier, 3);
  });
});

describe("classifyStep: sending and posting", () => {
  it("Send in a compose form is a send, Tier 2", () => {
    const r = click(`<form action="/mail/send" method="post"><input name="to" type="email"><textarea name="body"></textarea><button>Send</button></form>`, "/compose", /Send/);
    assert.deepEqual([r.klass, r.tier], ["send", 2]);
  });
  it("a contact form submit is a send", () => {
    const r = click(`<form action="/contact" method="post"><input name="email" type="email"><textarea name="msg"></textarea><button>Submit</button></form>`, "/contact", /Submit/);
    assert.deepEqual([r.klass, r.tier], ["send", 2]);
  });
  it("Publish and Post are posts, Tier 2", () => {
    assert.deepEqual(click(`<button>Publish</button>`, "/editor", /Publish/).klass, "post");
    assert.deepEqual(click(`<form action="/c" method="post"><textarea name="t"></textarea><button>Post comment</button></form>`, "/p/1", /Post/).tier, 2);
  });
  it("a mailto link is a send", () => {
    assert.equal(click(`<a href="mailto:boss@example.com">Email us</a>`, "/about", /Email us/).klass, "send");
  });
});

describe("classifyStep: credentials", () => {
  it("typing into a password field is a credential step, Tier 3", () => {
    const el = find(`<form action="/login"><input type="password" name="pw" aria-label="Password"></form>`, "https://shop.test/login", /Password/);
    const r = classifyStep({ action: "type", element: el, page: page("/login"), value: "x" });
    assert.deepEqual([r.klass, r.tier], ["credential", 3]);
  });
  it("Sign in with a password form is a saved-password sign-in, Tier 3", () => {
    const r = click(`<form action="/login" method="post"><input type="password" name="pw"><button>Sign in</button></form>`, "/login", /Sign in/);
    assert.deepEqual([r.klass, r.tier], ["credential", 3]);
  });
  it("a one-time-code field is a credential", () => {
    const el = find(`<input name="otp" autocomplete="one-time-code" aria-label="Code">`, "https://shop.test/2fa", /Code/);
    assert.equal(classifyStep({ action: "type", element: el, page: page("/2fa"), value: "1" }).klass, "credential");
  });
});

describe("classifyStep: benign and unknown", () => {
  it("a same-origin link is benign", () => {
    const r = click(`<a href="/about">About us</a>`, "/", /About/);
    assert.deepEqual([r.klass, r.tier], ["benign", 0]);
  });
  it("a GET search form submit is benign", () => {
    const r = click(`<form action="/search" method="get"><input name="q"><button>Search</button></form>`, "/", /Search/);
    assert.deepEqual([r.klass, r.tier], ["benign", 0]);
  });
  it("typing in a search box is benign", () => {
    const el = find(`<form action="/search"><input name="q" placeholder="Search products"></form>`, "https://shop.test/", /Search/);
    assert.equal(classifyStep({ action: "type", element: el, page: page("/"), value: "shoes" }).tier, 0);
  });
  it("a Menu button outside any form is benign", () => {
    assert.equal(click(`<button>Menu</button>`, "/", /Menu/).klass, "benign");
  });
  it("Add to cart is benign (it can be undone; paying is a separate, gated step)", () => {
    assert.equal(click(`<button>Add to cart</button>`, "/p/1", /Add to cart/).klass, "benign");
  });
  it("a Continue button in a POST form to an unclear destination is unknown, Tier 2", () => {
    const r = click(`<form action="/step2" method="post"><input name="a"><button>Continue</button></form>`, "/step1", /Continue/);
    assert.deepEqual([r.klass, r.tier], ["unknown", 2]);
  });
  it("an icon-only button with no name is unknown", () => {
    const r = classifyStep({ action: "click", element: { ref: "e1", role: "button", name: "", tag: "button" }, page: page("/") });
    assert.deepEqual([r.klass, r.tier], ["unknown", 2]);
  });
  it("a POST form that submits to another origin is unknown at best", () => {
    const r = click(`<form action="https://other.test/collect" method="post"><input name="a"><button>Verify</button></form>`, "/", /Verify/);
    assert.equal(r.tier >= 2, true);
  });
});
