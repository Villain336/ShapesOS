"use client";

// ShapesOS — Phase 10 (finance): client islands for /dashboard/ops/quotes —
// new quote, send (gated OPS_QUOTE_SEND, emailed with its PDF), accept /
// decline, and convert to a draft invoice or order.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileOutput, Plus, Send } from "lucide-react";
import { aosButton } from "@/components/aos";
import { Dialog, ErrorLine, Note, inputCls, labelCls } from "./kit";
import { CustomerPicker, LinesEditor, emptyLine, parseLines, type LineDraft, type TaxRateOption } from "./DocForm";
import { jsonPost, useGated } from "./useGated";

export function NewQuoteButton({ rates }: { rates: TaxRateOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<{ id: string; name: string; company: string | null } | null>(null);
  const [email, setEmail] = useState("");
  const [validUntil, setValidUntil] = useState(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseLines(lines);
    if (!parsed) return setError("Every line needs a description, a whole quantity and a price.");
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/quotes", {
      lineItems: parsed,
      ...(customer ? { customerId: customer.id } : {}),
      ...(email.trim() ? { customerEmail: email.trim() } : {}),
      ...(validUntil ? { validUntil: `${validUntil}T23:59:59.000Z` } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't save the quote.");
    setOpen(false);
    setLines([emptyLine()]);
    setCustomer(null);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> New quote
      </button>
      {open ? (
        <Dialog title="New quote" onClose={() => !busy && setOpen(false)} wide>
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid gap-3 md:grid-cols-2">
              <CustomerPicker value={customer} onChange={setCustomer} />
              <label>
                <span className={labelCls}>Send to (optional, else the contact's email)</span>
                <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
              </label>
            </div>
            <LinesEditor lines={lines} onChange={setLines} rates={rates} />
            <div className="grid gap-3 md:grid-cols-[180px_1fr]">
              <label>
                <span className={labelCls}>Valid until</span>
                <input className={inputCls} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </label>
              <label>
                <span className={labelCls}>Notes on the quote</span>
                <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Scope, terms, timeline" />
              </label>
            </div>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Saving" : "Save draft"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function QuoteActions({ id, status, label, convertedInvoiceId, convertedOrderId }: { id: string; status: string; label: string; convertedInvoiceId: string | null; convertedOrderId: string | null }) {
  const router = useRouter();
  const gated = useGated();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function plain(fn: () => Promise<Response>, done: string) {
    setBusy(true);
    gated.setError(null);
    const r = await fn();
    const d = (await r.json().catch(() => ({}))) as { error?: string; delivery?: { message?: string } };
    setBusy(false);
    if (!r.ok) return gated.setError(d.error ?? "That didn't work.");
    gated.setNote(d.delivery?.message ? `${done} ${d.delivery.message}` : done);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <Dialog title={label} onClose={() => !busy && !gated.busy && setOpen(false)}>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/ops/quotes/${id}/pdf`} target="_blank" rel="noreferrer" className={aosButton({ variant: "secondary", size: "sm" })}>
              View PDF
            </a>
            {status === "draft" ? (
              <button
                type="button"
                disabled={gated.busy}
                className={aosButton({ variant: "primary", size: "sm" })}
                onClick={() =>
                  gated.start({
                    label: "Send quote",
                    summary: `Send ${label} to the customer by email with its PDF.`,
                    executeLabel: "Send quote",
                    send: (approvalId) => jsonPost("/api/ops/quotes", { id, status: "sent", ...(approvalId ? { approvalId } : {}) }, "PATCH"),
                    onDone: (d) => {
                      const delivery = d.delivery as { message?: string } | undefined;
                      gated.setNote(`Sent. ${delivery?.message ?? ""}`);
                      router.refresh();
                    },
                  })
                }
              >
                <Send size={16} aria-hidden /> Send quote
              </button>
            ) : null}
            {status === "sent" ? (
              <>
                <button type="button" disabled={busy} className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => plain(() => jsonPost("/api/ops/quotes", { id, status: "accepted" }, "PATCH"), "Marked accepted.")}>
                  Mark accepted
                </button>
                <button type="button" disabled={busy} className={aosButton({ variant: "deny", size: "sm" })} onClick={() => plain(() => jsonPost("/api/ops/quotes", { id, status: "declined" }, "PATCH"), "Marked declined.")}>
                  Mark declined
                </button>
              </>
            ) : null}
            {(status === "sent" || status === "accepted") && !convertedInvoiceId ? (
              <button type="button" disabled={busy} className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => plain(() => jsonPost(`/api/ops/quotes/${id}/convert`, { target: "invoice" }), "Draft invoice created. Find it under Invoicing.")}>
                <FileOutput size={16} aria-hidden /> Convert to invoice
              </button>
            ) : null}
            {(status === "sent" || status === "accepted") && !convertedOrderId ? (
              <button type="button" disabled={busy} className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => plain(() => jsonPost(`/api/ops/quotes/${id}/convert`, { target: "order" }), "Draft order created.")}>
                <FileOutput size={16} aria-hidden /> Convert to order
              </button>
            ) : null}
          </div>
          {gated.card}
          {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
          {gated.note ? <Note>{gated.note}</Note> : null}
          <p className="text-sm text-muted">Sending a quote needs an approval. Converting creates drafts only; sending the invoice still asks.</p>
        </Dialog>
      ) : null}
    </>
  );
}
