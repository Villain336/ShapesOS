// ShapesOS — Phase 9 (apps): spec validation (pure).
// Run: npx tsx --test lib/apps/__tests__/spec.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveActionTier,
  entityReadRole,
  parseSpec,
  recordWriteAction,
  roleMeets,
  slugify,
  starterSpec,
  titleFieldOf,
  viewFields,
  type MiniAppSpec,
} from "../spec";

function base(): MiniAppSpec {
  return {
    name: "Vendor tracker",
    slug: "vendors",
    entities: [
      {
        key: "vendors",
        label: "Vendor",
        titleField: "name",
        fields: [
          { key: "name", label: "Name", type: "text", required: true, maxLength: 120 },
          { key: "stage", label: "Stage", type: "select", options: ["Lead", "Active", "Closed"] },
          { key: "spend", label: "Annual spend", type: "money", min: 0 },
          { key: "since", label: "Since", type: "date" },
          { key: "contract", label: "Contract", type: "file" },
        ],
      },
      {
        key: "contacts",
        label: "Contact",
        fields: [
          { key: "email", label: "Email", type: "text", format: "email", required: true },
          { key: "vendor", label: "Vendor", type: "relation", target: "vendors" },
        ],
      },
    ],
    views: [
      { key: "all", label: "All vendors", type: "table", entity: "vendors", fields: ["name", "stage", "spend"], sort: { field: "createdAt", dir: "desc" } },
      { key: "board", label: "Board", type: "kanban", entity: "vendors", groupBy: "stage" },
      { key: "big", label: "Big spenders", type: "table", entity: "vendors", filters: [{ field: "spend", op: "gte", value: 100000 }], minRole: "admin" },
      { key: "people", label: "Contacts", type: "table", entity: "contacts", minRole: "editor" },
    ],
    actions: [
      { key: "add", label: "Add vendor", type: "create_record", entity: "vendors" },
      { key: "edit", label: "Edit", type: "update_record", entity: "vendors" },
      { key: "close", label: "Close", type: "update_record", entity: "vendors", set: { stage: "Closed" } },
      { key: "remove", label: "Remove", type: "delete_record", entity: "vendors" },
    ],
  };
}

function errorsOf(spec: unknown): string[] {
  const r = parseSpec(spec);
  return r.ok ? [] : r.errors;
}

