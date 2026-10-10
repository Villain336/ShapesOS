// Phase 21A (WS=agentweb): schema.org potentialAction + declarative WebMCP form
// annotations (PURE, golden output).
//
// WebMCP declarative API (Chrome WebMCP docs, "declarative API"): a <form> becomes
// a tool when it carries `toolname` and `tooldescription`; each field may carry
// `toolparamdescription`; `toolautosubmit` would let the agent submit without the
// visitor, so we NEVER emit it. We only annotate forms the visitor would submit
// anyway (contact / booking / quote), never login, payment or account forms.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addPotentialActions, annotateForms, findForms, potentialActions } from "../actions";
import { detectChannels } from "../../channels";

const CONTACT = `<h1>Contact</h1>
<form action="/contact" method="post">
  <label for="n">Your name</label><input id="n" name="name" required>
  <label for="e">Email</label><input id="e" name="email" type="email" required>
  <label for="m">Message</label><textarea id="m" name="message"></textarea>
  <button type="submit">Send</button>
</form>`;

const BOOKING = `<form action="/book" method="post">
  <input name="date" type="date" required placeholder="Preferred date">
  <input name="party" type="number">
  <button>Reserve a table</button>
</form>`;

const QUOTE = `<form action="/quote" method="post"><input name="email" type="email"><textarea name="details"></textarea><button>Get a free quote</button></form>`;

const LOGIN = `<form action="/login" method="post"><input name="user"><input name="pw" type="password"><button>Sign in</button></form>`;
const PAY = `<form action="/pay" method="post"><input name="card" autocomplete="cc-number"><button>Pay now</button></form>`;
const DELETE_ACCOUNT = `<form action="/account/delete" method="post"><button>Delete my account</button></form>`;

describe("findForms", () => {
  it("classifies contact, booking and quote forms and nothing else", () => {
    const kinds = (html: string) => findForms(html).map((f) => f.kind);
    assert.deepEqual(kinds(CONTACT), ["contact"]);
    assert.deepEqual(kinds(BOOKING), ["booking"]);
    assert.deepEqual(kinds(QUOTE), ["quote"]);
    assert.deepEqual(kinds(LOGIN), [null]);
    assert.deepEqual(kinds(PAY), [null]);
    assert.deepEqual(kinds(DELETE_ACCOUNT), [null]);
  });

  it("reads action, method and field labels", () => {
    const [f] = findForms(CONTACT);
    assert.equal(f.action, "/contact");
    assert.equal(f.method, "POST");
    assert.deepEqual(f.fields.map((x) => [x.name, x.label, x.required]), [
      ["name", "Your name", true],
      ["email", "Email", true],
      ["message", "Message", false],
    ]);
  });

  it("knows a placeholder is not an accessible name", () => {
    const [f] = findForms(`<form action="/c"><input name="email" type="email" placeholder="Email"><label>Phone <input name="phone"></label><input name="x" aria-label="Extra"></form>`);
    assert.deepEqual(f.fields.map((x) => [x.name, x.labelled]), [["email", false], ["phone", true], ["x", true]]);
  });
});

