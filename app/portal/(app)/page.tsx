// ShapesOS — Phase 10 (portal): /portal overview — what needs the client's
// attention, per section their access includes.

import Link from "next/link";
import { portalPage } from "@/lib/portal/page";
import { portalSees } from "@/lib/portal/core";
import { portalOverview } from "@/lib/portal/data";
import { fmtMoney } from "@/lib/ops/finance/money";
import { cardCls, noteCls, pageHintCls, pageTitleCls } from "@/components/portal/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Client portal — ShapesOS" };

export default async function PortalHome() {
  const p = await portalPage();
  const o = await portalOverview(p);
  const tiles: Array<{ href: string; label: string; value: string; hint: string }> = [];
  if (portalSees(p.role, "invoices")) {
    tiles.push({ href: "/portal/invoices", label: "Balance due", value: fmtMoney(o.balanceDueCents, o.currency), hint: `${o.openInvoiceCount} open invoice${o.openInvoiceCount === 1 ? "" : "s"}` });
  }
  if (portalSees(p.role, "quotes")) tiles.push({ href: "/portal/quotes", label: "Quotes to decide", value: String(o.quotesWaiting), hint: "Waiting for your answer" });
  tiles.push({ href: "/portal/projects", label: "Active projects", value: String(o.activeProjects), hint: "Planning, active or on hold" });
  tiles.push({ href: "/portal/tickets", label: "Open tickets", value: String(o.openTickets), hint: "Not solved yet" });
  return (
    <>
      <div>
        <h1 className={pageTitleCls}>Welcome, {p.clientName}</h1>
        <p className={pageHintCls}>Everything {p.workspaceName} shares with you, in one place.</p>
      </div>
      {!o.linked && <div className={noteCls}>Nothing is shared with you yet. When your account team links your records, they show up here.</div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className={`${cardCls} flex flex-col gap-1 hover:bg-hover-paper`}>
            <span className="text-xs font-semibold text-muted">{t.label}</span>
            <span className="aos-heading tabular-nums">{t.value}</span>
            <span className="text-sm text-muted">{t.hint}</span>
          </Link>
        ))}
      </div>
    </>
  );
}
