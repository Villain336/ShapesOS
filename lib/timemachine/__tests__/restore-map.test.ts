// ShapesOS — Phase 18.3 (WS=flow): the snapshot importer's pure parts.
//   - tables restore skips on purpose (members, queues, billing, credentials,
//     hash-chained audit chains) — always with a reason
//   - insert order: parents first, cycles broken deterministically
//   - id rewriting reaches foreign keys, soft references and ids inside JSON,
//     never short strings
//   - the manifest is read from the export's last chunk

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Catalog, TableInfo } from "@/lib/gdpr/catalog";
import { insertOrder, newTextId, remapValue, skipReason } from "../restore";
import { manifestFromTail, snapshotBlobPath } from "../snapshots";

const table = (name: string, fks: Array<[string, string]> = [], extra: Partial<TableInfo> = {}): TableInfo => ({
  name,
  columns: [{ name: "id", type: "text" }],
  primaryKey: ["id"],
  foreignKeys: fks.map(([column, refTable]) => ({ column, refTable, refColumn: "id" })),
  hasWorkspaceId: true,
  rls: true,
  hashChained: false,
  hasTriggers: false,
  ...extra,
});

describe("restore mapping", () => {
  it("skips members, queues, billing, credentials and audit chains — with reasons", () => {
    assert.equal(skipReason("workspace_members"), "members");
    assert.equal(skipReason("webhook_deliveries"), "queues");
    assert.equal(skipReason("credit_ledger_entries"), "billing");
    assert.equal(skipReason("mcp_oauth_clients"), "connections");
    assert.equal(skipReason(table("mission_events", [], { hashChained: true })), "audit_chain");
    for (const t of ["projects", "univer_docs", "ops_tasks", "workflow_nodes", "workspace_files", "agent_runs"]) assert.equal(skipReason(t), null, t);
  });

  it("orders parents first and breaks cycles deterministically", () => {
    const cat: Catalog = new Map([
      ["workflow_edges", table("workflow_edges", [["workflow_id", "workflows"], ["source_node_id", "workflow_nodes"]])],
      ["workflow_nodes", table("workflow_nodes", [["workflow_id", "workflows"]])],
      ["workflows", table("workflows", [["project_id", "projects"]])],
      ["projects", table("projects")],
      ["a", table("a", [["b_id", "b"]])],
      ["b", table("b", [["a_id", "a"]])],
      ["self", table("self", [["parent_id", "self"]])],
    ]);
    const order = insertOrder([...cat.keys()], cat);
    const at = (t: string) => order.indexOf(t);
    assert.ok(at("projects") < at("workflows") && at("workflows") < at("workflow_nodes") && at("workflow_nodes") < at("workflow_edges"));
    assert.equal(order.length, cat.size);
    assert.deepEqual(insertOrder(["b", "a"], cat).slice(0, 2), insertOrder(["a", "b"], cat).slice(0, 2), "deterministic");
  });

  it("rewrites ids everywhere they appear, never short strings", () => {
    const ids = new Map([["ckold000000000000000001", "cnew1"], ["ws_old_0001", "ws_new"]]);
    assert.deepEqual(
      remapValue({ workspace_id: "ws_old_0001", project_id: "ckold000000000000000001", config: { nodes: [{ ref: "ckold000000000000000001" }], label: "ok" }, tags: ["ckold000000000000000001", "x"] }, ids),
      { workspace_id: "ws_new", project_id: "cnew1", config: { nodes: [{ ref: "cnew1" }], label: "ok" }, tags: ["cnew1", "x"] },
    );
    assert.equal(remapValue("short", new Map([["short", "x"]])), "short");
    assert.equal(remapValue(42, ids), 42);
    const a = newTextId();
    assert.match(a, /^c[a-f0-9]{24}$/);
    assert.notEqual(a, newTextId());
  });

  it("reads the manifest from the export's last chunk", () => {
    const m = manifestFromTail(`,"manifest":${JSON.stringify({ tables: { projects: { rows: 2, omittedColumns: [] } }, omittedTables: ["mcp_oauth_tokens"] })}}`);
    assert.deepEqual(m, { tables: { projects: { rows: 2, omittedColumns: [] } }, omittedTables: ["mcp_oauth_tokens"] });
    assert.equal(manifestFromTail("garbage"), null);
    assert.equal(snapshotBlobPath("ws1", "s1"), "ws1/s1.json.gz");
  });
});
