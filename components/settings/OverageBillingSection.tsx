// Marketr — overage billing section for Settings → Usage (overage invoicing).
// Card-on-file management (Stripe setup-mode Checkout), accrued unbilled
// overage, and the invoice list. Admin-only (server-gated by the page).
// Never displays keys, secrets, or card data — only whether a card is on
// file, amounts, and Stripe-hosted invoice links.

"use client";

import { useState } from "react";
import { Notice, btnCls, primaryBtnVioletCls, type NoticeState } from "./ui";

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
      <h3 className="text-sm font-medium text-zinc-800">Overage billing</h3>
      <p className="mt-1 text-sm text-zinc-500">
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
        <div className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 p-4">
          <div className="text-sm text-zinc-600">
            <p>
              <strong className="text-zinc-800">Card on file:</strong>{" "}
              {overage.hasPaymentMethod ? (
                <span className="text-emerald-700">Yes — overage invoices charge automatically.</span>
              ) : (
                <span className="text-zinc-500">
                  None. Add a card to enable auto-overage (or replace the current one).
                </span>
              )}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Card details are collected by Stripe — they never touch Marketr.
            </p>
          </div>
          <button className={btnCls} disabled={adding} onClick={addCard}>
            {adding ? "Redirecting…" : overage.hasPaymentMethod ? "Replace card" : "Add card"}
          </button>
        </div>

        {/* Accrued unbilled overage */}
        <div className="rounded-lg border border-zinc-200 p-4">
          <p className="text-sm text-zinc-600">
            <strong className="text-zinc-800">Accrued unbilled overage:</strong>{" "}
            {overage.accruedCredits.toLocaleString()} credits ({money(overage.accruedCents)})
            {overage.accruedCents > 0 && overage.accruedCents < overage.minInvoiceCents && (
              <span className="text-zinc-500">
                {" "}— below the {money(overage.minInvoiceCents)} minimum; carries forward.
              </span>
            )}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Billed on the 1st of each month for completed months only.
          </p>
        </div>

        {/* Invoices */}
        <div>
          <h4 className="text-sm font-medium text-zinc-800">Invoices</h4>
          {overage.invoices.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No overage invoices yet.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1 pr-3 font-medium">Period</th>
                  <th className="py-1 pr-3 font-medium">Credits</th>
                  <th className="py-1 pr-3 font-medium">Amount</th>
                  <th className="py-1 pr-3 font-medium">Status</th>
                  <th className="py-1 pr-3 font-medium">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {overage.invoices.map((inv) => (
                  <tr key={inv.id} className="border-t border-zinc-100">
                    <td className="py-1.5 pr-3 text-zinc-600">{inv.period}</td>
                    <td className="py-1.5 pr-3">{inv.overageCredits.toLocaleString()}</td>
                    <td className="py-1.5 pr-3">{money(inv.amountCents)}</td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          inv.status === "failed"
                            ? "font-medium text-red-700"
                            : inv.status === "paid"
                              ? "text-emerald-700"
                              : "text-zinc-600"
                        }
                      >
                        {statusLabel(inv.status)}
                      </span>
                      {inv.status === "failed" && (
                        <span className="block text-xs text-zinc-500">
                          Card was declined — add a new card above or pay from the Stripe receipt.
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-2">
                        {inv.invoicePdfUrl ? (
                          <a
                            className="text-emerald-700 underline"
                            href={inv.invoicePdfUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            PDF
                          </a>
                        ) : (
                          <span className="text-zinc-400">—</span>
                        )}
                        {inv.hostedInvoiceUrl && (
                          <a
                            className="text-zinc-500 underline"
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
