"use client";

// ShapesOS — Phase 10 (finance): the money side of one invoice, shown inside
// the existing InvoiceDetail slide-over — number, PDF, email delivery,
// balance, partial payments (gated), credit notes (gated), the tenant's
// Stripe payment link, and "repeat this invoice" (a recurring schedule).

import { useCallback, useEffect, useState } from "react";
import { Download, Link2, Repeat, Undo2, Wallet } from "lucide-react";
import { aosButton } from "@/components/aos";
import { ErrorLine, Note, denseInputCls, fmtDay, labelCls, money, parseMoneyInput } from "./kit";
import { jsonPost, useGated } from "./useGated";

export interface InvoiceMoneyFields {
  id: string;
  status: string;
  kind?: string;
  number?: string | null;
  customerId: string | null;
  lineItems: Array<{ description: string; qty: number; priceCents: number; taxRateId?: string }>;
  taxCents: number;
  totalCents: number;
  paidCents?: number;
  creditedCents?: number;
  deliveryStatus?: string | null;
  paymentLinkUrl?: string | null;
}

interface Account {
  payments: Array<{ id: string; amountCents: number; provider: string; createdAt: string; note: string | null }>;
  creditNotes: Array<{ id: string; number: string | null; totalCents: number; createdAt: string }>;
  balanceDueCents: number;
}

const DELIVERY: Record<string, string> = {
  sent: "Emailed with the PDF attached.",
  fake: "Development mode: the email was logged, not sent.",
  not_configured: "Email isn't set up on this server. Download the PDF and send it yourself.",
  no_recipient: "No email on file for this customer. Add one, then send a reminder.",
  failed: "The email didn't go out. Download the PDF and send it yourself.",
};

export function invoiceLabel(inv: { id: string; number?: string | null; kind?: string }): string {
  if (inv.number) return inv.number;
  return `${inv.kind === "credit_note" ? "Credit note" : "Draft invoice"} ${inv.id.slice(-6).toUpperCase()}`;
}

