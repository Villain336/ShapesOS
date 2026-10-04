// ShapesOS — Phase 10 (finance): /dashboard/ops/purchasing — vendors,
// purchase orders waiting for delivery (partial receipts) and vendor bills
// (post to payables, pay through an approval).

import { Building2, Receipt } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listAccounts } from "@/lib/ops/accounting";
import { financePageActor } from "@/lib/ops/finance/page";
import { DataTable, Empty, FinanceHeader, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { BillActions, NewBillButton, NewVendorButton, ReceiveButton } from "@/components/ops-finance/PurchasingClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Vendors and bills — ShapesOS", description: "Vendors, receiving and vendor bills." };

const BILL_STATE: Record<string, string> = { draft: "Draft", open: "Posted", paid: "Paid", cancelled: "Cancelled" };
const PO_STATE: Record<string, string> = { sent: "Sent", partially_received: "Partly received", received: "Received" };

export default async function PurchasingPage() {
  const actor = await financePageActor();
  const data = await withWorkspaceScope(actor.workspaceId, async (tx) => {
    const ws = actor.workspaceId;
    const [vendors, bills, pos, rates, accounts] = await Promise.all([
      tx.opsVendor.findMany({ where: { workspaceId: ws }, orderBy: { name: "asc" }, take: 500 }),
      tx.opsVendorBill.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" }, take: 200, include: { vendor: { select: { name: true } } } }),
      tx.opsPurchaseOrder.findMany({ where: { workspaceId: ws, status: { in: ["sent", "partially_received", "received"] } }, orderBy: { createdAt: "desc" }, take: 100, include: { vendor: { select: { name: true } } } }),
      tx.opsTaxRate.findMany({ where: { workspaceId: ws, active: true }, select: { id: true, name: true, rateBps: true } }),
      listAccounts(tx, ws),
    ]);
    const owed = await tx.opsVendorBill.groupBy({ by: ["vendorId"], where: { workspaceId: ws, status: "open" }, _sum: { totalCents: true, paidCents: true } });
    return { vendors, bills, pos, rates, accounts, owed };
  });
  const expenseAccounts = data.accounts.filter((a) => a.type === "expense" && a.active).map((a) => ({ id: a.id, code: a.code, name: a.name }));
  const owedBy = new Map(data.owed.map((o) => [o.vendorId, (o._sum.totalCents ?? 0) - (o._sum.paidCents ?? 0)]));
  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Vendors and bills"
        description="Who you buy from, what has arrived and what you owe. Posting a bill records the debt; paying it needs an approval."
        actions={actor.canEdit ? <NewBillButton vendors={data.vendors.filter((v) => v.active).map((v) => ({ id: v.id, name: v.name }))} rates={data.rates} accounts={expenseAccounts} /> : null}
      />

      <Panel title="Vendor bills">
        {data.bills.length === 0 ? (
          <Empty icon={<Receipt size={28} aria-hidden />} title="No bills yet">
            Add a bill by hand, or create one from a purchase order once it's sent.
          </Empty>
        ) : (
          <DataTable head={[{ label: "Bill" }, { label: "Vendor" }, { label: "State" }, { label: "Due" }, { label: "Total", align: "right" }, { label: "Open", align: "right" }, { label: "" }]}>
            {data.bills.map((b) => {
              const label = b.number ?? `Draft bill ${b.id.slice(-6).toUpperCase()}`;
              return (
                <tr key={b.id} className={rowCls}>
                  <td className={`${cellCls} font-semibold`}>
                    {label}
                    {b.vendorRef ? <span className="ml-2 text-sm font-normal text-muted">{b.vendorRef}</span> : null}
                  </td>
                  <td className={cellCls}>{b.vendor?.name ?? <span className="text-muted">No vendor</span>}</td>
                  <td className={cellCls}>
                    <Pill>{BILL_STATE[b.status]}</Pill>
                  </td>
                  <td className={`${cellCls} tabular-nums text-muted`}>{fmtDay(b.dueAt)}</td>
                  <td className={numCls}>{money(b.totalCents)}</td>
                  <td className={numCls}>{b.status === "open" ? money(b.totalCents - b.paidCents) : "—"}</td>
                  <td className={`${cellCls} text-right`}>{actor.canEdit && (b.status === "draft" || b.status === "open") ? <BillActions id={b.id} label={label} status={b.status} balanceCents={b.totalCents - b.paidCents} /> : null}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>

      <Panel title="Receiving">
        {data.pos.length === 0 ? (
          <p className="px-5 py-5 text-md text-muted">No sent purchase orders. Send one from Purchase orders and record deliveries here as they arrive.</p>
        ) : (
          <DataTable head={[{ label: "Purchase order" }, { label: "Vendor" }, { label: "State" }, { label: "Received", align: "right" }, { label: "Total", align: "right" }, { label: "" }]}>
            {data.pos.map((po) => {
              const lines = (Array.isArray(po.lineItems) ? po.lineItems : []) as Array<{ name: string; qty: number; receivedQty?: number }>;
              const got = lines.reduce((s, l) => s + (l.receivedQty ?? 0), 0);
              const all = lines.reduce((s, l) => s + l.qty, 0);
              const label = `PO ${po.id.slice(-6).toUpperCase()}`;
              return (
                <tr key={po.id} className={rowCls}>
                  <td className={`${cellCls} font-semibold`}>{label}</td>
                  <td className={cellCls}>{po.vendor?.name ?? po.supplierName ?? <span className="text-muted">No vendor</span>}</td>
                  <td className={cellCls}>
                    <Pill>{PO_STATE[po.status] ?? po.status}</Pill>
                  </td>
                  <td className={numCls}>
                    {got} of {all}
                  </td>
                  <td className={numCls}>{money(po.totalCents)}</td>
                  <td className={`${cellCls} text-right`}>{actor.canEdit ? <ReceiveButton id={po.id} label={label} lines={lines} status={po.status} /> : null}</td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </Panel>

      <Panel title="Vendors" actions={actor.canEdit ? <NewVendorButton accounts={expenseAccounts} /> : null}>
        {data.vendors.length === 0 ? (
          <Empty icon={<Building2 size={28} aria-hidden />} title="No vendors yet">
            Add the companies you buy from. Purchase orders and bills link to them.
          </Empty>
        ) : (
          <DataTable head={[{ label: "Vendor" }, { label: "Contact" }, { label: "Terms" }, { label: "Owed", align: "right" }]} minWidth={560}>
            {data.vendors.map((v) => (
              <tr key={v.id} className={rowCls}>
                <td className={`${cellCls} font-semibold`}>
                  {v.name} {!v.active ? <Pill className="ml-1">Inactive</Pill> : null}
                </td>
                <td className={`${cellCls} text-muted`}>{v.email ?? v.phone ?? "—"}</td>
                <td className={`${cellCls} text-muted`}>{v.paymentTermsDays} days</td>
                <td className={numCls}>{money(owedBy.get(v.id) ?? 0)}</td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
