// ShapesOS Phase 10 (ops-core) — Orders view (/dashboard/ops/orders).
// Reads/writes the existing OpsOrder entity through the generic
// /api/ops/orders route. Lifecycle draft → confirmed → fulfilled
// (cancelled terminal); fulfil and cancel are gated (OPS_ORDER_FULFILL /
// OPS_ORDER_CANCEL) and run through the inline approval card.

"use client";

import { useCallback, useMemo, useState } from "react";
import { Ban, CheckCircle2, Loader2, PackageCheck, Plus, Search, ShoppingCart } from "lucide-react";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import {
  btnGhost,
  btnPrimary,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  trClickableCls,
} from "@/components/crm/ui";
import { activateOnKey } from "@/lib/ui/keyboard";
import { LeadPicker, LineItemsEditor, linesSubtotal, linesValid, type EditLine, type PickedLead } from "./LineItemsEditor";
import {
  EmptyBlock,
  LoadingLine,
  OpsModal,
  OpsSlideOver,
  ViewHeader,
  fmtCents,
  fmtDate,
  opsJson,
  sentence,
  shortId,
  toCents,
  useGatedPatch,
  useOpsList,
} from "./shared";

export interface OpsOrderRow {
  id: string;
  customerId: string | null;
  lineItems: Array<{ name: string; sku?: string; qty: number; priceCents: number }>;
  status: "draft" | "confirmed" | "fulfilled" | "cancelled";
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  createdAt: string;
  // Phase 10 (store): web orders come from the storefront checkout.
  source?: string;
  discountCents?: number;
  promotionCode?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  paidAt?: string | null;
}

interface PaymentRow {
  id: string;
  orderId: string | null;
  kind: string;
  amountCents: number;
  status: string;
  createdAt: string;
}

const STATUSES = ["all", "draft", "confirmed", "fulfilled", "cancelled"] as const;

export function OrdersView() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("all");
  // Phase 10 (store): filter by where the order came from.
  const [source, setSource] = useState<"all" | "web" | "manual">("all");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const { rows, loading, error, reload } = useOpsList<OpsOrderRow>("orders", {
    status: status === "all" ? undefined : status,
    source: source === "all" ? undefined : source,
  });

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter((o) => o.id.toLowerCase().includes(n) || o.lineItems.some((l) => l.name.toLowerCase().includes(n)));
  }, [rows, q]);
  const openValue = rows.filter((o) => o.status === "confirmed").reduce((s, o) => s + o.totalCents, 0);
  const selected = selectedId ? rows.find((o) => o.id === selectedId) ?? null : null;

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Orders" hint="Draft → confirmed → fulfilled. Fulfilling or cancelling an order needs your approval.">
        <span>
          Confirmed, not fulfilled <span className="font-bold tabular-nums text-ink">{fmtCents(openValue)}</span>
        </span>
      </ViewHeader>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : sentence(s)}
            </option>
          ))}
        </select>
        <select className={selectCls} value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Filter by source">
          <option value="all">All sources</option>
          <option value="web">Web store</option>
          <option value="manual">Manual</option>
        </select>
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className={`${inputCls} pl-8`} placeholder="Search orders…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <Plus size={15} /> New order
        </button>
      </div>
      {error && <div className={errorBoxCls}>{error}</div>}
      {loading ? (
        <LoadingLine label="Loading orders…" />
      ) : filtered.length === 0 ? (
        <EmptyBlock icon={ShoppingCart} title="No orders yet" hint="Create a draft order, or let the order workflow create one." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr>
                <th className={thCls}>Order</th>
                <th className={thCls}>Items</th>
                <th className={thCls}>Status</th>
                <th className={`${thCls} text-right`}>Total</th>
                <th className={thCls}>Created</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} className={trClickableCls} tabIndex={0} onClick={() => setSelectedId(o.id)} onKeyDown={activateOnKey(() => setSelectedId(o.id))}>
                  <td className={`${tdCls} font-semibold`}>
                    SO-{shortId(o.id)}
                    {o.source === "web" && <span className={`${chipCls} ml-1.5`}>Web</span>}
                  </td>
                  <td className={`${tdCls} text-muted`}>
                    {o.lineItems.length} line{o.lineItems.length === 1 ? "" : "s"} · {o.lineItems[0]?.name ?? ""}
                  </td>
                  <td className={tdCls}>
                    <span className={chipCls}>{sentence(o.status)}</span>
                  </td>
                  <td className={`${tdCls} text-right font-semibold tabular-nums`}>{fmtCents(o.totalCents)}</td>
                  <td className={`${tdCls} text-muted`}>{fmtDate(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <OrderDetail order={selected} onClose={() => setSelectedId(null)} onChanged={reload} />}
      {showNew && <NewOrderModal onClose={() => setShowNew(false)} onCreated={reload} />}
    </div>
  );
}