export function InvoiceFinancePanel({ invoice, onChanged }: { invoice: InvoiceMoneyFields; onChanged: () => void }) {
  const gated = useGated();
  const [acct, setAcct] = useState<Account | null>(null);
  const [mode, setMode] = useState<"none" | "pay" | "credit" | "repeat">("none");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [cadence, setCadence] = useState("monthly");
  const [link, setLink] = useState<string | null>(invoice.paymentLinkUrl ?? null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const open = invoice.status === "sent" || invoice.status === "overdue";
  const label = invoiceLabel(invoice);

  const load = useCallback(async () => {
    const r = await fetch(`/api/ops/invoices/${invoice.id}/payments`);
    if (r.ok) setAcct((await r.json()) as Account);
  }, [invoice.id]);
  useEffect(() => {
    void load();
  }, [load, invoice.status]);

  const refresh = () => {
    setMode("none");
    setAmount("");
    setReason("");
    void load();
    onChanged();
  };

  function recordPayment() {
    const cents = parseMoneyInput(amount);
    if (Number.isNaN(cents) || cents <= 0) return gated.setError("Enter the amount received.");
    void gated.start({
      label: "Record payment",
      summary: `Record a ${money(cents)} payment on ${label}.`,
      executeLabel: "Record payment",
      send: (approvalId) => jsonPost(`/api/ops/invoices/${invoice.id}/payments`, { amountCents: cents, ...(approvalId ? { approvalId } : {}) }),
      onDone: () => {
        gated.setNote("Payment recorded and posted.");
        refresh();
      },
    });
  }

  function issueCredit() {
    const cents = parseMoneyInput(amount);
    if (Number.isNaN(cents) || cents <= 0 || !reason.trim()) return gated.setError("Enter the amount to credit and why.");
    void gated.start({
      label: "Issue credit note",
      summary: `Credit ${money(cents)} on ${label}: ${reason.trim()}`,
      executeLabel: "Issue credit note",
      send: (approvalId) => jsonPost(`/api/ops/invoices/${invoice.id}/credit-notes`, { amountCents: cents, reason: reason.trim(), ...(approvalId ? { approvalId } : {}) }),
      onDone: () => {
        gated.setNote("Credit note issued.");
        refresh();
      },
    });
  }

  async function makeLink() {
    setLinkError(null);
    const r = await jsonPost(`/api/ops/invoices/${invoice.id}/payment-link`, {});
    const d = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!r.ok) return setLinkError(d.error ?? "Couldn't create the link.");
    setLink(d.url ?? null);
  }

  async function repeat() {
    gated.setError(null);
    const r = await jsonPost("/api/ops/recurring-invoices", {
      ...(invoice.customerId ? { customerId: invoice.customerId } : {}),
      lineItems: invoice.lineItems.map((l) => ({ description: l.description, qty: l.qty, priceCents: l.priceCents, ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}) })),
      taxCents: invoice.lineItems.some((l) => l.taxRateId) ? 0 : invoice.taxCents,
      cadence,
      startAt: nextStart(cadence),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) return gated.setError(d.error ?? "Couldn't set up the schedule.");
    setMode("none");
    gated.setNote(`Repeats ${cadence}. A draft is created each time; sending still asks.`);
  }

  if (invoice.kind === "credit_note") return null;
  const balance = acct?.balanceDueCents ?? invoice.totalCents - (invoice.paidCents ?? 0) - (invoice.creditedCents ?? 0);

  return (
    <section className="mt-5 flex flex-col gap-3" aria-label="Payments">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[0.8125rem] font-bold text-ink">Payments</h4>
        <a href={`/api/ops/invoices/${invoice.id}/pdf`} target="_blank" rel="noreferrer" className={aosButton({ variant: "quiet", size: "xs" })}>
          <Download size={14} aria-hidden /> PDF
        </a>
      </div>
      {invoice.deliveryStatus ? <p className="text-[0.8125rem] text-muted">{DELIVERY[invoice.deliveryStatus] ?? invoice.deliveryStatus}</p> : null}
      <dl className="grid grid-cols-3 gap-2 text-[0.8125rem]">
        <div className="rounded-md bg-canvas px-3 py-2">
          <dt className="text-[0.6875rem] text-subtle">Paid</dt>
          <dd className="font-medium tabular-nums">{money(invoice.paidCents ?? 0)}</dd>
        </div>
        <div className="rounded-md bg-canvas px-3 py-2">
          <dt className="text-[0.6875rem] text-subtle">Credited</dt>
          <dd className="font-medium tabular-nums">{money(invoice.creditedCents ?? 0)}</dd>
        </div>
        <div className="rounded-md bg-canvas px-3 py-2">
          <dt className="text-[0.6875rem] text-subtle">Balance due</dt>
          <dd className="font-semibold tabular-nums">{money(balance)}</dd>
        </div>
      </dl>
      {acct && (acct.payments.length > 0 || acct.creditNotes.length > 0) ? (
        <ul className="flex flex-col gap-1 text-[0.8125rem]">
          {acct.payments.map((p) => (
            <li key={p.id} className="flex justify-between">
              <span>
                {fmtDay(p.createdAt)} · {p.provider === "stripe" ? "Stripe" : p.provider === "manual" ? "Recorded" : p.provider}
                {p.note ? <span className="text-muted"> · {p.note}</span> : null}
              </span>
              <span className="tabular-nums">{money(p.amountCents)}</span>
            </li>
          ))}
          {acct.creditNotes.map((c) => (
            <li key={c.id} className="flex justify-between">
              <span>
                {fmtDay(c.createdAt)} · Credit note {c.number ?? ""}
                <a className="ml-2 font-semibold underline" href={`/api/ops/invoices/${c.id}/pdf`} target="_blank" rel="noreferrer">
                  PDF
                </a>
              </span>
              <span className="tabular-nums">−{money(c.totalCents)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={() => setMode(mode === "pay" ? "none" : "pay")}>
            <Wallet size={14} aria-hidden /> Record a payment
          </button>
          <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={() => setMode(mode === "credit" ? "none" : "credit")}>
            <Undo2 size={14} aria-hidden /> Credit note
          </button>
          <button type="button" className={aosButton({ variant: "secondary", size: "xs" })} onClick={makeLink}>
            <Link2 size={14} aria-hidden /> {link ? "New payment link" : "Payment link"}
          </button>
        </div>
      ) : null}
      {invoice.status !== "draft" ? (
        <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "self-start" })} onClick={() => setMode(mode === "repeat" ? "none" : "repeat")}>
          <Repeat size={14} aria-hidden /> Repeat this invoice
        </button>
      ) : null}

      {mode === "pay" || mode === "credit" ? (
        <div className="flex flex-col gap-2 rounded-md bg-canvas px-3 py-3">
          <label>
            <span className={labelCls}>{mode === "pay" ? "Amount received" : "Amount to credit"}</span>
            <input className={denseInputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={(balance / 100).toFixed(2)} />
          </label>
          {mode === "credit" ? (
            <label>
              <span className={labelCls}>Reason (shown on the credit note)</span>
              <input className={denseInputCls} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Discount for late delivery" />
            </label>
          ) : null}
          <button type="button" disabled={gated.busy || !!gated.pending} className={aosButton({ variant: "primary", size: "xs", className: "self-start" })} onClick={mode === "pay" ? recordPayment : issueCredit}>
            Request approval
          </button>
        </div>
      ) : null}
      {mode === "repeat" ? (
        <div className="flex items-end gap-2 rounded-md bg-canvas px-3 py-3">
          <label className="flex-1">
            <span className={labelCls}>Repeat</span>
            <select className={denseInputCls} value={cadence} onChange={(e) => setCadence(e.target.value)}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </label>
          <button type="button" className={aosButton({ variant: "primary", size: "xs" })} onClick={repeat}>
            Set up
          </button>
        </div>
      ) : null}
      {link ? (
        <p className="text-[0.8125rem]">
          Pay online:{" "}
          <a className="font-semibold break-all underline" href={link} target="_blank" rel="noreferrer">
            {link}
          </a>
        </p>
      ) : null}
      {linkError ? (
        <ErrorLine>
          {linkError}
          {/Connect Stripe/.test(linkError) ? (
            <>
              {" "}
              <a className="underline" href="/dashboard/ops/accounting/settings">
                Connect Stripe
              </a>
            </>
          ) : null}
        </ErrorLine>
      ) : null}
      {gated.card}
      {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
      {gated.note ? <Note>{gated.note}</Note> : null}
    </section>
  );
}

function nextStart(cadence: string): string {
  const d = new Date();
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + (cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12));
  return d.toISOString();
}
