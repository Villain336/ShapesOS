// H5: custom MCP connector tools are mutating (confirmation-gated) unless
// annotated readOnlyHint or admin allow-listed.
// Run: npx tsx --test lib/connectors/m21/__tests__/mcp-mutating.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mcpToolToDef } from "../mcp";
import { getAdapterForConnection, McpBackedAdapter, readOnlyToolsFromConfig } from "../index";

describe("mcpToolToDef", () => {
  it("defaults to mutating when the server says nothing", () => {
    assert.equal(mcpToolToDef({ name: "send_email" }).mutating, true);
    assert.equal(mcpToolToDef({ name: "list_files", description: "Lists files" }).mutating, true);
  });

  it("treats a tool as read-only only for readOnlyHint === true", () => {
    assert.equal(mcpToolToDef({ name: "list_files", annotations: { readOnlyHint: true } }).mutating, false);
    assert.equal(mcpToolToDef({ name: "list_files", annotations: { readOnlyHint: "true" } }).mutating, true);
    assert.equal(mcpToolToDef({ name: "delete_file", annotations: { readOnlyHint: false } }).mutating, true);
    assert.equal(mcpToolToDef({ name: "x", annotations: null }).mutating, true);
  });

  it("honours the admin read-only allow-list by exact name", () => {
    const opts = { readOnlyTools: ["search_docs"] };
    assert.equal(mcpToolToDef({ name: "search_docs" }, opts).mutating, false);
    assert.equal(mcpToolToDef({ name: "search_docs_and_delete" }, opts).mutating, true);
  });
});

describe("readOnlyToolsFromConfig", () => {
  it("reads Connector.config.readOnlyTools and fails closed on junk", () => {
    assert.deepEqual(readOnlyToolsFromConfig({ readOnlyTools: ["a", "b"] }), ["a", "b"]);
    assert.deepEqual(readOnlyToolsFromConfig({ readOnlyTools: ["a", 5, null, ""] }), ["a"]);
    assert.deepEqual(readOnlyToolsFromConfig({ readOnlyTools: "a" }), []);
    assert.deepEqual(readOnlyToolsFromConfig(null), []);
    assert.deepEqual(readOnlyToolsFromConfig(["a"]), []);
  });

  it("the resolved adapter carries the allow-list", async () => {
    const adapter = await getAdapterForConnection({
      connectorKey: "custom-mcp",
      connector: { mcpEndpoint: "https://mcp.example/mcp", config: { readOnlyTools: ["search_docs"] } },
    });
    assert.ok(adapter instanceof McpBackedAdapter);
    assert.deepEqual((adapter as unknown as { readOnlyTools: string[] }).readOnlyTools, ["search_docs"]);
  });
});
