// ShapesOS — Phase 9 (apps): record validation, view queries, display (pure).
// Run: npx tsx --test lib/apps/__tests__/records.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EntitySpec } from "../spec";
import {
  applyViewQuery,
  formatValue,
  orphanKeys,
  parseMoneyInput,
  validateFieldValue,
  validateRecordData,
  type RecordRow,
} from "../records";

const ticket: EntitySpec = {
  key: "tickets",
  label: "Ticket",
  fields: [
    { key: "title", label: "Title", type: "text", required: true, maxLength: 20 },
    { key: "email", label: "Email", type: "text", format: "email" },
    { key: "site", label: "Site", type: "text", format: "url" },
    { key: "points", label: "Points", type: "number", min: 0, max: 13 },
    { key: "budget", label: "Budget", type: "money", min: 0 },
    { key: "due", label: "Due", type: "date" },
    { key: "urgent", label: "Urgent", type: "bool" },
    { key: "status", label: "Status", type: "select", options: ["Open", "Closed"], required: true },
    { key: "owner", label: "Owner", type: "relation", target: "people" },
    { key: "attachment", label: "Attachment", type: "file" },
  ],
};

describe("field values", () => {
  it("normalizes and validates each type", () => {
    const f = (k: string) => ticket.fields.find((x) => x.key === k)!;
    assert.deepEqual(validateFieldValue(f("title"), "  Hi  "), { ok: true, value: "Hi" });
    assert.equal(validateFieldValue(f("title"), "x".repeat(21)).ok, false);
    assert.equal(validateFieldValue(f("email"), "not-an-email").ok, false);
    assert.equal(validateFieldValue(f("site"), "javascript:alert(1)").ok, false, "only http(s) links");
    assert.equal(validateFieldValue(f("site"), "https://example.com").ok, true);
    assert.deepEqual(validateFieldValue(f("points"), "5"), { ok: true, value: 5 }, "form strings coerce");
    assert.equal(validateFieldValue(f("points"), 14).ok, false);
    assert.equal(validateFieldValue(f("budget"), 12.5).ok, false, "money is whole cents");
    assert.deepEqual(validateFieldValue(f("budget"), 1250), { ok: true, value: 1250 });
    assert.equal(validateFieldValue(f("due"), "2026-02-30").ok, false, "real calendar dates only");
    assert.deepEqual(validateFieldValue(f("due"), "2026-02-28"), { ok: true, value: "2026-02-28" });
    assert.deepEqual(validateFieldValue(f("urgent"), "false"), { ok: true, value: false });
    assert.equal(validateFieldValue(f("urgent"), "maybe").ok, false);
    assert.equal(validateFieldValue(f("status"), "Pending").ok, false);
    assert.equal(validateFieldValue(f("owner"), "rec_1; DROP").ok, false, "ids are plain tokens");
    assert.deepEqual(validateFieldValue(f("owner"), ""), { ok: true, value: undefined }, "empty clears");
  });
});

describe("record data", () => {
  it("create: required fields, unknown keys, refs to check", () => {
    const missing = validateRecordData(ticket, { title: "A" });
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.errors.status! : "", /required/);

    const unknown = validateRecordData(ticket, { title: "A", status: "Open", color: "red" });
    assert.equal(unknown.ok, false);
    assert.match(!unknown.ok ? unknown.errors.color! : "", /not a field/);

    const ok = validateRecordData(ticket, { title: "A", status: "Open", owner: "rec_9", attachment: "file_1", urgent: false });
    assert.ok(ok.ok);
    if (ok.ok) {
      assert.deepEqual(ok.data, { title: "A", status: "Open", owner: "rec_9", attachment: "file_1", urgent: false });
      assert.deepEqual(ok.refs.relations, [{ field: "owner", target: "people", id: "rec_9" }]);
      assert.deepEqual(ok.refs.files, [{ field: "attachment", id: "file_1" }]);
    }
    assert.equal(validateRecordData(ticket, ["nope"]).ok, false);
    assert.equal(validateRecordData(ticket, null).ok, false);
  });

  it("update: merges onto the stored record, keeps older-version keys, re-checks only what changed", () => {
    const existing = { title: "Old", status: "Open", owner: "rec_9", legacy_code: "X-1" };
    const r = validateRecordData(ticket, { status: "Closed" }, { existing });
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(r.data, { title: "Old", status: "Closed", owner: "rec_9", legacy_code: "X-1" });
      assert.deepEqual(r.refs.relations, [], "carried-over relations are not re-checked");
    }
    const cleared = validateRecordData(ticket, { title: "" }, { existing });
    assert.equal(cleared.ok, false, "clearing a required field fails");
    const dropOptional = validateRecordData(ticket, { owner: null }, { existing });
    assert.ok(dropOptional.ok && !("owner" in dropOptional.data));
    assert.deepEqual(orphanKeys(ticket, existing), ["legacy_code"]);
  });

  it("refuses records over the size cap", () => {
    const big: EntitySpec = { key: "n", label: "Note", fields: Array.from({ length: 10 }, (_, i) => ({ key: `f${i}`, label: `F${i}`, type: "text" as const })) };
    const data = Object.fromEntries(big.fields.map((f) => [f.key, "x".repeat(9000)]));
    const r = validateRecordData(big, data);
    assert.equal(r.ok, false);
  });
});

describe("view queries", () => {
  const rows: RecordRow[] = [
    { id: "1", data: { title: "Sink", status: "Open", points: 3, due: "2026-03-01" }, specVersion: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
    { id: "2", data: { title: "Roof", status: "Closed", points: 8 }, specVersion: 1, createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" },
    { id: "3", data: { title: "sink drain", status: "Open", points: 10, due: "2026-02-01" }, specVersion: 2, createdAt: "2026-01-05T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z" },
  ];

  it("filters by op and type, searches and sorts (empty last)", () => {
    const ids = (r: RecordRow[]) => r.map((x) => x.id);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { filters: [{ field: "status", op: "eq", value: "Open" }] })), ["1", "3"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { filters: [{ field: "points", op: "gte", value: "8" }] })), ["2", "3"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { filters: [{ field: "due", op: "empty" }] })), ["2"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { filters: [{ field: "title", op: "contains", value: "SINK" }] })), ["1", "3"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { q: "roof" })), ["2"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { sort: { field: "due", dir: "asc" } })), ["3", "1", "2"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { sort: { field: "points", dir: "desc" } })), ["3", "2", "1"], "numeric, not lexical");
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { sort: { field: "createdAt", dir: "desc" } })), ["3", "2", "1"]);
    assert.deepEqual(ids(applyViewQuery(rows, ticket, { filters: [{ field: "createdAt", op: "gt", value: "2026-01-02" }] })), ["2", "3"]);
  });
});

describe("display", () => {
  it("formats money, bools and parses typed money", () => {
    const budget = ticket.fields.find((f) => f.key === "budget")!;
    assert.equal(formatValue(budget, 123450), "$1,234.50");
    assert.equal(formatValue(ticket.fields.find((f) => f.key === "urgent"), false), "No");
    assert.equal(formatValue(undefined, "x"), "x");
    assert.equal(parseMoneyInput("$1,234.5"), 123450);
    assert.equal(parseMoneyInput("-3"), -300);
    assert.equal(parseMoneyInput("1.234"), null);
    assert.equal(parseMoneyInput(""), null);
  });
});
