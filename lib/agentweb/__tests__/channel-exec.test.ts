// Phase 21A (WS=agentweb): running a channel. Three read channels are real
// (structured data, a documented GET operation, NLWeb /ask); a declared form is
// filled and submitted through the GOVERNED session, so every keystroke and
// click still goes through the safety kernel. Declared imperative WebMCP tools
// and site MCP endpoints are detected but not run in this release.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectChannels } from "../channels";
import { runApiOperation, runDeclaredForm, runNlweb, runStructured } from "../channel-exec";
import { HttpBrowserProvider } from "../provider-http";
import { capabilitiesFor } from "../capabilities";
import { SafetyKernel } from "../kernel";

const FORM_PAGE = `<html><body><form toolname="requestCallback" tooldescription="Ask for a call back" action="/callback" method="post">
<label for="n">Name</label><input id="n" name="name" required>
<label for="e">Email</label><input id="e" name="email" type="email" required>
<select name="topic"><option value="quote">Quote</option><option value="visit">Visit</option></select>
<button>Request callback</button></form></body></html>`;

const JSONLD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"Riverside Dental","telephone":"+44 20 7946 0000","openingHours":"Mo-Fr 09:00-17:00","address":"1 High St"}</script>`;

function fetchOf(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body ? String(init.body) : "" });
    const r = routes[`${method} ${url}`] ?? routes[url];
    return new Response(r?.body ?? "nf", { status: r ? (r.status ?? 200) : 404 });
  };
  return { fetchFn, calls };
}

describe("runStructured", () => {
  it("answers from schema.org data without any page text", () => {
    const report = detectChannels({ origin: "https://r.test", html: JSONLD, files: {} });
    const r = runStructured(report, "opening hours");
    assert.deepEqual(r, { ok: true, channel: "structured-data", data: [{ type: "Dentist", name: "Riverside Dental", props: { openingHours: "Mo-Fr 09:00-17:00" } }] });
  });
  it("returns the whole entity when nothing narrower matches, and fails honestly with no data", () => {
    const report = detectChannels({ origin: "https://r.test", html: JSONLD, files: {} });
    assert.equal(Object.keys((runStructured(report, "tell me everything") as { data: Array<{ props: object }> }).data[0]!.props).length, 3);
    const none = runStructured(detectChannels({ origin: "https://r.test", html: "<p>x</p>", files: {} }), "hours");
    assert.deepEqual([none.ok, none.channel], [false, "structured-data"]);
  });
});

describe("runApiOperation", () => {
  const report = detectChannels({
    origin: "https://r.test",
    html: "",
    files: { "/openapi.json": { status: 200, body: JSON.stringify({ openapi: "3", paths: { "/products": { get: { operationId: "listProducts", summary: "List products", parameters: [{ name: "q", in: "query" }] } }, "/orders": { post: { operationId: "createOrder" } } } }) } },
  });
  it("calls a read operation with only the parameters it lists", async () => {
    const net = fetchOf({ "https://r.test/products?q=crown": { body: JSON.stringify([{ name: "Crown" }]) } });
    const op = report.apis[0]!.operations[0]!;
    const r = await runApiOperation(op, report.origin, { q: "crown", evil: "x" }, { fetchFn: net.fetchFn, checkUrl: async (u) => u });
    assert.deepEqual([r.ok, r.data], [true, [{ name: "Crown" }]]);
    assert.equal(net.calls[0]!.url, "https://r.test/products?q=crown");
  });
  it("never runs a write operation", async () => {
    const net = fetchOf({});
    const op = report.apis[0]!.operations[1]!;
    const r = await runApiOperation(op, report.origin, {}, { fetchFn: net.fetchFn, checkUrl: async (u) => u });
    assert.equal(r.ok, false);
    assert.match(r.error!, /write/);
    assert.equal(net.calls.length, 0);
  });
  it("reports an HTTP error instead of inventing data", async () => {
    const net = fetchOf({ "https://r.test/products": { status: 500, body: "boom" } });
    const r = await runApiOperation(report.apis[0]!.operations[0]!, report.origin, {}, { fetchFn: net.fetchFn, checkUrl: async (u) => u });
    assert.deepEqual([r.ok, r.error], [false, "The API answered HTTP 500."]);
  });
});

describe("runNlweb", () => {
  it("asks /ask with the NLWeb parameters and returns the listed results", async () => {
    const net = fetchOf({ "https://r.test/ask?query=opening+hours&mode=list&streaming=false": { body: JSON.stringify({ query_id: "1", results: [{ url: "https://r.test/hours", name: "Hours", site: "r", score: 90, description: "Mon–Fri 9–5", schema_object: { big: "x".repeat(5000) } }] }) } });
    const r = await runNlweb("https://r.test/ask", "opening hours", { fetchFn: net.fetchFn, checkUrl: async (u) => u });
    assert.deepEqual(r.data, [{ url: "https://r.test/hours", name: "Hours", description: "Mon–Fri 9–5" }]);
  });
  it("refuses an endpoint on another origin than the site", async () => {
    const r = await runNlweb("https://elsewhere.test/ask", "x", { fetchFn: fetchOf({}).fetchFn, checkUrl: async (u) => u }, "https://r.test");
    assert.equal(r.ok, false);
  });
});

describe("runDeclaredForm", () => {
  async function setup(approve: (reason: string) => boolean) {
    const net = fetchOf({ "https://r.test/": { body: FORM_PAGE }, "POST https://r.test/callback": { body: "<title>Thanks</title>" } });
    const caps = capabilitiesFor("https://r.test/");
    const kernel = new SafetyKernel({ caps });
    const session = await new HttpBrowserProvider({ fetchFn: net.fetchFn, checkUrl: async (u) => u }).open({ caps });
    await session.navigate("https://r.test/");
    const tool = detectChannels({ origin: "https://r.test", html: FORM_PAGE, files: {} }).declaredTools[0]!;
    return { net, session, kernel, tool, run: (args: Record<string, unknown>) => runDeclaredForm(tool, args, { session, kernel, approve }) };
  }

  it("fills the declared fields and submits once the person approves the send", async () => {
    const s = await setup(() => true);
    const r = await s.run({ name: "Ann", email: "ann@example.com", topic: "quote" });
    assert.deepEqual([r.ok, r.steps], [true, 4]);
    const post = s.net.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(Object.fromEntries(new URLSearchParams(post.body)), { name: "Ann", email: "ann@example.com", topic: "quote" });
  });

  it("does not submit when the person does not approve; it says what is waiting", async () => {
    const s = await setup(() => false);
    const r = await s.run({ name: "Ann", email: "ann@example.com" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /waiting for the person/i);
    assert.equal(s.net.calls.some((c) => c.method === "POST"), false);
  });

  it("reports a missing required argument before touching the page", async () => {
    const s = await setup(() => true);
    const r = await s.run({ name: "Ann" });
    assert.match(r.error!, /email/);
    assert.equal(s.net.calls.filter((c) => c.method === "POST").length, 0);
  });

  it("will not fill a declared field that is a password or card field", async () => {
    const page = `<form toolname="pay" tooldescription="x" action="/pay" method="post"><input name="card" autocomplete="cc-number"><button>Go</button></form>`;
    const net = fetchOf({ "https://r.test/": { body: page } });
    const caps = capabilitiesFor("https://r.test/");
    const kernel = new SafetyKernel({ caps });
    const session = await new HttpBrowserProvider({ fetchFn: net.fetchFn, checkUrl: async (u) => u }).open({ caps });
    await session.navigate("https://r.test/");
    const tool = detectChannels({ origin: "https://r.test", html: page, files: {} }).declaredTools[0]!;
    const r = await runDeclaredForm(tool, { card: "4242424242424242" }, { session, kernel, approve: () => true });
    assert.equal(r.ok, false);
    assert.match(r.error!, /person/);
    assert.equal(net.calls.some((c) => c.method === "POST"), false);
  });
});
