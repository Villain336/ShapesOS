// Marketr CRM — purchase order detail slide-over (Phase 17 slice 3).
// Lifecycle: draft → approve → send → received / cancelled.
// Send and cancel are gated (Phase 14 approval card inline); receive is a
// free fulfillment write that atomically books restock txns.

"use client";

import { useState } from "react";
import { Ban, Check, Loader2, PackageCheck, Send, X } from "lucide-react";
import { formatMoney } from "./types";
import {
  PO_STATUS_META,
  shortPOId,
  type OpsPurchaseOrder,
  type SupplierRef,
} from "./PurchaseOrdersTab";
import { OpsApprovalCard, decideOpsApproval, type OpsPendingGate } from "./OpsApprovalCard";
import { backdropCls, btnGhost, btnPrimary, chipCls, errorBoxCls, noteBoxCls, slideoverCls, tableCls, tableWrapCls } from "./ui";

interface POLine {
  productId?: string;
  name: string;
  sku?: string;
  qty: number;
  priceCents: number;
}

interface PendingPO extends OpsPendingGate {
  toStatus: "sent" | "cancelled";
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function PODetail({
  po,
  supplier,
  onClose,
  onChanged,
}: {
  po: OpsPurchaseOrder;
  supplier: SupplierRef | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<PendingPO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const meta = PO_STATUS_META[po.status];
  const who = supplier
    ? `${supplier.name}${supplier.company ? ` (${supplier.company})` : ""}`
    : po.supplierName ?? "supplier";
  const subtotal = (po.lineItems as POLine[]).reduce((s, li) => s + li.qty * li.priceCents, 0);

  async function requestTransition(to: "sent" | "received" | "cancelled") {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fetch("/api/ops/purchase-orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: po.id, status: to }),
      });
      const d = await r.json();
      if (r.status === 202 && d.approval_required) {
        setPending({
          approvalId: d.approval.id as string,
          tier: (d.approval.riskTier as string) ?? "medium",
          actionLabel: (d.classification?.label as string) ?? "Gated write",
          summary: `${(d.classification?.label as string) ?? "Gated write"} — purchase order PO-${shortPOId(po.id)} for ${formatMoney(po.totalCents)} from ${who}.`,
          approved: false,
          toStatus: to as "sent" | "cancelled",
        });
      } else if (!r.ok) {
        throw new Error(d.error ?? "Request failed.");
      } else {
        const restocked = (d.row as { restocked?: number } | undefined)?.restocked;
        setNote(
          to === "received" && typeof restocked === "number"
            ? `Done — PO received, ${restocked} restock transaction${restocked === 1 ? "" : "s"} booked.`
            : `Done — purchase order is now ${to}.`,
        );
        onChanged();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approved" | "denied") {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await decideOpsApproval(pending.approvalId, decision);
      if (decision === "denied") {
        setPending(null);
        setNote("Denied — nothing was executed.");
      } else {
        setPending({ ...pending, approved: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!pending || !pending.approved) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/purchase-orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: po.id, status: pending.toStatus, approvalId: pending.approvalId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Execution failed.");
      setPending(null);
      setNote(`Done — purchase order is now ${pending.toStatus}.`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={backdropCls} onClick={onClose} />
      <div className={slideoverCls}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold tracking-tight text-ink">
                  PO-{shortPOId(po.id)}
                </h3>
                <span className={chipCls}>
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 text-[13px] text-muted">
                {who} · {formatMoney(po.totalCents)} · sent {fmtDate(po.sentAt)}
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className={`${errorBoxCls} mb-3`}>
                {error}
              </div>
            )}
            {note && (
              <div className={`${noteBoxCls} mb-3`}>
                {note}
              </div>
            )}

            {pending && (
              <OpsApprovalCard
                pending={pending}
                busy={busy}
                executeLabel={pending.actionLabel}
                onApprove={() => decide("approved")}
                onDeny={() => decide("denied")}
                onExecute={execute}
              />
            )}

            {/* Lifecycle actions */}
            <div className="mb-4 flex flex-wrap gap-2">
              {po.status === "draft" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => requestTransition("sent")}
                  className={btnPrimary}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Send purchase order
                </button>
              )}
              {po.status === "sent" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => requestTransition("received")}
                  className={btnPrimary}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <PackageCheck size={14} />} Mark received
                </button>
              )}
              {(po.status === "draft" || po.status === "sent") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => requestTransition("cancelled")}
                  className={btnGhost}
                >
                  <Ban size={14} /> Cancel
                </button>
              )}
            </div>

            {/* Line items */}
            <h4 className="mb-2 text-[13px] font-bold text-ink">Line items</h4>
            <div className={tableWrapCls}>
              <table className={`${tableCls}`}>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Unit</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(po.lineItems as POLine[]).map((li, i) => (
                    <tr key={i}>
                      <td>
                        <span className="font-medium text-ink">{li.name}</span>
                        {li.sku && <span className="text-subtle"> · {li.sku}</span>}
                        {li.productId && (
                          <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-canvas px-1.5 py-0.5 text-[10px] font-semibold text-ink">
                            <Check size={10} /> restocks on receive
                          </span>
                        )}
                      </td>
                      <td className="text-right tabular-nums">{li.qty}</td>
                      <td className="text-right tabular-nums">{formatMoney(li.priceCents)}</td>
                      <td className="text-right font-semibold tabular-nums">{formatMoney(li.qty * li.priceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 space-y-0.5 text-right text-[13px] text-muted">
              <p>Subtotal <span className="font-semibold text-ink tabular-nums">{formatMoney(subtotal)}</span></p>
              <p>Tax <span className="font-semibold text-ink tabular-nums">{formatMoney(po.taxCents)}</span></p>
              <p className="text-[15px]">Total <span className="font-bold text-ink tabular-nums">{formatMoney(po.totalCents)}</span></p>
            </div>
            <p className="mt-3 text-[12px] text-muted">
              Receiving books a restock inventory transaction for every line linked to a catalog
              product — atomically, in the same transaction as the status change.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
