"use client";

// ShapesOS — Phase 10 (finance): client islands for /dashboard/ops/purchasing
// — vendors, partial receipts against purchase orders, vendor bills (post to
// accounts payable, pay through an approval, cancel through an approval).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PackageCheck, Plus, Receipt } from "lucide-react";
import { aosButton } from "@/components/aos";
import { Dialog, ErrorLine, Note, inputCls, labelCls, money, parseMoneyInput } from "./kit";
import { LinesEditor, emptyLine, parseLines, type LineDraft, type TaxRateOption } from "./DocForm";
import { jsonPost, useGated } from "./useGated";

export function NewVendorButton({ accounts }: { accounts: Array<{ id: string; code: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", email: "", phone: "", terms: "30", accountId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/vendors", {
      name: f.name.trim(),
      ...(f.email.trim() ? { email: f.email.trim() } : {}),
      ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
      paymentTermsDays: Number(f.terms) || 0,
      ...(f.accountId ? { defaultAccountId: f.accountId } : {}),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't add the vendor.");
    setOpen(false);
    setF({ name: "", email: "", phone: "", terms: "30", accountId: "" });
    router.refresh();
  }
  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> New vendor
      </button>
      {open ? (
        <Dialog title="New vendor" onClose={() => !busy && setOpen(false)}>
          <form onSubmit={save} className="flex flex-col gap-4">
            <label>
              <span className={labelCls}>Name</span>
              <input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Email</span>
                <input className={inputCls} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
              </label>
              <label>
                <span className={labelCls}>Phone</span>
                <input className={inputCls} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Payment terms (days)</span>
                <input className={inputCls} inputMode="numeric" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} />
              </label>
              <label>
                <span className={labelCls}>Default expense account</span>
                <select className={inputCls} value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })}>
                  <option value="">General expenses</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Adding" : "Add vendor"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function NewBillButton({ vendors, rates, accounts }: { vendors: Array<{ id: string; name: string }>; rates: TaxRateOption[]; accounts: Array<{ id: string; code: string; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [vendorId, setVendorId] = useState("");
  const [vendorRef, setVendorRef] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseLines(lines);
    if (!parsed) return setError("Every line needs a description, a whole quantity and a price.");
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/vendor-bills", { lineItems: parsed, ...(vendorId ? { vendorId } : {}), ...(vendorRef.trim() ? { vendorRef: vendorRef.trim() } : {}) });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't save the bill.");
    setOpen(false);
    setLines([emptyLine()]);
    router.refresh();
  }
  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> New bill
      </button>
      {open ? (
        <Dialog title="New vendor bill" onClose={() => !busy && setOpen(false)} wide>
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label>
                <span className={labelCls}>Vendor</span>
                <select className={inputCls} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                  <option value="">Pick a vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelCls}>Vendor's invoice number</span>
                <input className={inputCls} value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} />
              </label>
            </div>
            <LinesEditor lines={lines} onChange={setLines} rates={rates} accounts={accounts} />
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

export function BillActions({ id, label, status, balanceCents }: { id: string; label: string; status: string; balanceCents: number }) {
  const router = useRouter();
  const gated = useGated();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);

  async function post() {
    setBusy(true);
    gated.setError(null);
    const r = await jsonPost("/api/ops/vendor-bills", { id, status: "open" }, "PATCH");
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return gated.setError(d.error ?? "Couldn't post the bill.");
    gated.setNote("Posted to accounts payable.");
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <Dialog title={label} onClose={() => !busy && !gated.busy && setOpen(false)}>
          {status === "draft" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} className={aosButton({ variant: "primary", size: "sm" })} onClick={post}>
                Post to payables
              </button>
              <button
                type="button"
                disabled={gated.busy}
                className={aosButton({ variant: "deny", size: "sm" })}
                onClick={() =>
                  gated.start({
                    label: "Cancel vendor bill",
                    summary: `Cancel ${label}.`,
                    executeLabel: "Cancel bill",
                    send: (approvalId) => jsonPost("/api/ops/vendor-bills", { id, status: "cancelled", ...(approvalId ? { approvalId } : {}) }, "PATCH"),
                    onDone: () => {
                      gated.setNote("Cancelled.");
                      router.refresh();
                    },
                  })
                }
              >
                Cancel bill
              </button>
            </div>
          ) : null}
          {status === "open" ? (
            <div className="flex flex-col gap-3">
              <p className="text-md text-ink">{money(balanceCents)} is still to pay.</p>
              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className={labelCls}>Amount paid</span>
                  <input className={inputCls} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </label>
                <button
                  type="button"
                  disabled={gated.busy || !!gated.pending}
                  className={aosButton({ variant: "primary" })}
                  onClick={() => {
                    const cents = parseMoneyInput(amount);
                    if (Number.isNaN(cents) || cents <= 0) return gated.setError("Enter the amount paid.");
                    void gated.start({
                      label: "Pay vendor bill",
                      summary: `Record a payment of ${money(cents)} on ${label}.`,
                      executeLabel: "Record payment",
                      send: (approvalId) => jsonPost(`/api/ops/vendor-bills/${id}/pay`, { amountCents: cents, ...(approvalId ? { approvalId } : {}) }),
                      onDone: () => {
                        gated.setNote("Payment recorded.");
                        router.refresh();
                      },
                    });
                  }}
                >
                  Request approval
                </button>
              </div>
              <p className="text-sm text-muted">ShapesOS records the payment and posts it; the money itself moves in your bank.</p>
            </div>
          ) : null}
          {gated.card}
          {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
          {gated.note ? <Note>{gated.note}</Note> : null}
        </Dialog>
      ) : null}
    </>
  );
}

