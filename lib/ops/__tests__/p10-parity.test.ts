// ShapesOS Phase 10 (ops-core): the Odoo parity script. Unit (no DB).
// Run: npx tsx --test lib/ops/__tests__/p10-parity.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROWS, evaluate, loadCtx, parseCommitted, regressions, render, type Ctx } from "../parity";

describe("odoo parity", () => {
  const ctx = loadCtx();
  const now = evaluate(ctx);

  it("the committed table matches the codebase (no regressions)", () => {
    const committed = parseCommitted(readFileSync("docs/audit/ODOO-PARITY.md", "utf8"));
    assert.ok(committed.size >= ROWS.length - 1, "committed table parses");
    assert.deepEqual(regressions(committed, now), []);
  });

  it("every ops-core row is complete", () => {
    for (const e of now.filter((x) => x.row.owner === "ops-core")) assert.equal(e.status, "✅", e.row.app);
  });

  it("a ✅ row that loses its model fails; a ❌ finance row never fails", () => {
    const committed = parseCommitted(render(now));
    const broken: Ctx = { ...ctx, schema: ctx.schema.replace(/^model OpsTicket\s*\{/m, "model OpsTicketGone {") };
    const regs = regressions(committed, evaluate(broken));
    assert.equal(regs.length, 1);
    assert.match(regs[0]!, /^Helpdesk .*was ✅, now ⚠️ — missing model OpsTicket/);
    // A finance row whose files are missing is not ✅, and a row committed
    // as ❌ never counts as a regression.
    const noQuotes: Ctx = {
      schema: ctx.schema.replace(/^model OpsQuote\s*\{/m, "model OpsQuoteGone {"),
      entitySlugs: new Set([...ctx.entitySlugs].filter((x) => x !== "quotes")),
      files: ctx.files.filter((f) => !/quote/i.test(f) && !/finance-invoicing-db/.test(f)),
    };
    const missing = evaluate(noQuotes);
    assert.notEqual(missing.find((e) => e.row.app === "Quotes")!.status, "✅");
    assert.deepEqual(regressions(new Map([["Quotes", "❌"]]), missing), []);
  });

  it("finance rows light up from name patterns once their files exist", () => {
    const merged: Ctx = {
      schema: `${ctx.schema}\nmodel OpsQuote {\n  id String @id\n}\n`,
      entitySlugs: new Set([...ctx.entitySlugs, "quotes"]),
      files: [...ctx.files, "app/dashboard/ops/quotes/page.tsx", "app/api/ops/quotes/[id]/convert/route.ts", "lib/ops/__tests__/quotes.test.ts"],
    };
    assert.equal(evaluate(merged).find((e) => e.row.app === "Quotes")!.status, "✅");
  });

  it("a removed ✅ row is a regression", () => {
    assert.deepEqual(regressions(new Map([["Ghost app", "✅"]]), now), ["Ghost app: row removed from the parity table"]);
  });
});
