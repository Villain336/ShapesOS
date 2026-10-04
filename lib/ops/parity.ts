// ShapesOS Phase 10 (ops-core) — Odoo parity: the app table and its probes.
//
// Inspects the codebase (prisma/schema.prisma, the ops entity registry,
// app/api, app/dashboard, test files) for each Odoo-equivalent app and marks
// its model / API route / page / test columns: ✅ all four present, ⚠️ some,
// ❌ none (or planned for a later phase). The CLI is
// scripts/verify/odoo-parity.mts (writes docs/audit/ODOO-PARITY.md; --check
// in CI fails when a committed ✅ row loses a model, route, page or test).
//
// Rows owned by the parallel FINANCE workstream (accounting, quotes, vendors
// & bills, expenses) use name patterns, not exact file names, so they light
// up after that branch merges and simply read ❌ until then.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
export const PARITY_DOC = "docs/audit/ODOO-PARITY.md";

type Status = "✅" | "⚠️" | "❌";

export interface Ctx {
  schema: string;
  entitySlugs: Set<string>;
  files: string[];
}

interface Probe {
  label: string;
  ok: (c: Ctx) => boolean;
}

export interface ParityRow {
  app: string;
  odoo: string;
  owner: "ops-core" | "finance" | "store" | "phase 12" | "phase 4b" | "earlier";
  model: Probe[];
  route: Probe[];
  page: Probe[];
  test: Probe[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

const model = (name: string, pattern?: RegExp): Probe => ({
  label: name,
  ok: (c) => (pattern ?? new RegExp(`^model ${name}\\s*\\{`, "m")).test(c.schema),
});
const entity = (slug: string): Probe => ({ label: `/api/ops/${slug}`, ok: (c) => c.entitySlugs.has(slug) });
const file = (path: string): Probe => ({ label: path.replace(/^app\//, "").replace(/\/(page|route)\.tsx?$/, ""), ok: (c) => c.files.includes(path) });
const anyFile = (label: string, re: RegExp): Probe => ({ label, ok: (c) => c.files.some((f) => re.test(f)) });
const test = (path: string): Probe => ({ label: path.split("/").pop()!, ok: (c) => c.files.includes(path) });
const page = (slug: string) => file(`app/dashboard/ops/${slug}/page.tsx`);

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const ROWS: ParityRow[] = [
  {
    app: "CRM — leads & pipeline",
    odoo: "CRM",
    owner: "earlier",
    model: [model("Lead"), model("Pipeline")],
    route: [file("app/api/crm/leads/route.ts")],
    page: [file("app/dashboard/crm/page.tsx")],
    test: [anyFile("lib/crm/__tests__/*", /^lib\/crm\/__tests__\/.+\.test\.ts$/)],
  },
  {
    app: "CRM — contacts, companies, deals",
    odoo: "CRM / Contacts",
    owner: "ops-core",
    model: [model("OpsContact"), model("OpsCompany"), model("OpsDeal")],
    route: [entity("contacts"), entity("companies"), entity("deals"), file("app/api/ops/crm/convert-lead/route.ts")],
    page: [file("app/dashboard/crm/page.tsx")],
    test: [test("lib/ops/__tests__/p10-crm.test.ts"), test("lib/ops/__tests__/p10-crm-db.test.ts")],
  },
  {
    app: "Sales orders",
    odoo: "Sales",
    owner: "ops-core",
    model: [model("OpsOrder")],
    route: [entity("orders")],
    page: [page("orders")],
    test: [test("lib/ops/__tests__/doctype-conformance.test.ts")],
  },
  {
    app: "Payments",
    odoo: "Invoicing / Payments",
    owner: "ops-core",
    model: [model("OpsPayment")],
    route: [entity("payments")],
    page: [page("payments")],
    test: [test("lib/ops/__tests__/gate-classification.test.ts")],
  },
  {
    app: "Promotions",
    odoo: "eCommerce / Loyalty",
    owner: "ops-core",
    model: [model("OpsPromotion")],
    route: [entity("promotions")],
    page: [page("promotions")],
    test: [test("lib/ops/__tests__/p10-ops-home.test.ts")],
  },
  {
    app: "Invoicing",
    odoo: "Invoicing",
    owner: "ops-core",
    model: [model("OpsInvoice")],
    route: [entity("invoices")],
    page: [page("invoices")],
    test: [test("lib/ops/__tests__/invoices.test.ts")],
    note: "Numbering, PDF, email delivery, partial payments, credit notes: FINANCE workstream.",
  },
  {
    app: "Inventory — warehouses, locations, variants, transfers",
    odoo: "Inventory",
    owner: "ops-core",
    model: [model("OpsProduct"), model("OpsProductVariant"), model("OpsWarehouse"), model("OpsLocation"), model("OpsTransfer"), model("OpsInventoryTxn")],
    route: [entity("warehouses"), entity("locations"), entity("product-variants"), entity("transfers"), file("app/api/ops/inventory/stock/route.ts")],
    page: [page("inventory")],
    test: [test("lib/ops/__tests__/p10-inventory.test.ts"), test("lib/ops/__tests__/p10-inventory-db.test.ts")],
  },
  {
    app: "Purchase — orders and reorder rules",
    odoo: "Purchase",
    owner: "ops-core",
    model: [model("OpsPurchaseOrder"), model("OpsReorderRule")],
    route: [entity("purchase-orders"), entity("reorder-rules"), file("app/api/cron/ops-reorder/route.ts")],
    page: [page("purchasing")],
    test: [test("lib/ops/__tests__/inventory.test.ts"), test("lib/ops/__tests__/p10-inventory-db.test.ts")],
    note: "Vendor model, RFQ and vendor bills: FINANCE workstream.",
  },
  {
    app: "Projects — tasks (kanban)",
    odoo: "Project",
    owner: "ops-core",
    model: [model("OpsProject"), model("OpsTask")],
    route: [entity("projects"), entity("tasks")],
    page: [page("projects")],
    test: [test("lib/ops/__tests__/projects.test.ts"), test("lib/ops/__tests__/p10-projects-db.test.ts")],
  },
  {
    app: "Timesheets — approval and billing",
    odoo: "Timesheets",
    owner: "ops-core",
    model: [model("OpsTimeEntry")],
    route: [file("app/api/ops/timesheets/route.ts"), file("app/api/ops/projects/[id]/invoice-time/route.ts")],
    page: [page("projects")],
    test: [test("lib/ops/__tests__/p10-projects.test.ts"), test("lib/ops/__tests__/p10-projects-db.test.ts")],
  },
  {
    app: "Helpdesk — tickets, SLAs, inbound email",
    odoo: "Helpdesk",
    owner: "ops-core",
    model: [model("OpsTicket"), model("OpsTicketMessage"), model("OpsSlaPolicy")],
    route: [entity("tickets"), entity("sla-policies"), file("app/api/ops/tickets/[id]/reply/route.ts"), file("app/api/messaging/inbound/email/route.ts"), file("app/api/cron/ops-helpdesk-sla/route.ts")],
    page: [page("helpdesk")],
    test: [test("lib/ops/__tests__/p10-helpdesk.test.ts"), test("lib/ops/__tests__/p10-helpdesk-db.test.ts")],
    note: "Ticket view in a client portal: later (no client login yet).",
  },
  {
    app: "Employees — directory, departments, leave balances",
    odoo: "Employees / Time Off",
    owner: "ops-core",
    model: [model("OpsTeamMember"), model("OpsDepartment"), model("OpsLeaveRequest"), model("OpsLeavePolicy"), model("OpsLeaveLedger")],
    route: [entity("team-members"), entity("departments"), entity("leave-requests"), entity("leave-policies"), file("app/api/ops/hr/leave-balances/route.ts")],
    page: [page("team")],
    test: [test("lib/ops/__tests__/hr.test.ts"), test("lib/ops/__tests__/p10-hr.test.ts"), test("lib/ops/__tests__/p10-hr-db.test.ts")],
  },
  {
    app: "Recruiting",
    odoo: "Recruitment",
    owner: "ops-core",
    model: [model("OpsJobOpening"), model("OpsApplicant")],
    route: [entity("job-openings"), entity("applicants")],
    page: [page("team")],
    test: [test("lib/ops/__tests__/p10-hr-db.test.ts")],
  },
  {
    app: "Operations workflows",
    odoo: "(Studio automations)",
    owner: "earlier",
    model: [model("OpsWorkflowRun")],
    route: [entity("workflow-runs")],
    page: [page("workflows")],
    test: [test("lib/ops/__tests__/workflows.test.ts")],
  },
  // --- FINANCE workstream (pattern probes; ❌ until that branch merges) ---
  {
    app: "Accounting — chart of accounts, journal, reports",
    odoo: "Accounting",
    owner: "finance",
    model: [model("Ops*Account", /^model Ops\w*Account\s*\{/m), model("Ops*Journal*", /^model Ops\w*Journal\w*\s*\{/m)],
    route: [anyFile("/api/ops/accounting…", /^app\/api\/ops\/(accounting|journal|ledger)[^]*route\.ts$/)],
    page: [page("accounting")],
    test: [anyFile("*account*.test.ts", /^lib\/ops\/__tests__\/[^/]*(account|journal|ledger)[^/]*\.test\.ts$/i)],
  },
  {
    app: "Quotes",
    odoo: "Sales / Quotations",
    owner: "finance",
    model: [model("OpsQuote", /^model OpsQuote\w*\s*\{/m)],
    route: [anyFile("/api/ops/quotes", /^app\/api\/ops\/quotes?[^]*route\.ts$/), { label: "entity quotes", ok: (c) => c.entitySlugs.has("quotes") || c.files.some((f) => /^app\/api\/ops\/quotes/.test(f)) }],
    page: [page("quotes")],
    // Quotes are covered by the finance invoicing suite (send, PDF, convert).
    test: [anyFile("*quote*|finance-invoicing-db.test.ts", /^lib\/ops\/__tests__\/([^/]*quote[^/]*|finance-invoicing-db)\.test\.ts$/i)],
  },
  {
    app: "Vendors & bills",
    odoo: "Purchase / Vendor bills",
    owner: "finance",
    model: [model("OpsVendor", /^model OpsVendor\w*\s*\{/m), model("Ops*Bill", /^model Ops\w*Bill\w*\s*\{/m)],
    route: [{ label: "/api/ops/vendors|bills", ok: (c) => ["vendors", "bills", "vendor-bills"].some((s) => c.entitySlugs.has(s)) || c.files.some((f) => /^app\/api\/ops\/(vendors|bills|vendor-bills)/.test(f)) }],
    page: [page("vendors")],
    // Vendors, receipts and bills are covered by the finance purchasing suite.
    test: [anyFile("*vendor|bill*|finance-purchasing-db.test.ts", /^lib\/ops\/__tests__\/([^/]*(vendor|bill)[^/]*|finance-purchasing-db)\.test\.ts$/i)],
  },
  {
    app: "Expenses",
    odoo: "Expenses",
    owner: "finance",
    model: [model("OpsExpense", /^model OpsExpense\w*\s*\{/m)],
    route: [{ label: "/api/ops/expenses", ok: (c) => [...c.entitySlugs].some((s) => /^expense/.test(s)) || c.files.some((f) => /^app\/api\/ops\/expense/.test(f)) }],
    page: [page("expenses")],
    test: [anyFile("*expense*.test.ts", /^lib\/ops\/__tests__\/[^/]*expense[^/]*\.test\.ts$/i)],
  },
  // Phase 10 (store): public storefront, cart, tenant Stripe checkout.
  {
    app: "Storefront — public catalog, cart, checkout",
    odoo: "eCommerce / Website",
    owner: "store",
    model: [model("OpsStore"), model("OpsStoreListing"), model("OpsOrder")],
    route: [entity("stores"), entity("store-listings"), file("app/api/shop/[storeSlug]/cart/route.ts"), file("app/api/shop/[storeSlug]/checkout/route.ts")],
    page: [page("store"), file("app/shop/[storeSlug]/page.tsx"), file("app/shop/[storeSlug]/p/[productSlug]/page.tsx")],
    test: [test("lib/ops/__tests__/p10-store.test.ts"), test("lib/ops/__tests__/p10-store-db.test.ts")],
    note: "Payments through the workspace's own Stripe (FINANCE integration); live Stripe unverified in CI.",
  },
  // --- Not built yet (owner decision: Phase 12 / later) ---
  ...(
    [
      ["Manufacturing", "Manufacturing", "phase 12"],
      ["Point of sale", "Point of Sale", "phase 12"],
      ["Payroll", "Payroll", "phase 12"],
      ["Events", "Events", "phase 12"],
      ["Client portal", "Portal", "phase 12"],
    ] as const
  ).map(([app, odoo, owner]): ParityRow => ({ app, odoo, owner, model: [], route: [], page: [], test: [], note: "Planned — not started in this codebase." })),
];

// ---------------------------------------------------------------------------
// Evaluation + rendering
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out;
}

export function loadCtx(root = ROOT): Ctx {
  const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
  const entities = readFileSync(join(root, "lib/ops/entities.ts"), "utf8");
  const entitySlugs = new Set([...entities.matchAll(/^\s*slug:\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]!));
  const files = ["app", "lib", "components", "tests"].flatMap((d) => walk(join(root, d)));
  return { schema, entitySlugs, files };
}

export interface EvaluatedRow {
  row: ParityRow;
  cols: Record<"model" | "route" | "page" | "test", { ok: boolean; missing: string[]; present: string[] }>;
  status: Status;
}

export function evaluate(ctx: Ctx, rows: ParityRow[] = ROWS): EvaluatedRow[] {
  return rows.map((row) => {
    const col = (probes: Probe[]) => {
      const present = probes.filter((p) => p.ok(ctx)).map((p) => p.label);
      const missing = probes.filter((p) => !p.ok(ctx)).map((p) => p.label);
      return { ok: probes.length > 0 && missing.length === 0, missing, present };
    };
    const cols = { model: col(row.model), route: col(row.route), page: col(row.page), test: col(row.test) };
    const okCount = Object.values(cols).filter((c) => c.ok).length;
    const anyPresent = Object.values(cols).some((c) => c.present.length > 0);
    const status: Status = okCount === 4 ? "✅" : anyPresent ? "⚠️" : "❌";
    return { row, cols, status };
  });
}

const cell = (c: { ok: boolean; missing: string[]; present: string[] }) =>
  c.present.length === 0 && c.missing.length === 0
    ? "—"
    : `${c.ok ? "✅" : c.present.length ? "⚠️" : "❌"} ${[...c.present.map((p) => `\`${p}\``), ...c.missing.map((m) => `~~\`${m}\`~~`)].join(", ")}`;

export function render(evaluated: EvaluatedRow[]): string {
  const counts = { "✅": 0, "⚠️": 0, "❌": 0 } as Record<Status, number>;
  for (const e of evaluated) counts[e.status] += 1;
  const lines = [
    "# Odoo parity",
    "",
    "Generated by `npx tsx scripts/verify/odoo-parity.mts` from the codebase (schema models, the ops entity registry and route files, dashboard pages, test files). CI runs it with `--check`: a row marked ✅ here that loses its model, route, page or test fails the build. ~~Struck~~ items are missing.",
    "",
    `Summary: ${counts["✅"]} ✅ · ${counts["⚠️"]} ⚠️ · ${counts["❌"]} ❌`,
    "",
    "| App | Odoo app | Status | Model | API route | Page | Test | Owner | Note |",
    "|---|---|---|---|---|---|---|---|---|",
    ...evaluated.map(
      (e) =>
        `| ${e.row.app} | ${e.row.odoo} | ${e.status} | ${cell(e.cols.model)} | ${cell(e.cols.route)} | ${cell(e.cols.page)} | ${cell(e.cols.test)} | ${e.row.owner} | ${e.row.note ?? ""} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

/** App name → status from a committed table. */
export function parseCommitted(markdown: string): Map<string, Status> {
  const out = new Map<string, Status>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| App ") || line.startsWith("|---")) continue;
    const cells = line.split(" | ").map((c) => c.replace(/^\|\s*/, "").trim());
    const status = cells[2] as Status;
    if (cells[0] && ["✅", "⚠️", "❌"].includes(status)) out.set(cells[0], status);
  }
  return out;
}

/** Rows that were ✅ before and are not now (with what went missing). */
export function regressions(previous: Map<string, Status>, evaluated: EvaluatedRow[]): string[] {
  const now = new Map(evaluated.map((e) => [e.row.app, e]));
  const out: string[] = [];
  for (const [app, was] of previous) {
    if (was !== "✅") continue;
    const e = now.get(app);
    if (!e) {
      out.push(`${app}: row removed from the parity table`);
      continue;
    }
    if (e.status !== "✅") {
      const missing = Object.entries(e.cols).flatMap(([k, c]) => c.missing.map((m) => `${k} ${m}`));
      out.push(`${app}: was ✅, now ${e.status} — missing ${missing.join("; ")}`);
    }
  }
  return out;
}

