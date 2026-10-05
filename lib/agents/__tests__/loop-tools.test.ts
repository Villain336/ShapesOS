// ShapesOS — Phase 8: tool schema conversion and API-safe name mapping (PURE).
// Run: env -u DATABASE_URL npx tsx --test lib/agents/__tests__/loop-tools.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  API_TOOL_NAME_RE,
  apiToolName,
  argsToJsonSchema,
  buildLoopTools,
  canonicalFromApiName,
  toolDefToChat,
  type ConnectorChatTool,
} from "../loop-tools";
import { TOOLS, toolGroup } from "@/lib/chat/tools";
import { validateToolInput } from "@/lib/llm/tool-input";

const connector = (connectorKey: string, name: string, mutating = false): ConnectorChatTool => ({
  connectorKey,
  name,
  description: `${name} on ${connectorKey}`,
  mutating,
  argsSchema: { type: "object", properties: { q: { type: "string", description: "query" } }, required: ["q"] },
});

describe("tool name mapping", () => {
  it("keeps API-safe names and maps connector names both ways", () => {
    assert.equal(apiToolName("get_keywords"), "get_keywords");
    assert.equal(apiToolName("connector.google-search-console.query"), "connector__google-search-console__query");
    assert.equal(canonicalFromApiName("connector__google-search-console__query"), "connector.google-search-console.query");
    assert.equal(canonicalFromApiName("get_keywords"), "get_keywords");
  });

  it("every catalog tool and odd connector names produce valid API names", () => {
    for (const t of TOOLS) assert.match(apiToolName(t.name), API_TOOL_NAME_RE, t.name);
    const odd = apiToolName("connector.my mcp server.do something/odd!");
    assert.match(odd, API_TOOL_NAME_RE);
    const long = apiToolName(`connector.${"x".repeat(80)}.${"y".repeat(40)}`);
    assert.match(long, API_TOOL_NAME_RE);
    assert.ok(long.length <= 64);
  });

  it("the run's map wins over the heuristic (sanitised names round-trip)", () => {
    const set = buildLoopTools({
      tools: [],
      grant: null,
      groupOf: toolGroup,
      connectorTools: [connector("my mcp", "do it")],
    });
    const api = set.defs[0]!.name;
    assert.match(api, API_TOOL_NAME_RE);
    assert.equal(set.toCanonical(api), "connector.my mcp.do it");
  });
});

describe("tool schema conversion", () => {
  it("argsSchema → JSON schema that validates real inputs", () => {
    const def = toolDefToChat(TOOLS.find((t) => t.name === "get_keywords")!);
    assert.equal(def.inputSchema.type, "object");
    assert.equal(validateToolInput(def.inputSchema, { list: "a", limit: "5" }), null);
    assert.match(String(validateToolInput(def.inputSchema, { limit: 5 })), /limit/);
  });

  it("required fields are kept and enforced", () => {
    const s = argsToJsonSchema({ properties: { a: { type: "string", description: "a" } }, required: ["a"] });
    assert.deepEqual(s.required, ["a"]);
    assert.match(String(validateToolInput(s, {})), /a/);
  });

  it("non-safe tools say they wait for the user's OK", () => {
    const def = toolDefToChat(TOOLS.find((t) => t.kind === "spend")!);
    assert.match(def.description, /waits for the user's OK/);
  });
});

describe("buildLoopTools", () => {
  it("filters catalog and connector tools by the grant; web grant turns on server tools", () => {
    const narrow = buildLoopTools({
      tools: TOOLS,
      grant: ["workspace", "email"],
      groupOf: toolGroup,
      connectorTools: [connector("gmail", "list_messages"), connector("dataforseo", "keyword_ideas")],
    });
    const names = narrow.defs.map((d) => d.name);
    assert.ok(names.includes("get_keywords"));
    assert.ok(!names.includes("research_question"), "web tool outside the grant");
    assert.ok(names.includes("connector__gmail__list_messages"));
    assert.ok(!names.includes("connector__dataforseo__keyword_ideas"), "dataforseo is the web group");
    assert.deepEqual(narrow.serverTools, []);

    const web = buildLoopTools({ tools: TOOLS, grant: ["workspace", "web"], groupOf: toolGroup });
    assert.ok(web.defs.some((d) => d.name === "research_question"));
    assert.deepEqual(web.serverTools, ["web_search", "web_fetch"]);
  });

  it("a filter narrows further than the grant", () => {
    const set = buildLoopTools({ tools: TOOLS, grant: null, groupOf: toolGroup, filter: (n) => n === "get_alerts" });
    assert.deepEqual(set.canonical, ["get_alerts"]);
  });
});