function OrderDetail({ order, onClose, onChanged }: { order: OpsOrderRow; onClose: () => void; onChanged: () => void }) {
  const done = useCallback(() => onChanged(), [onChanged]);
  const gate = useGatedPatch("orders", done);
  const { rows: payments } = useOpsList<PaymentRow>("payments");
  const mine = payments.filter((p) => p.orderId === order.id);
  const paid = mine
    .filter((p) => p.status === "succeeded")
    .reduce((s, p) => s + (p.kind === "refund" ? -p.amountCents : p.amountCents), 0);
  const summary = `order SO-${shortId(order.id)} for ${fmtCents(order.totalCents)}.`;

  return (
    <OpsSlideOver
      title={
        <>
          SO-{shortId(order.id)} <span className={chipCls}>{sentence(order.status)}</span>
        </>
      }
      meta={`${fmtCents(order.totalCents)} · created ${fmtDate(order.createdAt)}${order.source === "web" ? ` · web store${order.customerEmail ? ` · ${order.customerEmail}` : ""}${order.paidAt ? ` · paid ${fmtDate(order.paidAt)}` : ""}` : ""}`}
      onClose={onClose}
    >
      {gate.error && <div className={`${errorBoxCls} mb-3`}>{gate.error}</div>}
      {gate.note && <div className={`${noteBoxCls} mb-3`}>{gate.note}</div>}
      {gate.pending && (
        <OpsApprovalCard
          pending={gate.pending}
          busy={gate.busy}
          executeLabel={gate.pending.actionLabel}
          onApprove={() => gate.decide("approved")}
          onDeny={() => gate.decide("denied")}
          onExecute={gate.execute}
        />
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {order.status === "draft" && (
          <button type="button" className={btnPrimary} disabled={gate.busy} onClick={() => gate.request({ id: order.id, status: "confirmed" }, summary)}>
            {gate.busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Confirm order
          </button>
        )}
        {order.status === "confirmed" && (
          <button type="button" className={btnPrimary} disabled={gate.busy} onClick={() => gate.request({ id: order.id, status: "fulfilled" }, summary)}>
            <PackageCheck size={14} /> Fulfil order
          </button>
        )}
        {(order.status === "draft" || order.status === "confirmed") && (
          <button type="button" className={btnGhost} disabled={gate.busy} onClick={() => gate.request({ id: order.id, status: "cancelled" }, summary)}>
            <Ban size={14} /> Cancel
          </button>
        )}
      </div>
      <h4 className="mb-2 text-[0.8125rem] font-bold text-ink">Line items</h4>
      <div className={tableWrapCls}>
        <table className={tableCls}>
          <thead>
            <tr>
              <th className={thCls}>Item</th>
              <th className={`${thCls} text-right`}>Qty</th>
              <th className={`${thCls} text-right`}>Unit</th>
              <th className={`${thCls} text-right`}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {order.lineItems.map((l, i) => (
              <tr key={i}>
                <td className={tdCls}>
                  {l.name}
                  {l.sku && <span className="ml-1 font-mono text-[0.75rem] text-muted">{l.sku}</span>}
                </td>
                <td className={`${tdCls} text-right tabular-nums`}>{l.qty}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(l.priceCents)}</td>
                <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(l.qty * l.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 text-[0.8125rem]">
        <dt className="text-muted">Subtotal</dt>
        <dd className="text-right tabular-nums">{fmtCents(order.subtotalCents)}</dd>
        {(order.discountCents ?? 0) > 0 && (
          <>
            <dt className="text-muted">Discount{order.promotionCode ? ` (${order.promotionCode})` : ""}</dt>
            <dd className="text-right tabular-nums">−{fmtCents(order.discountCents ?? 0)}</dd>
          </>
        )}
        <dt className="text-muted">Tax</dt>
        <dd className="text-right tabular-nums">{fmtCents(order.taxCents)}</dd>
        <dt className="font-bold text-ink">Total</dt>
        <dd className="text-right font-bold tabular-nums">{fmtCents(order.totalCents)}</dd>
        <dt className="text-muted">Net payments recorded</dt>
        <dd className="text-right tabular-nums">{fmtCents(paid)}</dd>
      </dl>
      <h4 className="mb-2 mt-5 text-[0.8125rem] font-bold text-ink">Payments</h4>
      {mine.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">No payment records for this order.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-[0.8125rem]">
          {mine.map((p) => (
            <li key={p.id} className="flex justify-between">
              <span>
                {sentence(p.kind)} · <span className={chipCls}>{sentence(p.status)}</span>
              </span>
              <span className="tabular-nums">{fmtCents(p.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}
    </OpsSlideOver>
  );
}

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [customer, setCustomer] = useState<PickedLead | null>(null);
  const [lines, setLines] = useState<EditLine[]>([{ name: "", qty: "1", price: "" }]);
  const [tax, setTax] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taxCents = tax.trim() ? toCents(tax) : 0;

  async function submit() {
    if (!linesValid(lines) || taxCents === null) {
      setError("Each line needs a name, a whole-number quantity, and a valid price.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await opsJson("/api/ops/orders", "POST", {
        ...(customer ? { customerId: customer.id } : {}),
        lineItems: lines.map((l) => ({ name: l.name.trim(), qty: Number(l.qty), priceCents: toCents(l.price)! })),
        taxCents,
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the order.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <OpsModal title="New order" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <LeadPicker value={customer} onChange={setCustomer} />
        <LineItemsEditor lines={lines} onChange={setLines} />
        <label className="block w-40">
          <span className={labelCls}>Tax ($)</span>
          <input className={inputCls} value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" />
        </label>
        <p className="text-[0.8125rem] text-muted">
          Total <span className="font-bold tabular-nums text-ink">{fmtCents(linesSubtotal(lines) + (taxCents ?? 0))}</span>
        </p>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={submit}>
            {saving && <Loader2 size={14} className="animate-spin" />} Create draft order
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