describe("mini-app spec: parse", () => {
  it("accepts a well-formed spec and the starter spec", () => {
    assert.deepEqual(errorsOf(base()), []);
    const starter = starterSpec("Team requests", "team-requests", "Things the team asked for");
    assert.deepEqual(errorsOf(starter), []);
  });

  it("refuses unknown keys anywhere (strict), with a readable path", () => {
    const s = base() as unknown as Record<string, unknown>;
    s.colour = "red";
    assert.match(errorsOf(s)[0]!, /Unrecognized key/i);
    const t = base();
    (t.entities[0]!.fields[0] as Record<string, unknown>).secret = 1;
    assert.match(errorsOf(t)[0]!, /^entities\[0\]\.fields\[0\]/);
  });

  it("refuses bad keys and slugs", () => {
    const s = base();
    s.slug = "Vendors!";
    assert.match(errorsOf(s)[0]!, /^slug:/);
    const t = base();
    t.entities[0]!.fields[0]!.key = "Name";
    assert.match(errorsOf(t)[0]!, /lower_snake_case/);
  });

  it("cross-checks: duplicates, select options, relation targets, reserved keys", () => {
    const dup = base();
    dup.entities[0]!.fields.push({ key: "name", label: "Again", type: "text" });
    assert.ok(errorsOf(dup).some((e) => /duplicate field key "name"/.test(e)));

    const noOpts = base();
    noOpts.entities[0]!.fields[1] = { key: "stage", label: "Stage", type: "select" };
    assert.ok(errorsOf(noOpts).some((e) => /needs at least one option/.test(e)));

    const badTarget = base();
    badTarget.entities[1]!.fields[1] = { key: "vendor", label: "Vendor", type: "relation", target: "suppliers" };
    assert.ok(errorsOf(badTarget).some((e) => /unknown entity "suppliers"/.test(e)));

    const reserved = base();
    reserved.entities[0]!.fields.push({ key: "createdAt" as never, label: "x", type: "text" });
    assert.ok(errorsOf(reserved).length > 0);

    const wrongAttr = base();
    wrongAttr.entities[0]!.fields[0] = { key: "name", label: "Name", type: "text", min: 3 };
    assert.ok(errorsOf(wrongAttr).some((e) => /min and max apply to number and money/.test(e)));

    const centsOnly = base();
    centsOnly.entities[0]!.fields[2] = { key: "spend", label: "Spend", type: "money", min: 0.5 };
    assert.ok(errorsOf(centsOnly).some((e) => /whole cents/.test(e)));
  });

  it("cross-checks views: entity, fields, filter ops by type, kanban groupBy", () => {
    const v1 = base();
    v1.views[0]!.fields = ["name", "nope"];
    assert.ok(errorsOf(v1).some((e) => /"nope" is not a field of vendors/.test(e)));

    const v2 = base();
    v2.views[0]!.filters = [{ field: "name", op: "gt", value: "a" }];
    assert.ok(errorsOf(v2).some((e) => /gt works on number, money and date/.test(e)));

    const v3 = base();
    v3.views[0]!.filters = [{ field: "spend", op: "contains", value: "1" }];
    assert.ok(errorsOf(v3).some((e) => /contains works on text/.test(e)));

    const v4 = base();
    v4.views[1]!.groupBy = "name";
    assert.ok(errorsOf(v4).some((e) => /must be a select field/.test(e)));

    const v5 = base();
    v5.views[0]!.filters = [{ field: "stage", op: "eq" }];
    assert.ok(errorsOf(v5).some((e) => /eq needs a value/.test(e)));

    const v6 = base();
    v6.views[0]!.filters = [{ field: "updatedAt", op: "gte", value: "2026-01-01" }];
    assert.deepEqual(errorsOf(v6), [], "system fields filter as dates");
  });

  it("cross-checks actions: entity, set values, type-specific keys, role floor, tier floor", () => {
    const a1 = base();
    a1.actions[2]!.set = { stage: "Gone" };
    assert.ok(errorsOf(a1).some((e) => /must be one of: Lead, Active, Closed/.test(e)));

    const a2 = base();
    a2.actions.push({ key: "wf", label: "Kick off", type: "run_workflow" });
    assert.ok(errorsOf(a2).some((e) => /needs a workflowId/.test(e)));

    const a3 = base();
    a3.actions.push({ key: "t", label: "Look up", type: "call_tool" });
    assert.ok(errorsOf(a3).some((e) => /needs a tool/.test(e)));

    const a4 = base();
    a4.actions[0]!.minRole = "viewer";
    assert.ok(errorsOf(a4).some((e) => /at least the editor role/.test(e)));

    const a5 = base();
    a5.actions[3]!.tier = 0;
    assert.ok(errorsOf(a5).some((e) => /can't run below tier 1/.test(e)), "deletes ask first at least");

    const a6 = base();
    a6.actions.push({ key: "refund", label: "Refund the deposit", type: "update_record", entity: "vendors", set: { stage: "Closed" }, tier: 1 });
    assert.ok(errorsOf(a6).some((e) => /can't run below tier 2/.test(e)), "Tier-3 wording lifts to an approval");

    const a7 = base();
    a7.actions.push({ key: "x", label: "X", type: "create_record", entity: "vendors", workflowId: "w1" });
    assert.ok(errorsOf(a7).some((e) => /only run_workflow actions have a workflowId/.test(e)));
  });
});

describe("mini-app spec: tiers, roles and lookups", () => {
  it("effective tier never drops below the floor", () => {
    const s = base();
    assert.equal(effectiveActionTier(s.actions[0]!), 0);
    assert.equal(effectiveActionTier(s.actions[3]!), 1, "delete defaults to asks-first");
    assert.equal(effectiveActionTier({ key: "x", label: "Refund the customer", type: "update_record", entity: "vendors" }), 2);
    assert.equal(effectiveActionTier({ key: "x", label: "Run", type: "run_workflow", workflowId: "w" }), 1);
    const tool = { key: "t", label: "Look up", type: "call_tool" as const, tool: "get_keywords" };
    assert.equal(effectiveActionTier(tool, { toolKind: "safe" }), 0);
    assert.equal(effectiveActionTier(tool, { toolKind: "publish" }), 1);
    assert.equal(effectiveActionTier(tool, { toolKind: "destructive" }), 2);
    assert.equal(effectiveActionTier({ ...tool, tier: 2 }, { toolKind: "safe" }), 2, "a spec may raise a tier");
  });

  it("entity read role is the lowest role among its views (no view → editor)", () => {
    const s = base();
    assert.equal(entityReadRole(s, "vendors"), "viewer");
    assert.equal(entityReadRole(s, "contacts"), "editor");
    s.views = s.views.filter((v) => v.entity !== "contacts");
    assert.equal(entityReadRole(s, "contacts"), "editor");
    assert.equal(roleMeets("admin", "editor"), true);
    assert.equal(roleMeets("viewer", "editor"), false);
    assert.equal(roleMeets("nobody", "viewer"), false);
  });

  it("lookups: view fields, title field, write actions, slugify", () => {
    const s = base();
    assert.deepEqual(viewFields(s, s.views[0]!).map((f) => f.key), ["name", "stage", "spend"]);
    assert.equal(viewFields(s, s.views[1]!).length, 5, "no fields = every field");
    assert.equal(titleFieldOf(s.entities[1]!).key, "email", "first text field");
    assert.equal(recordWriteAction(s, "vendors", "update")?.key, "edit", "the edit action, not a fixed-value one");
    assert.equal(recordWriteAction(s, "contacts", "create"), undefined);
    assert.equal(slugify("  Team Requests (Q4)! "), "team-requests-q4");
    assert.equal(slugify("!!!"), "app");
  });
});
