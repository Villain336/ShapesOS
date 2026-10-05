// ShapesOS — Phase 2: CRM CSV import row numbers + value bounds.
// Run: npx tsx --test lib/crm/__tests__/csv-import.test.ts
// Audit 2026-10-03 §5 (low): error rows were numbered after blank lines were
// dropped, and an over-large value overflowed Lead.valueCents into a
// generic "insert failed".

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_LEAD_VALUE_CENTS, parseCsvWithLines, parseLeadValueCents } from "../csv-import";

describe("parseCsvWithLines", () => {
  it("keeps source line numbers across blank lines (CRLF)", () => {
    const { rows, lines } = parseCsvWithLines("name\r\n\r\nA\r\n\r\nB");
    assert.deepEqual(rows, [["name"], ["A"], ["B"]]);
    assert.deepEqual(lines, [1, 3, 5], "B is on line 5, not row 3");
  });

  it("numbers a row by the line it starts on when a quoted field spans lines", () => {
    const { rows, lines } = parseCsvWithLines('name,note\n"Ann","two\nlines"\n\nBob,x\n');
    assert.deepEqual(rows, [["name", "note"], ["Ann", "two\nlines"], ["Bob", "x"]]);
    assert.deepEqual(lines, [1, 2, 5]);
  });

  it("strips a UTF-8 BOM so the first header still matches", () => {
    const { rows } = parseCsvWithLines("﻿name,email\nA,a@b.co");
    assert.equal(rows[0]![0], "name");
  });

  it("drops whitespace-only rows but not their line count", () => {
    const { rows, lines } = parseCsvWithLines("name\n  ,  \nZed");
    assert.deepEqual(rows, [["name"], ["Zed"]]);
    assert.deepEqual(lines, [1, 3]);
  });
});

describe("processImportRows error rows (route path, no DB writes reached)", () => {
  it("reports the source line and the bound message", async () => {
    const { processImportRows } = await import("@/app/api/crm/leads/import/route");
    const { rows, lines } = parseCsvWithLines("name,email,value\n\n,a@b.co,1\n\nBig,,99999999999\nBad,not-an-email,1\n");
    const res = await processImportRows("ws_none", "test", { id: "p", stages: [{ id: "new", label: "New" }] }, rows, lines);
    assert.deepEqual(
      res.errors.map((e) => e.row),
      [3, 5, 6],
    );
    assert.equal(res.errors[0]!.error, "name required");
    assert.match(res.errors[1]!.error, /at most/);
    assert.equal(res.errors[2]!.error, "invalid email");
    assert.equal(res.created, 0);
  });
});

describe("parseLeadValueCents", () => {
  it("parses dollars with $ and thousands separators", () => {
    assert.deepEqual(parseLeadValueCents("$1,234.56"), { cents: 123456 });
    assert.deepEqual(parseLeadValueCents(""), { cents: null });
  });

  it("bounds the value to the int4 column with a clear message", () => {
    const r = parseLeadValueCents("99999999999");
    assert.ok("error" in r);
    assert.match((r as { error: string }).error, /at most \$21,474,836\.47/);
    assert.deepEqual(parseLeadValueCents("21474836.47"), { cents: MAX_LEAD_VALUE_CENTS });
    assert.ok("error" in parseLeadValueCents("21474836.48"));
  });

  it("rejects negative and non-numeric values", () => {
    assert.match((parseLeadValueCents("-5") as { error: string }).error, /negative/);
    assert.match((parseLeadValueCents("lots") as { error: string }).error, /number/);
    assert.ok("error" in parseLeadValueCents("Infinity"));
  });
});
