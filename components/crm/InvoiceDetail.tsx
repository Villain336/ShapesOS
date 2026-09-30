// Marketr CRM — invoice detail slide-over (Phase 17 slice 2).
// Full lifecycle: draft → approve → send → paid / overdue, with the
// Phase 14 approval card inline for every gated write.

"use client";

import { useState } from "react";
import {
  X, Send, BadgeDollarSign, BellRing, Ban, Loader2, Check, ShieldAlert, ExternalLink,
} from "lucide-react";
import { formatMoney } from "./types";
import {
  INVOICE_STATUS_META,
  shortInvoiceId,
  type OpsInvoice,
  type CustomerRef,
} from "./InvoicesTab";

interface PendingGate {
  approvalId: string;
  tier: string;
  actionLabel: string;
  summary: string;
  kind: "transition" | "reminder";
  toStatus?: string;
  reminderText?: string;
  approved: boolean;
}

function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function InvoiceDetail({
  invoice,
  customer,
  onClose,
  onChanged,
}: {
  invoice: OpsInvoice;
  customer: CustomerRef | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<PendingGate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showRemind, setShowRemind] = useState(false);
  const [reminderText, setReminderText] = useState("");

  const meta = INVOICE_STATUS_META[invoice.status];
  const who = customer
    ? `${customer.name}${customer.company ? ` (${customer.company})` : ""}`
    : "customer";
  const summaryFor = (label: string) =>
    `${label} — invoice INV-${shortInvoiceId(invoice.id)} for ${formatMoney(invoice.totalCents)} to ${who} (due ${fmtDate(invoice.dueAt)})`;

  async function requestTransition(to: "sent" | "paid" | "cancelled") {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fetch("/api/ops/invoices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: invoice.id, status: to }),
      });
      const d = await r.json();
      if (r.status === 202 && d.approval_required) {
        setPending({
          approvalId: d.approval.id as string,
          tier: (d.approval.riskTier as string) ?? "medium",
          actionLabel: (d.classification?.label as string) ?? "Gated write",
          summary: summaryFor((d.classification?.label as string) ?? "Gated write"),
          kind: "transition",
          toStatus: to,
          approved: false,
        });
      } else if (!r.ok) {
        throw new Error(d.error ?? "Request failed.");
      } else {
        setNote(`Done — invoice is now ${to}.`);
        onChanged();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestReminder() {
    const text = reminderText.trim();
    if (!text) {
      setError("Write the reminder text first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await fetch(`/api/ops/invoices/${invoice.id}/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await r.json();
      if (r.status === 202 && d.approval_required) {
        setPending({
          approvalId: d.approval.id as string,
          tier: (d.approval.riskTier as string) ?? "medium",
          actionLabel: "Send payment reminder",
          summary: `Send payment reminder to ${who} for invoice INV-${shortInvoiceId(invoice.id)} — ${formatMoney(invoice.totalCents)} due ${fmtDate(invoice.dueAt)}.`,
          kind: "reminder",
          reminderText: text,
          approved: false,
        });
        setShowRemind(false);
      } else if (!r.ok) {
        throw new Error(d.error ?? "Request failed.");
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
      const r = await fetch(`/api/integrations/actions/approvals/${pending.approvalId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Decision failed.");
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
      if (pending.kind === "transition" && pending.toStatus) {
        const r = await fetch("/api/ops/invoices", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: invoice.id, status: pending.toStatus, approvalId: pending.approvalId }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Execution failed.");
        setPending(null);
        setNote(`Done — invoice is now ${pending.toStatus}.`);
        onChanged();
      } else if (pending.kind === "reminder" && pending.reminderText) {
        const r = await fetch(`/api/ops/invoices/${invoice.id}/remind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pending.reminderText, approvalId: pending.approvalId }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Execution failed.");
        setPending(null);
        setNote("Reminder recorded as sent.");
        onChanged();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed.");
    } finally {
      setBusy(false);
    }
  }

  const subtotal = invoice.lineItems.reduce((s, li) => s + li.qty * li.priceCents, 0);

  return (
    <>
      <div className="crm-backdrop" onClick={onClose} />
      <div className="crm-slideover">
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-stone-200 px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold tracking-tight text-stone-900">
                  INV-{shortInvoiceId(invoice.id)}
                </h3>
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.tint}`}>
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 text-[13px] text-stone-500">
                {who} · {formatMoney(invoice.totalCents)} · due {fmtDate(invoice.dueAt)}
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                {error}
              </div>
            )}
            {note && (
              <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[13px] text-green-800">
                {note}
              </div>
            )}

            {/* Approval card for the gated write */}
            {pending && (
              <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
                <div className="flex items-center gap-2 text-[13px] font-bold text-amber-900">
                  <ShieldAlert size={16} /> Approval needed — {pending.actionLabel}
                </div>
                <p className="mt-1 text-[13px] text-amber-900">{pending.summary}</p>
                <p className="mt-1 text-[12px] text-amber-700">
                  Risk tier: {pending.tier}. Nothing executes until you approve — approve here or in the Actions queue.
                </p>
                {!pending.approved ? (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("approved")}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("denied")}
                      className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                    >
                      Deny
                    </button>
                    <a
                      href="/dashboard/actions"
                      className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-700)] hover:underline"
                    >
                      Open Actions queue <ExternalLink size={12} />
                    </a>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-green-700">
                      <Check size={14} /> Approved — ready to execute
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={execute}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                      {pending.kind === "reminder" ? "Send reminder now" : "Execute now"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Line items */}
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">Line items</h4>
            <div className="mt-1 overflow-hidden rounded-lg border border-stone-200">
              <table className="crm-table w-full">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lineItems.map((li, i) => (
                    <tr key={i} className="!cursor-default">
                      <td>{li.description}</td>
                      <td className="text-right tabular-nums">{li.qty}</td>
                      <td className="text-right tabular-nums">{formatMoney(li.priceCents)}</td>
                      <td className="text-right font-semibold tabular-nums">{formatMoney(li.qty * li.priceCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 space-y-1 text-[13px]">
              <div className="flex justify-between text-stone-500">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatMoney(subtotal)}</span>
              </div>
              <div className="flex justify-between text-stone-500">
                <span>Tax</span>
                <span className="tabular-nums">{formatMoney(invoice.taxCents)}</span>
              </div>
              <div className="flex justify-between border-t border-stone-200 pt-1 text-[15px] font-bold text-stone-900">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(invoice.totalCents)}</span>
              </div>
              <p className="text-[12px] text-stone-400">Totals are computed on the server from line items.</p>
            </div>

            {/* Dates */}
            <h4 className="mt-5 text-[11px] font-semibold uppercase tracking-wider text-stone-400">Dates</h4>
            <dl className="mt-1 grid grid-cols-3 gap-2 text-[13px]">
              <div className="rounded-lg bg-stone-50 px-3 py-2">
                <dt className="text-[11px] text-stone-400">Created</dt>
                <dd className="font-medium text-stone-800">{fmtDate(invoice.createdAt)}</dd>
              </div>
              <div className="rounded-lg bg-stone-50 px-3 py-2">
                <dt className="text-[11px] text-stone-400">Sent</dt>
                <dd className="font-medium text-stone-800">{fmtDate(invoice.sentAt)}</dd>
              </div>
              <div className="rounded-lg bg-stone-50 px-3 py-2">
                <dt className="text-[11px] text-stone-400">Due</dt>
                <dd className={`font-medium ${invoice.status === "overdue" ? "text-red-700" : "text-stone-800"}`}>
                  {fmtDate(invoice.dueAt)}
                </dd>
              </div>
            </dl>

            {/* Reminder composer */}
            {showRemind && (
              <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-3">
                <h4 className="text-[13px] font-semibold text-stone-800">Payment reminder</h4>
                <p className="mt-0.5 text-[12px] text-stone-500">
                  Draft the reminder — it goes through approval before anything is sent.
                </p>
                <textarea
                  className="crm-input mt-2 min-h-[90px] w-full"
                  value={reminderText}
                  onChange={(e) => setReminderText(e.target.value)}
                  placeholder={`Hi ${customer?.name ?? "there"} — just a friendly reminder that invoice INV-${shortInvoiceId(invoice.id)} for ${formatMoney(invoice.totalCents)} was due ${fmtDate(invoice.dueAt)}. Let us know if you need anything!`}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={requestReminder}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <BellRing size={14} />}
                    Request approval
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRemind(false)}
                    className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-semibold text-stone-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Lifecycle actions */}
          <div className="border-t border-stone-200 px-5 py-3">
            <div className="flex flex-wrap gap-2">
              {invoice.status === "draft" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => requestTransition("sent")}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                >
                  <Send size={14} /> Send invoice
                </button>
              )}
              {(invoice.status === "sent" || invoice.status === "overdue") && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => requestTransition("paid")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-3 py-2 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                  >
                    <BadgeDollarSign size={14} /> Record payment
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReminderText(
                        `Hi ${customer?.name ?? "there"} — just a friendly reminder that invoice INV-${shortInvoiceId(invoice.id)} for ${formatMoney(invoice.totalCents)} was due ${fmtDate(invoice.dueAt)}. Let us know if you need anything!`,
                      );
                      setShowRemind(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-[13px] font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                  >
                    <BellRing size={14} /> Send reminder
                  </button>
                </>
              )}
              {(invoice.status === "draft" || invoice.status === "sent" || invoice.status === "overdue") && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => requestTransition("cancelled")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-[13px] font-semibold text-stone-500 hover:bg-stone-50 disabled:opacity-50"
                >
                  <Ban size={14} /> Void
                </button>
              )}
              {invoice.status === "paid" && (
                <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-green-700">
                  <Check size={14} /> Paid in full — nothing left to do.
                </span>
              )}
              {invoice.status === "cancelled" && (
                <span className="text-[13px] text-stone-400">This invoice was voided.</span>
              )}
            </div>
            <p className="mt-2 text-[12px] text-stone-400">
              Sending, recording payment, voiding, and reminders all need your approval first.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
