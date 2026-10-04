// ShapesOS Phase 10 (ops-core) — the Operations home's section list.
//
// One list drives the /dashboard/ops sub-nav, the overview cards, the
// ⌘K redirects from the old CRM tabs and the Odoo parity script. Sections
// marked `finance` are built by the parallel FINANCE workstream as
// app/dashboard/ops/<slug>/page.tsx; they are linked here so the home is
// complete once both branches merge.

export interface OpsSection {
  slug: string; // "" = overview
  href: string;
  label: string;
  /** SectionNav icon key (app/dashboard/_components/SectionNav.tsx). */
  icon: string;
  description: string;
  owner: "opscore" | "finance" | "store";
}

const s = (
  slug: string,
  label: string,
  icon: string,
  description: string,
  owner: OpsSection["owner"] = "opscore",
): OpsSection => ({ slug, href: slug ? `/dashboard/ops/${slug}` : "/dashboard/ops", label, icon, description, owner });

export const OPS_SECTIONS: OpsSection[] = [
  s("", "Overview", "overview", "What needs attention across operations"),
  s("orders", "Orders", "orders", "Sales orders: draft, confirm, fulfil"),
  s("payments", "Payments", "payments", "Charge and refund records"),
  s("promotions", "Promotions", "promotions", "Discount codes and their rules"),
  // Phase 10 (store)
  s("store", "Online store", "store", "Public storefront, listed products and web orders", "store"),
  s("invoices", "Invoices", "invoices", "Draft, send and collect invoices"),
  s("inventory", "Products & inventory", "inventory", "Products, variants, warehouses, stock by location"),
  s("purchasing", "Purchasing", "purchasing", "Purchase orders and reorder rules"),
  s("projects", "Projects", "projects", "Projects, tasks, timesheets"),
  s("helpdesk", "Helpdesk", "helpdesk", "Support tickets and SLAs"),
  s("team", "Team", "team", "People, departments, leave, recruiting"),
  s("workflows", "Workflows", "workflows", "Multi-step operations with rollback"),
  s("accounting", "Accounting", "accounting", "Chart of accounts, journal, reports", "finance"),
  s("quotes", "Quotes", "quotes", "Estimates that convert to orders or invoices", "finance"),
  s("vendors", "Vendors & bills", "vendors", "Suppliers and the bills they send", "finance"),
  s("expenses", "Expenses", "expenses", "Company expense claims", "finance"),
];

/**
 * Old CRM tab ids (/dashboard/crm?tab=…) → their new home. ⌘K and saved
 * links keep working: the CRM page redirects these, carrying the query.
 */
export const LEGACY_CRM_TAB_REDIRECTS: Record<string, string> = {
  invoicing: "/dashboard/ops/invoices",
  inventory: "/dashboard/ops/inventory",
  "purchase-orders": "/dashboard/ops/purchasing",
  projects: "/dashboard/ops/projects",
  team: "/dashboard/ops/team",
  workflows: "/dashboard/ops/workflows",
};

/** Build the redirect target for a legacy CRM deep link (null = not an ops tab). */
export function legacyCrmRedirect(params: Record<string, string | string[] | undefined>): string | null {
  const tab = typeof params.tab === "string" ? params.tab : null;
  if (!tab) return null;
  const base = LEGACY_CRM_TAB_REDIRECTS[tab];
  if (!base) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (k === "tab" || v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  const qs = q.toString();
  return qs ? `${base}?${qs}` : base;
}