interface PoLineView {
  name: string;
  qty: number;
  receivedQty?: number;
}

export function ReceiveButton({ id, label, lines, status }: { id: string; label: string; lines: PoLineView[]; status: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<string[]>(lines.map((l) => String(Math.max(0, l.qty - (l.receivedQty ?? 0)))));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function receive(e: React.FormEvent) {
    e.preventDefault();
    const receipt = qty.map((q, index) => ({ index, qty: Number(q) })).filter((r) => Number.isInteger(r.qty) && r.qty > 0);
    if (receipt.length === 0) return setError("Enter what arrived.");
    setBusy(true);
    setError(null);
    const r = await jsonPost(`/api/ops/purchase-orders/${id}/receipts`, { lines: receipt, ...(note.trim() ? { note: note.trim() } : {}) });
    const d = (await r.json().catch(() => ({}))) as { error?: string; status?: string; restocked?: number };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't record the receipt.");
    setDone(d.status === "received" ? "Everything has arrived." : "Receipt recorded. The rest is still open.");
    router.refresh();
  }

  async function bill() {
    setBusy(true);
    setError(null);
    const r = await jsonPost(`/api/ops/purchase-orders/${id}/bill`, {});
    const d = (await r.json().catch(() => ({}))) as { error?: string; created?: boolean };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't create the bill.");
    setDone(d.created ? "Draft bill created below." : "This order already has a bill.");
    router.refresh();
  }

  const receivable = status === "sent" || status === "partially_received";
  return (
    <>
      <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setOpen(true)}>
        <PackageCheck size={14} aria-hidden /> {receivable ? "Receive" : "Bill"}
      </button>
      {open ? (
        <Dialog title={label} onClose={() => !busy && setOpen(false)}>
          {receivable ? (
            <form onSubmit={receive} className="flex flex-col gap-3">
              {lines.map((l, i) => (
                <label key={i} className="grid grid-cols-[1fr_96px] items-center gap-3">
                  <span className="text-md">
                    {l.name} <span className="text-sm text-muted">({l.receivedQty ?? 0} of {l.qty} received)</span>
                  </span>
                  <input className={inputCls} inputMode="numeric" value={qty[i]} onChange={(e) => setQty(qty.map((q, j) => (j === i ? e.target.value : q)))} aria-label={`${l.name} quantity arrived`} />
                </label>
              ))}
              <label>
                <span className={labelCls}>Note (optional)</span>
                <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Delivery note number" />
              </label>
              <div className="flex justify-end">
                <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                  {busy ? "Recording" : "Record receipt"}
                </button>
              </div>
            </form>
          ) : null}
          <div className="flex items-center justify-between gap-3 rounded-md bg-canvas px-4 py-3">
            <span className="text-sm text-muted">Bill this order: a draft bill with the received quantities.</span>
            <button type="button" disabled={busy} className={aosButton({ variant: "secondary", size: "sm" })} onClick={bill}>
              <Receipt size={16} aria-hidden /> Create bill
            </button>
          </div>
          {error ? <ErrorLine>{error}</ErrorLine> : null}
          {done ? <Note>{done}</Note> : null}
        </Dialog>
      ) : null}
    </>
  );
}
