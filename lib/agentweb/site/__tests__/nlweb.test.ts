// Phase 21A (WS=agentweb): NLWeb-style /ask and /mcp over a site's OWN published
// content (PURE; the HTTP routes are thin wrappers).
//
// Shapes follow microsoft/NLWeb docs/nlweb-rest-api.md: GET/POST /ask with `query`
// (required), `site`, `prev`, `decontextualized_query`, `streaming`, `mode`
// (list default | summarize | generate), non-streaming JSON `query_id` plus
// `results[{url,name,site,score,description,schema_object}]`; /mcp speaks MCP
// (JSON-RPC 2.0). What we do NOT do: `generate` mode (no model, so it is refused
// honestly), conversation memory (`prev` is accepted and ignored), streaming.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { askSite, handleMcp, searchDocs, type SiteDoc } from "../nlweb";
import { detectChannels } from "../../channels";

const SITE = { name: "Riverside Dental", origin: "https://riverside.test" };
const DOCS: SiteDoc[] = [
  { url: "https://riverside.test/", name: "Riverside Dental", text: "A family dental practice in Riverside. We offer check-ups, hygiene visits and emergency care." },
  { url: "https://riverside.test/hours", name: "Opening hours", text: "We are open Monday to Friday 9:00 to 17:00. Saturday 9:00 to 13:00. Closed on Sunday." },
  { url: "https://riverside.test/prices", name: "Prices", text: "A check-up costs 45 pounds. A hygiene visit costs 60 pounds. Emergency appointments cost 85 pounds." },
  { url: "https://riverside.test/contact", name: "Contact", text: "Call 01234 567890 or email hello@riverside.test. Find us at 12 High Street, Riverside." },
];

describe("searchDocs", () => {
  it("ranks the page that answers the question first, with a 0 to 100 score", () => {
    const r = searchDocs(DOCS, "what are your opening hours on Saturday?");
    assert.equal(r[0].doc.url, "https://riverside.test/hours");
    assert.ok(r[0].score > 0 && r[0].score <= 100);
    assert.ok(r.every((x, i) => i === 0 || r[i - 1].score >= x.score));
  });

  it("returns nothing when no word matches", () => {
    assert.deepEqual(searchDocs(DOCS, "quantum chromodynamics"), []);
  });

  it("matches simple plurals and ignores stop words", () => {
    assert.equal(searchDocs(DOCS, "the price of a check-up")[0].doc.url, "https://riverside.test/prices");
    assert.equal(searchDocs(DOCS, "what is the")?.length, 0);
  });

  it("honours the result limit", () => {
    assert.equal(searchDocs(DOCS, "riverside", 2).length, 2);
  });
});

describe("askSite (the /ask response)", () => {
  it("list mode returns the NLWeb result shape with the site's own text only", () => {
    const res = askSite(DOCS, SITE, { query: "how much is a check-up" });
    assert.equal(res.mode, "list");
    assert.match(res.query_id, /^[0-9a-f]{16}$/);
    const top = res.results[0];
    assert.equal(top.url, "https://riverside.test/prices");
    assert.equal(top.name, "Prices");
    assert.equal(top.site, "riverside.test");
    assert.ok(top.description.includes("45 pounds"));
    assert.deepEqual(top.schema_object, { "@type": "WebPage", name: "Prices", url: "https://riverside.test/prices" });
    assert.equal(res.summary, undefined);
  });

  it("summarize mode is extractive: sentences copied from the top pages, with sources", () => {
    const res = askSite(DOCS, SITE, { query: "how much is a check-up", mode: "summarize" });
    assert.equal(res.summary?.method, "extractive");
    assert.equal(res.summary?.text, "A check-up costs 45 pounds.");
    assert.deepEqual(res.summary?.sources, ["https://riverside.test/prices"]);
  });

  it("every summary sentence is verbatim from a source page (nothing invented)", () => {
    const res = askSite(DOCS, SITE, { query: "opening hours Saturday emergency", mode: "summarize" });
    const corpus = DOCS.map((d) => d.text).join(" ");
    for (const s of (res.summary?.text ?? "").split(/(?<=\.)\s+/).filter(Boolean)) assert.ok(corpus.includes(s), s);
  });

  it("summarize with no match says so instead of guessing", () => {
    const res = askSite(DOCS, SITE, { query: "quantum chromodynamics", mode: "summarize" });
    assert.deepEqual(res.results, []);
    assert.equal(res.summary, undefined);
    assert.match(res.message ?? "", /nothing on this site/i);
  });

  it("generate mode is refused honestly (no model behind this endpoint)", () => {
    assert.throws(() => askSite(DOCS, SITE, { query: "x", mode: "generate" }), /generate/i);
  });

  it("rejects an empty or oversized query", () => {
    assert.throws(() => askSite(DOCS, SITE, { query: "   " }), /query/i);
    assert.throws(() => askSite(DOCS, SITE, { query: "a".repeat(501) }), /too long/i);
  });

  it("is read-only and deterministic", () => {
    const a = askSite(DOCS, SITE, { query: "prices" });
    const b = askSite(DOCS, SITE, { query: "prices" });
    assert.deepEqual(a, b);
  });

  it("is read back by the channel detector as a working NLWeb tool (round trip)", () => {
    const body = JSON.stringify(askSite(DOCS, SITE, { query: "ping" }));
    const r = detectChannels({ origin: SITE.origin, html: '<link rel="nlweb" href="/ask">', files: { "/ask?query=ping": { status: 200, body } } });
    const nl = r.declaredTools.find((t) => t.source === "nlweb");
    assert.equal(nl?.verified, true);
  });
});

describe("handleMcp (JSON-RPC 2.0)", () => {
  const call = (msg: unknown) => handleMcp(DOCS, SITE, msg);

  it("initialize advertises tools only and the server name", () => {
    const r = call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(r?.id, 1);
    const result = r?.result as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } };
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.deepEqual(Object.keys(result.capabilities), ["tools"]);
    assert.equal(result.serverInfo.name, "Riverside Dental");
  });

  it("tools/list has one read-only ask tool", () => {
    const r = call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (r?.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema: { required: string[] } }[] }).tools;
    assert.deepEqual(tools.map((t) => t.name), ["ask"]);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    assert.deepEqual(tools[0].inputSchema.required, ["query"]);
  });

  it("tools/call ask returns the results as text content", () => {
    const r = call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask", arguments: { query: "opening hours" } } });
    const result = r?.result as { content: { type: string; text: string }[]; isError?: boolean };
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.results[0].url, "https://riverside.test/hours");
  });

  it("an unknown tool and a bad query are tool errors, not crashes", () => {
    const unknown = call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
    assert.equal(unknown?.error?.code, -32602);
    const bad = call({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask", arguments: { query: "" } } });
    assert.equal((bad?.result as { isError: boolean }).isError, true);
  });

  it("answers ping and prompts/list, errors on unknown methods, ignores notifications", () => {
    assert.deepEqual(call({ jsonrpc: "2.0", id: 6, method: "ping" })?.result, {});
    assert.deepEqual(call({ jsonrpc: "2.0", id: 7, method: "prompts/list" })?.result, { prompts: [] });
    assert.equal(call({ jsonrpc: "2.0", id: 8, method: "resources/read" })?.error?.code, -32601);
    assert.equal(call({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  });

  it("rejects malformed JSON-RPC", () => {
    assert.equal(call("nope")?.error?.code, -32600);
    assert.equal(call({ id: 1, method: "ping" })?.error?.code, -32600);
  });
});
