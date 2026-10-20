// Marketr CRM — invoice detail slide-over (Phase 17 slice 2).
// Full lifecycle: draft → approve → send → paid / overdue, with the
// Phase 14 approval card inline for every gated write.

"use client";

import { useState } from "react";
import {
  X, Send, BadgeDollarSign, BellRing, Ban, Loader2, Check, ExternalLink,
} from "lucide-react";
import { formatMoney } from "./types";
import {
  INVOICE_STATUS_META,
  type OpsInvoice,
  type CustomerRef,
} from "./InvoicesTab";
// Phase 10 (finance): number, PDF, delivery, partial payments, credit notes,
// payment link and recurring schedules.
import { InvoiceFinancePanel, invoiceLabel } from "@/components/ops-finance/InvoiceFinancePanel";
import { ShareMenu } from "@/components/share/ShareMenu";
import { backdropCls, btnApprove, btnDeny, btnExecute, btnGhost, btnPrimary, btnReview, chipCls, errorBoxCls, inputCls, needsBoxCls, noteBoxCls, sectionTitleCls, slideoverCls, tableCls } from "./ui";

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
    `${label} — invoice ${invoiceLabel(invoice)} for ${formatMoney(invoice.totalCents)} to ${who} (due ${fmtDate(invoice.dueAt)})`;

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
          summary: `Send payment reminder to ${who} for invoice ${invoiceLabel(invoice)} — ${formatMoney(invoice.totalCents)} due ${fmtDate(invoice.dueAt)}.`,
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
        setNote("Reminder approved and emailed.");
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
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={slideoverCls}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold tracking-tight text-ink">
                  {invoiceLabel(invoice)}
                </h3>
                <span className={chipCls}>
                  {meta.label}
                </span>
              </div>
              <p className="mt-0.5 text-[0.8125rem] text-muted">
                {who} · {formatMoney(invoice.totalCents)} · due {fmtDate(invoice.dueAt)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* Phase 18.3 (WS=flow): the share sheet (Send to… / Open with). */}
              <ShareMenu record={{ kind: "invoice", id: invoice.id, title: invoiceLabel(invoice), href: `/dashboard/ops/invoices?invoice=${encodeURIComponent(invoice.id)}` }} role="editor" />
              <button type="button" onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
                <X size={18} />
              </button>
            </div>
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

            {/* Approval card for the gated write */}
            {pending && (
              <div className={`${needsBoxCls} mb-4`}>
                <div className="flex items-center gap-2 text-[0.8125rem] font-bold text-ink">
                  <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Needs review" /> Approval needed — {pending.actionLabel}
                </div>
                <p className="mt-1 text-[0.8125rem] text-ink">{pending.summary}</p>
                <p className="mt-1 text-[0.75rem] text-ink">
                  Risk tier: {pending.tier}. Nothing executes until you approve — approve here or in the Actions queue.
                </p>
                {!pending.approved ? (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("approved")}
                      className={btnApprove}
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => decide("denied")}
                      className={btnDeny}
                    >
                      Deny
                    </button>
                    <a
                      href="/dashboard/actions"
                      className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-ink hover:underline"
                    >
                      Open Actions queue <ExternalLink size={12} />
                    </a>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-[0.8125rem] font-semibold text-ink">
                      <Check size={14} /> Approved — ready to execute
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={execute}
                      className={btnExecute}
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                      {pending.kind === "reminder" ? "Send reminder now" : "Execute now"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Line items */}
            <h4 className={sectionTitleCls}>Line items</h4>
            <div className="mt-1 overflow-hidden rounded-md border border-line">
              <table className={`${tableCls}`}>
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
            <div className="mt-2 space-y-1 text-[0.8125rem]">
              <div className="flex justify-between text-muted">
                <span>Subtotal</span>
                <span className="tabular-nums">{formatMoney(subtotal)}</span>
              </div>
              <div className="flex justify-between text-muted">
                <span>Tax</span>
                <span className="tabular-nums">{formatMoney(invoice.taxCents)}</span>
              </div>
              <div className="flex justify-between border-t border-line pt-1 text-[0.9375rem] font-bold text-ink">
                <span>Total</span>
                <span className="tabular-nums">{formatMoney(invoice.totalCents)}</span>
              </div>
              <p className="text-[0.75rem] text-subtle">Totals are computed on the server from line items.</p>
            </div>

            {/* Dates */}
            <h4 className={`${sectionTitleCls} mt-5!`}>Dates</h4>
            <dl className="mt-1 grid grid-cols-3 gap-2 text-[0.8125rem]">
              <div className="rounded-md bg-canvas px-3 py-2">
                <dt className="text-[0.6875rem] text-subtle">Created</dt>
                <dd className="font-medium text-ink">{fmtDate(invoice.createdAt)}</dd>
              </div>
              <div className="rounded-md bg-canvas px-3 py-2">
                <dt className="text-[0.6875rem] text-subtle">Sent</dt>
                <dd className="font-medium text-ink">{fmtDate(invoice.sentAt)}</dd>
              </div>
              <div className="rounded-md bg-canvas px-3 py-2">
                <dt className="text-[0.6875rem] text-subtle">Due</dt>
                <dd className="font-medium text-ink">
                  {fmtDate(invoice.dueAt)}
                </dd>
              </div>
            </dl>

            <InvoiceFinancePanel invoice={invoice} onChanged={onChanged} />

            {/* Reminder composer */}
            {showRemind && (
              <div className="mt-4 rounded-md border border-line bg-canvas px-3 py-3">
                <h4 className="text-[0.8125rem] font-semibold text-ink">Payment reminder</h4>
                <p className="mt-0.5 text-[0.75rem] text-muted">
                  Draft the reminder — it goes through approval before anything is sent.
                </p>
                <textarea
                  className={`${inputCls} mt-2 min-h-[90px] w-full`}
                  value={reminderText}
                  onChange={(e) => setReminderText(e.target.value)}
                  placeholder={`Hi ${customer?.name ?? "there"} — just a friendly reminder that invoice ${invoiceLabel(invoice)} for ${formatMoney(invoice.totalCents)} was due ${fmtDate(invoice.dueAt)}. Let us know if you need anything!`}
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={requestReminder}
                    className={btnReview}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <BellRing size={14} />}
                    Request approval
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowRemind(false)}
                    className={btnGhost}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Lifecycle actions */}
          <div className="border-t border-line px-5 py-3">
            <div className="flex flex-wrap gap-2">
              {invoice.status === "draft" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => requestTransition("sent")}
                  className={btnPrimary}
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
                    className={btnPrimary}
                  >
                    <BadgeDollarSign size={14} /> Mark paid in full
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReminderText(
                        `Hi ${customer?.name ?? "there"} — just a friendly reminder that invoice ${invoiceLabel(invoice)} for ${formatMoney(invoice.totalCents)} was due ${fmtDate(invoice.dueAt)}. Let us know if you need anything!`,
                      );
                      setShowRemind(true);
                    }}
                    className={btnGhost}
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
                  className={btnDeny}
                >
                  <Ban size={14} /> Void
                </button>
              )}
              {invoice.status === "paid" && (
                <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink">
                  <Check size={14} /> Paid in full — nothing left to do.
                </span>
              )}
              {invoice.status === "cancelled" && (
                <span className="text-[0.8125rem] text-subtle">This invoice was voided.</span>
              )}
            </div>
            <p className="mt-2 text-[0.75rem] text-subtle">
              Sending (emailed with the PDF), payments, credit notes, voiding and reminders all need your approval first.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
