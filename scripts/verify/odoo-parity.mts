// ShapesOS Phase 10 — Odoo parity table (CLI).
//
//   npx tsx scripts/verify/odoo-parity.mts           write docs/audit/ODOO-PARITY.md
//   npx tsx scripts/verify/odoo-parity.mts --check   CI: verify only, never write
//
// Regression guard: a row the COMMITTED table marks ✅ must stay ✅ — if a
// model, route, page or test it relied on disappears, this exits 1 and names
// what went missing. Rows that improve never fail (the table is just stale;
// re-run without --check to refresh it). Table + probes: lib/ops/parity.ts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARITY_DOC, evaluate, loadCtx, parseCommitted, regressions, render } from "../../lib/ops/parity";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");

function main() {
  const evaluated = evaluate(loadCtx());
  const next = render(evaluated);
  const prevText = existsSync(join(ROOT, PARITY_DOC)) ? readFileSync(join(ROOT, PARITY_DOC), "utf8") : "";
  const regs = regressions(parseCommitted(prevText), evaluated);
  for (const e of evaluated) console.log(`${e.status} ${e.row.app}`);
  if (regs.length) {
    console.error(`\nodoo-parity: ${regs.length} regression(s):\n- ${regs.join("\n- ")}`);
    process.exit(1);
  }
  if (CHECK) {
    if (prevText.trim() !== next.trim()) console.log(`\nodoo-parity: ${PARITY_DOC} is stale (no regressions) — re-run without --check to refresh it.`);
    console.log("odoo-parity: OK");
    return;
  }
  writeFileSync(join(ROOT, PARITY_DOC), next);
  console.log(`\nodoo-parity: wrote ${PARITY_DOC}`);
}

main();
