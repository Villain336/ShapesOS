// Marketr — overage billing section for Settings → Usage (overage invoicing).
// Card-on-file management (Stripe setup-mode Checkout), accrued unbilled
// overage, and the invoice list. Admin-only (server-gated by the page).
// Never displays keys, secrets, or card data — only whether a card is on
// file, amounts, and Stripe-hosted invoice links.

"use client";

import { useState } from "react";
import { Check } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const btnGhost =
  "inline-flex h-control-sm shrink-0 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

export interface OverageInvoice {
  id: string;
  period: string;
  overageCredits: number;
  amountCents: number;
  status: string;
  stripeInvoiceId: string | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  createdAt: string;
}

export interface OverageState {
  configured: boolean;
  hasPaymentMethod: boolean;
  accruedCredits: number;
  accruedCents: number;
  minInvoiceCents: number;
  overageRate: string;
  invoices: OverageInvoice[];
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "failed":
      return "Payment failed";
    case "finalized":
      return "Billed — awaiting payment";
    default:
      return status;
  }
}

export default function OverageBillingSection({
  workspaceId,
  overage,
  onChanged,
}: {
  workspaceId: string;
  overage: OverageState;
  onChanged: () => void;
}) {
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [adding, setAdding] = useState(false);

  const addCard = async () => {
    setAdding(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/billing/payment-method?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? "Failed to start card setup");
      window.location.href = j.url;
    } catch (err) {
      setNotice({ kind: "error", message: err instanceof Error ? err.message : "Failed to start card setup" });
      setAdding(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-medium text-ink">Overage billing</h3>
      <p className="mt-1 text-sm text-muted">
        Auto-overage is billed monthly at <strong>{overage.overageRate}</strong> per credit, with a{" "}
        <strong>{money(overage.minInvoiceCents)} minimum</strong> per invoice. Usage below the minimum
        carries forward to the next month — it is never forgiven, never rounded away. A card on file is
        required to keep auto-overage on.
      </p>
      {notice && (
        <div className="mt-3">
          <Notice notice={notice} />
        </div>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {/* Card on file */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-line p-4">
          <div className="text-sm text-muted">
            <p>
              <strong className="text-ink">Card on file:</strong>{" "}
              {overage.hasPaymentMethod ? (
                <span className="font-medium text-ink">Yes — overage invoices charge automatically.</span>
              ) : (
                <span>
                  None. Add a card to enable auto-overage (or replace the current one).
                </span>
              )}
            </p>
            <p className="mt-1 text-xs text-muted">
              Card details are collected by Stripe — they never touch Marketr.
            </p>
          </div>
          <button className={btnGhost} disabled={adding} onClick={addCard}>
            {adding ? "Redirecting…" : overage.hasPaymentMethod ? "Replace card" : "Add card"}
          </button>
        </div>

        {/* Accrued unbilled overage */}
        <div className="rounded-lg border border-line p-4">
          <p className="text-sm text-muted">
            <strong className="text-ink">Accrued unbilled overage:</strong>{" "}
            {overage.accruedCredits.toLocaleString()} credits ({money(overage.accruedCents)})
            {overage.accruedCents > 0 && overage.accruedCents < overage.minInvoiceCents && (
              <span>
                {" "}— below the {money(overage.minInvoiceCents)} minimum; carries forward.
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-muted">
            Billed on the 1st of each month for completed months only.
          </p>
        </div>

        {/* Invoices */}
        <div>
          <h4 className="text-sm font-medium text-ink">Invoices</h4>
          {overage.invoices.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No overage invoices yet.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-3 font-medium">Period</th>
                  <th className="py-1 pr-3 font-medium">Credits</th>
                  <th className="py-1 pr-3 font-medium">Amount</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {overage.invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-line hover:bg-hover-paper">
                    <td className="py-1.5 pr-3 text-muted">{inv.period}</td>
                    <td className="py-1.5 pr-3 text-ink">{inv.overageCredits.toLocaleString()}</td>
                    <td className="py-1.5 pr-3 text-ink">{money(inv.amountCents)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={chipCls}>{statusLabel(inv.status)}</span>
                      {inv.status === "failed" && (
                        <span className="block text-xs text-muted">
                          Card was declined — add a new card above or pay from the Stripe receipt.
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-2">
                        {inv.invoicePdfUrl ? (
                          <a
                            className="font-medium text-ink underline underline-offset-2"
                            href={inv.invoicePdfUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            PDF
                          </a>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                        {inv.hostedInvoiceUrl && (
                          <a
                            className="text-muted underline underline-offset-2 hover:text-ink"
                            href={inv.hostedInvoiceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View/pay
                          </a>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
