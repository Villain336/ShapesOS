// Phase 21A (WS=agentweb): the channel ladder. Detection per channel against
// fixture pages, and the selector that picks the best interface a site offers.
//
// Spec text used for the fixtures:
//  - WebMCP declarative API (Chrome docs, developer.chrome.com/docs/ai/webmcp/declarative-api):
//    <form toolname tooldescription [toolautosubmit]> with toolparamdescription on fields.
//  - WebMCP imperative API (webmachinelearning/webmcp): modelContext.registerTool({name, description, inputSchema, execute}); the
//    object lives on navigator (early preview) or document (current draft).
//  - NLWeb (microsoft/NLWeb REST API doc): GET /ask?query=…, JSON with results[{url,name,site,score,description,schema_object}]; /mcp.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectChannels, selectChannel, CHANNEL_ORDER, type SiteProbe } from "../channels";

const WEBMCP_FORM = `<html><body>
<form toolname="requestCallback" tooldescription="Ask the business to call you back." action="/callback" method="post" toolautosubmit>
  <label for="n">Your name</label><input id="n" name="name" required>
  <label for="e">Email</label><input id="e" name="email" type="email" required toolparamdescription="Where we reply">
  <label for="t">Topic</label>
  <select id="t" name="topic" required><option value="quote">Get a quote</option><option value="visit">Book a visit</option></select>
  <input name="note" aria-description="Anything we should know">
  <button>Request callback</button>
</form></body></html>`;

const IMPERATIVE = `<html><body><script>
navigator.modelContext.registerTool({
  name: "add_to_cart",
  description: "Add a product to the cart",
  inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  async execute({ sku }) { return { content: [{ type: "text", text: "ok" }] }; }
});
</script></body></html>`;

const JSONLD = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org","@type":"Dentist","name":"Riverside Dental","telephone":"+44 20 7946 0000","openingHours":"Mo-Fr 09:00-17:00",
 "potentialAction":[{"@type":"ReserveAction","name":"Book a visit","target":{"@type":"EntryPoint","urlTemplate":"https://riverside.test/book?date={date}","httpMethod":"GET"}},
                    {"@type":"CommunicateAction","name":"Contact us","target":"https://riverside.test/contact"}]}
