// ShapesOS Phase 10 (ops-core) — Payments view (/dashboard/ops/payments).
// OpsPayment is a RECORDS-ONLY, append-only ledger: every write (charge or
// refund) is a gated money record (OPS_PAYMENT_RECORD_CHARGE /
// OPS_PAYMENT_REFUND) — corrections are new records, never edits.

"use client";

import { useCallback, useMemo, useState } from "react";
import { CreditCard, Loader2, Plus } from "lucide-react";
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
} from "@/components/crm/ui";
import { EmptyBlock, LoadingLine, OpsModal, ViewHeader, fmtCents, fmtDateTime, sentence, shortId, toCents, useGatedWrite, useOpsList } from "./shared";
import type { OpsOrderRow } from "./OrdersView";

interface PaymentRow {
  id: string;
  orderId: string | null;
  provider: string;
  kind: "charge" | "refund";
  amountCents: number;
  status: string;
  providerRef: string | null;
  createdAt: string;
}

export function PaymentsView() {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [showNew, setShowNew] = useState(false);
  const { rows, loading, error, reload } = useOpsList<PaymentRow>("payments", {
    kind: kind || undefined,
    status: status || undefined,
  });
  const net = useMemo(
    () => rows.filter((p) => p.status === "succeeded").reduce((s, p) => s + (p.kind === "refund" ? -p.amountCents : p.amountCents), 0),
    [rows],
  );

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader
        title="Payments"
        hint="A record of charges and refunds made on your payment provider. Every record needs your approval; corrections are new records, never edits."
      >
        <span>
          Net succeeded <span className="font-bold tabular-nums text-ink">{fmtCents(net)}</span>
        </span>
      </ViewHeader>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">Charges and refunds</option>
          <option value="charge">Charges</option>
          <option value="refund">Refunds</option>
        </select>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {["pending", "succeeded", "failed", "refunded"].map((s) => (
            <option key={s} value={s}>
              {sentence(s)}
            </option>
          ))}
        </select>
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <Plus size={15} /> Record payment
        </button>
      </div>
      {error && <div className={errorBoxCls}>{error}</div>}
      {loading ? (
        <LoadingLine label="Loading payments…" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={CreditCard} title="No payments recorded" hint="Record a charge or refund that happened on your payment provider." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr>
                <th className={thCls}>Payment</th>
                <th className={thCls}>Kind</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Order</th>
                <th className={thCls}>Provider ref</th>
                <th className={`${thCls} text-right`}>Amount</th>
                <th className={thCls}>Recorded</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className={`${tdCls} font-semibold`}>PAY-{shortId(p.id)}</td>
                  <td className={tdCls}>{sentence(p.kind)}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{sentence(p.status)}</span>
                  </td>
                  <td className={`${tdCls} text-muted`}>{p.orderId ? `SO-${shortId(p.orderId)}` : "—"}</td>
                  <td className={`${tdCls} font-mono text-[0.75rem] text-muted`}>
                    {p.provider}
                    {p.providerRef ? ` · ${p.providerRef}` : ""}
                  </td>
                  <td className={`${tdCls} text-right font-semibold tabular-nums`}>
                    {p.kind === "refund" ? "−" : ""}
                    {fmtCents(p.amountCents)}
                  </td>
                  <td className={`${tdCls} text-muted`}>{fmtDateTime(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showNew && <RecordPaymentModal onClose={() => setShowNew(false)} onRecorded={reload} />}
    </div>
  );
}

function RecordPaymentModal({ onClose, onRecorded }: { onClose: () => void; onRecorded: () => void }) {
  const [kind, setKind] = useState<"charge" | "refund">("charge");
  const [amount, setAmount] = useState("");
  const [orderId, setOrderId] = useState("");
  const [providerRef, setProviderRef] = useState("");
  const [status, setStatus] = useState<"succeeded" | "pending" | "failed">("succeeded");
  const { rows: orders } = useOpsList<OpsOrderRow>("orders");
  const done = useCallback(() => onRecorded(), [onRecorded]);
  const gate = useGatedWrite("payments", "POST", done);
  const cents = toCents(amount);

  return (
    <OpsModal title="Record payment" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {gate.error && <div className={errorBoxCls}>{gate.error}</div>}
        {gate.note && <div className={noteBoxCls}>{gate.note} The payment is recorded.</div>}
        {gate.pending && (
          <OpsApprovalCard
            pending={gate.pending}
            busy={gate.busy}
            executeLabel="Record payment"
            onApprove={() => gate.decide("approved")}
            onDeny={() => gate.decide("denied")}
            onExecute={gate.execute}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Kind</span>
            <select className={`${selectCls} w-full`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={!!gate.pending}>
              <option value="charge">Charge</option>
              <option value="refund">Refund</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Amount ($)</span>
            <input className={`${inputCls} w-full`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" disabled={!!gate.pending} />
          </label>
          <label className="block">
            <span className={labelCls}>Status on provider</span>
            <select className={`${selectCls} w-full`} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} disabled={!!gate.pending}>
              <option value="succeeded">Succeeded</option>
              <option value="pending">Pending</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Order (optional)</span>
            <select className={`${selectCls} w-full`} value={orderId} onChange={(e) => setOrderId(e.target.value)} disabled={!!gate.pending}>
              <option value="">No order</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  SO-{shortId(o.id)} · {fmtCents(o.totalCents)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block">
          <span className={labelCls}>Provider reference (optional)</span>
          <input className={`${inputCls} w-full font-mono`} value={providerRef} onChange={(e) => setProviderRef(e.target.value)} placeholder="pi_… or ch_…" disabled={!!gate.pending} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Close
          </button>
          {!gate.pending && !gate.note && (
            <button
              type="button"
              className={btnPrimary}
              disabled={gate.busy || cents === null || cents <= 0}
              onClick={() =>
                gate.request(
                  {
                    kind,
                    amountCents: cents,
                    status,
                    ...(orderId ? { orderId } : {}),
                    ...(providerRef.trim() ? { providerRef: providerRef.trim() } : {}),
                  },
                  `${kind} of ${fmtCents(cents ?? 0)}.`,
                )
              }
            >
              {gate.busy && <Loader2 size={14} className="animate-spin" />} Propose record
            </button>
          )}
        </div>
      </div>
    </OpsModal>
  );
}