describe("annotateForms", () => {
  it("adds toolname, tooldescription and toolparamdescription, golden", () => {
    const { html, annotated } = annotateForms(CONTACT, { siteName: "Riverside Dental" });
    assert.equal(annotated, 1);
    assert.equal(
      html,
      `<h1>Contact</h1>
<form action="/contact" method="post" toolname="contact_us" tooldescription="Send a message to Riverside Dental. The visitor reviews and submits it.">
  <label for="n">Your name</label><input id="n" name="name" required toolparamdescription="Your name">
  <label for="e">Email</label><input id="e" name="email" type="email" required toolparamdescription="Email">
  <label for="m">Message</label><textarea id="m" name="message" toolparamdescription="Message"></textarea>
  <button type="submit">Send</button>
</form>`,
    );
  });

  it("never emits toolautosubmit", () => {
    for (const src of [CONTACT, BOOKING, QUOTE]) assert.ok(!/toolautosubmit/i.test(annotateForms(src, { siteName: "X" }).html));
  });

  it("is idempotent", () => {
    const once = annotateForms(`${CONTACT}${BOOKING}`, { siteName: "Riverside" }).html;
    const twice = annotateForms(once, { siteName: "Riverside" });
    assert.equal(twice.html, once);
    assert.equal(twice.annotated, 0);
  });

  it("leaves login, payment and account-deletion forms untouched", () => {
    for (const src of [LOGIN, PAY, DELETE_ACCOUNT]) {
      const r = annotateForms(src, { siteName: "X" });
      assert.equal(r.html, src);
      assert.equal(r.annotated, 0);
    }
  });

  it("keeps a form the owner already annotated exactly as it is", () => {
    const own = `<form action="/contact" toolname="my_tool" tooldescription="Mine"><input name="email"><textarea name="message"></textarea></form>`;
    assert.equal(annotateForms(own, { siteName: "X" }).html, own);
  });

  it("gives duplicate kinds distinct tool names", () => {
    const { html } = annotateForms(`${CONTACT}${CONTACT}`, { siteName: "X" });
    assert.deepEqual([...html.matchAll(/toolname="([^"]+)"/g)].map((m) => m[1]), ["contact_us", "contact_us_2"]);
  });

  it("escapes the site name in attribute values", () => {
    const { html } = annotateForms(QUOTE, { siteName: `Bob's "Best" <Plumbing> & Co` });
    assert.match(html, /tooldescription="[^"]*Bob&#39;s &quot;Best&quot; &lt;Plumbing&gt; &amp; Co/);
    assert.ok(!/<Plumbing>/.test(html));
  });

  it("is read back by the channel detector as declared tools (round trip)", () => {
    const { html } = annotateForms(`${CONTACT}${BOOKING}${QUOTE}`, { siteName: "Riverside" });
    const report = detectChannels({ origin: "https://riverside.test", html, files: {} });
    assert.deepEqual(report.declaredTools.map((t) => t.name).sort(), ["contact_us", "request_booking", "request_quote"]);
    assert.ok(report.declaredTools.every((t) => t.source === "webmcp-declarative" && t.form?.autoSubmit === false));
  });
});

describe("potentialActions", () => {
  const tasks = [
    { kind: "contact" as const, target: "https://riverside.test/contact", method: "POST" as const },
    { kind: "booking" as const, target: "https://riverside.test/book", method: "POST" as const },
    { kind: "quote" as const, target: "https://riverside.test/quote", method: "POST" as const },
  ];

  it("emits CommunicateAction, ReserveAction and QuoteAction entry points, golden", () => {
    assert.deepEqual(potentialActions(tasks, "Riverside Dental"), [
      { "@type": "CommunicateAction", name: "Contact Riverside Dental", target: { "@type": "EntryPoint", urlTemplate: "https://riverside.test/contact", httpMethod: "POST", contentType: "application/x-www-form-urlencoded" } },
      { "@type": "ReserveAction", name: "Book with Riverside Dental", target: { "@type": "EntryPoint", urlTemplate: "https://riverside.test/book", httpMethod: "POST", contentType: "application/x-www-form-urlencoded" } },
      { "@type": "QuoteAction", name: "Ask Riverside Dental for a quote", target: { "@type": "EntryPoint", urlTemplate: "https://riverside.test/quote", httpMethod: "POST", contentType: "application/x-www-form-urlencoded" } },
    ]);
  });

  it("never emits a money action", () => {
    const types = potentialActions(tasks, "X").map((a) => a["@type"]);
    for (const banned of ["BuyAction", "OrderAction", "PayAction", "TradeAction", "DonateAction"]) assert.ok(!types.includes(banned));
  });

  it("refuses non-web targets", () => {
    assert.deepEqual(potentialActions([{ kind: "contact", target: "javascript:alert(1)", method: "POST" }], "X"), []);
  });

  it("merges into an organization block, keeps others, and is idempotent", () => {
    const org = { "@context": "https://schema.org", "@type": "Organization", name: "Riverside", potentialAction: { "@type": "SearchAction", target: "https://riverside.test/s?q={q}" } };
    const acts = potentialActions(tasks, "Riverside");
    const merged = addPotentialActions(org, acts);
    assert.equal((merged.potentialAction as unknown[]).length, 4);
    assert.deepEqual(addPotentialActions(merged, acts), merged);
    assert.equal(org.potentialAction["@type"], "SearchAction"); // input not mutated
  });

  it("round-trips through the channel detector as structured actions", () => {
    const block = addPotentialActions({ "@context": "https://schema.org", "@type": "Organization", name: "Riverside" }, potentialActions(tasks, "Riverside"));
    const html = `<script type="application/ld+json">${JSON.stringify(block)}</script>`;
    const r = detectChannels({ origin: "https://riverside.test", html, files: {} });
    assert.deepEqual(r.structured.actions.map((a) => [a.type, a.target, a.method]), [
      ["CommunicateAction", "https://riverside.test/contact", "POST"],
      ["ReserveAction", "https://riverside.test/book", "POST"],
      ["QuoteAction", "https://riverside.test/quote", "POST"],
    ]);
  });
});