</script></head><body><h1>Riverside Dental</h1></body></html>`;

const OPENAPI = JSON.stringify({ openapi: "3.0.0", info: { title: "Shop API", version: "1" }, paths: { "/products": { get: { operationId: "listProducts", summary: "List products", parameters: [{ name: "q", in: "query", schema: { type: "string" } }] } }, "/orders": { post: { operationId: "createOrder", summary: "Create an order" } } } });

const probe = (over: Partial<SiteProbe>): SiteProbe => ({ origin: "https://riverside.test", html: "<html></html>", files: {}, ...over });

describe("detectChannels: declared tools", () => {
  it("reads a declarative WebMCP form into a tool with the schema Chrome derives", () => {
    const r = detectChannels(probe({ html: WEBMCP_FORM }));
    const t = r.declaredTools[0]!;
    assert.deepEqual([t.source, t.name, t.description], ["webmcp-declarative", "requestCallback", "Ask the business to call you back."]);
    assert.deepEqual(t.inputSchema, {
      type: "object",
      properties: {
        name: { type: "string", description: "Your name" },
        email: { type: "string", description: "Where we reply" },
        topic: { type: "string", description: "Topic", enum: ["quote", "visit"], anyOf: [{ const: "quote", title: "Get a quote" }, { const: "visit", title: "Book a visit" }] },
        note: { type: "string", description: "Anything we should know" },
      },
      required: ["name", "email", "topic"],
    });
    assert.deepEqual(t.form, { action: "https://riverside.test/callback", method: "post", autoSubmit: true });
  });

  it("finds an imperative registerTool on navigator.modelContext or document.modelContext", () => {
    for (const obj of ["navigator", "document"]) {
      const r = detectChannels(probe({ html: IMPERATIVE.replace("navigator", obj) }));
      assert.deepEqual(r.declaredTools.map((t) => [t.source, t.name, t.description]), [["webmcp-imperative", "add_to_cart", "Add a product to the cart"]]);
      assert.equal(r.declaredTools[0]!.needsBrowser, true);
    }
  });

  it("finds a site MCP endpoint from a well-known file or a link", () => {
    const a = detectChannels(probe({ files: { "/.well-known/mcp.json": { status: 200, body: JSON.stringify({ name: "Riverside", endpoint: "/mcp" }) } } }));
    assert.deepEqual(a.declaredTools.map((t) => [t.source, t.endpoint]), [["site-mcp", "https://riverside.test/mcp"]]);
    const b = detectChannels(probe({ html: `<link rel="mcp" href="/mcp">` }));
    assert.equal(b.declaredTools[0]?.endpoint, "https://riverside.test/mcp");
  });

  it("recognises an NLWeb /ask that answers with results, and one only declared by a link", () => {
    const live = detectChannels(probe({ files: { "/ask?query=ping": { status: 200, body: JSON.stringify({ query_id: "1", results: [{ url: "https://riverside.test/", name: "Home", site: "riverside", score: 90, description: "x" }] }) } } }));
    assert.deepEqual(live.declaredTools.map((t) => [t.source, t.endpoint, t.verified]), [["nlweb", "https://riverside.test/ask", true]]);
    const declared = detectChannels(probe({ html: `<link rel="nlweb" href="/ask">` }));
    assert.deepEqual(declared.declaredTools.map((t) => [t.source, t.verified]), [["nlweb", false]]);
  });
});

describe("detectChannels: documented APIs", () => {
  it("lists the operations of an OpenAPI description and marks which are safe reads", () => {
    const r = detectChannels(probe({ files: { "/openapi.json": { status: 200, body: OPENAPI } } }));
    assert.deepEqual(r.apis.map((a) => [a.kind, a.operations.map((o) => [o.operationId, o.method, o.readOnly])]), [["openapi", [["listProducts", "get", true], ["createOrder", "post", false]]]]);
  });
  it("ignores a 404 and an unparseable file", () => {
    const r = detectChannels(probe({ files: { "/openapi.json": { status: 404, body: "" }, "/swagger.json": { status: 200, body: "<html>" } } }));
    assert.deepEqual(r.apis, []);
  });
});

describe("detectChannels: structured data", () => {
  it("reads potentialAction targets and the business facts from JSON-LD", () => {
    const r = detectChannels(probe({ html: JSONLD }));
    assert.deepEqual(r.structured.actions.map((a) => [a.type, a.name, a.target, a.method]), [
      ["ReserveAction", "Book a visit", "https://riverside.test/book?date={date}", "GET"],
      ["CommunicateAction", "Contact us", "https://riverside.test/contact", "GET"],
    ]);
    assert.deepEqual(r.structured.entities.map((e) => [e.type, e.name]), [["Dentist", "Riverside Dental"]]);
  });
});

describe("detectChannels: the report", () => {
  it("lists channels in ladder order, with the a11y tree always possible and vision honestly not available", () => {
    const r = detectChannels(probe({ html: WEBMCP_FORM + JSONLD }));
    assert.deepEqual(r.channels.map((c) => c.channel), CHANNEL_ORDER);
    const by = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
    assert.equal(by["declared-tools"]!.declared, true);
    assert.equal(by["documented-api"]!.declared, false);
    assert.equal(by["structured-data"]!.declared, true);
    assert.equal(by["a11y-tree"]!.declared, true);
    assert.equal(by["vision"]!.declared, false);
    assert.match(by["vision"]!.note, /not available/i);
  });
});

describe("selectChannel", () => {
  const rich = detectChannels(probe({ html: WEBMCP_FORM + JSONLD, files: { "/openapi.json": { status: 200, body: OPENAPI } } }));
  it("prefers declared tools when one matches the task", () => {
    const s = selectChannel(rich, { intent: "request a callback from the business" });
    assert.deepEqual([s.channel, s.tool?.name], ["declared-tools", "requestCallback"]);
    assert.deepEqual(s.fallbacks.map((f) => f.channel), ["documented-api", "structured-data", "a11y-tree"]);
  });
  it("falls to the API when no declared tool fits but an operation does", () => {
    const s = selectChannel(rich, { intent: "list products" });
    assert.deepEqual([s.channel, s.operation?.operationId], ["documented-api", "listProducts"]);
  });
  it("falls to structured data for facts, then to the page tree", () => {
    assert.equal(selectChannel(rich, { intent: "opening hours" }).channel, "structured-data");
    const bare = detectChannels(probe({ html: "<html><body>hi</body></html>" }));
    assert.deepEqual([selectChannel(bare, { intent: "anything" }).channel, selectChannel(bare, { intent: "x" }).fallbacks.length], ["a11y-tree", 0]);
  });
  it("skips a channel that failed here before and says so", () => {
    const s = selectChannel(rich, { intent: "request a callback from the business", failed: ["declared-tools"] });
    assert.notEqual(s.channel, "declared-tools");
    assert.match(s.reason, /failed before/);
  });
  it("never picks a write operation as a read channel", () => {
    const s = selectChannel(rich, { intent: "create an order" });
    assert.notEqual(s.operation?.operationId, "createOrder");
  });
});
