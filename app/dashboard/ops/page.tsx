// ShapesOS Phase 10 (ops-core) — /dashboard/ops overview: the numbers that
// need attention plus a card per operations app.

import Link from "next/link";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { getOpsOverview, type OpsOverview } from "@/lib/ops/overview";
import { OPS_SECTIONS } from "@/lib/ops/sections";
import { requireOpsViewer } from "@/lib/ops/page-guard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Operations — ShapesOS",
  description: "Orders, invoices, inventory, purchasing, projects, helpdesk and team in one place.",
};

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

export default async function OpsOverviewPage() {
  const { workspaceId } = await requireOpsViewer();
  let o: OpsOverview | null = null;
  try {
    o = await withWorkspaceScope(workspaceId, (tx) => getOpsOverview(tx, workspaceId));
  } catch {
    o = null;
  }

  const kpis: Array<{ label: string; value: string; href: string }> = o
    ? [
        { label: "Open orders", value: String(o.openOrders), href: "/dashboard/ops/orders" },
        { label: "Open invoices", value: String(o.openInvoices), href: "/dashboard/ops/invoices" },
        { label: "Overdue invoices", value: String(o.overdueInvoices), href: "/dashboard/ops/invoices" },
        { label: "Low-stock products", value: String(o.lowStockCount), href: "/dashboard/ops/inventory" },
        { label: "Active projects", value: String(o.activeProjects), href: "/dashboard/ops/projects" },
        { label: "Open tasks", value: String(o.openTasks), href: "/dashboard/ops/projects?view=tasks" },
        { label: "Open tickets", value: String(o.openTickets), href: "/dashboard/ops/helpdesk" },
        { label: "Tickets past SLA", value: String(o.breachedTickets), href: "/dashboard/ops/helpdesk" },
        { label: "Payments, last 30 days", value: money(o.paymentsLast30dCents), href: "/dashboard/ops/payments" },
        { label: "Waiting for your approval", value: String(o.pendingOpsApprovals), href: "/dashboard/approvals" },
      ]
    : [];

  return (
    <div className="flex flex-col gap-6">
      {o ? (
        <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
          {kpis.map((k) => (
            <Link
              key={k.label}
              href={k.href}
              className="rounded-lg bg-paper px-4 py-3 shadow-hairline hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)]"
            >
              <p className="text-[0.75rem] font-semibold text-muted">{k.label}</p>
              <p className="mt-1 text-[1.375rem] font-bold tabular-nums text-ink">{k.value}</p>
            </Link>
          ))}
        </section>
      ) : (
        <p className="rounded-lg border border-line bg-paper px-4 py-3 text-[0.8125rem] text-muted">
          Operations numbers are unavailable right now. The apps below still work.
        </p>
      )}
      <section aria-label="Operations apps" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {OPS_SECTIONS.filter((s) => s.slug).map((s) => (
          <Link
            key={s.slug}
            href={s.href}
            className="rounded-lg bg-paper px-4 py-3.5 shadow-hairline hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)]"
          >
            <p className="text-[0.875rem] font-bold text-ink">{s.label}</p>
            <p className="mt-0.5 text-[0.8125rem] text-muted">{s.description}</p>
          </Link>
        ))}
      </section>
    </div>
  );
}
