"use client";

// ShapesOS — Phase 10 (finance): client islands for /dashboard/ops/expenses —
// a new claim with receipt uploads (POST /api/files → WorkspaceFile ids),
// submit for approval (separation of duties), approve (execute the approved
// approval), reject with a reason, reimburse (gated).

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Paperclip, Plus, Trash2 } from "lucide-react";
import { aosButton } from "@/components/aos";
import { Dialog, ErrorLine, Note, denseInputCls, inputCls, labelCls, money, parseMoneyInput } from "./kit";
import { jsonPost, useGated } from "./useGated";

export const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "travel", label: "Travel" },
  { id: "meals", label: "Meals" },
  { id: "software", label: "Software" },
  { id: "office", label: "Office supplies" },
  { id: "rent", label: "Rent" },
  { id: "utilities", label: "Utilities" },
  { id: "professional", label: "Professional fees" },
  { id: "advertising", label: "Advertising" },
  { id: "bank_fees", label: "Bank fees" },
  { id: "other", label: "Other" },
];

interface ClaimLine {
  spentAt: string;
  description: string;
  category: string;
  amount: string;
  tax: string;
  receiptFileId: string;
  receiptName: string;
}

const blank = (): ClaimLine => ({ spentAt: new Date().toISOString().slice(0, 10), description: "", category: "travel", amount: "", tax: "", receiptFileId: "", receiptName: "" });

export function NewClaimButton({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState<ClaimLine[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, p: Partial<ClaimLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));

  async function upload(i: number, file: File) {
    setError(null);
    const form = new FormData();
    form.set("workspaceId", workspaceId);
    form.set("path", `/files/receipts/${Date.now()}`);
    form.set("file", file);
    const r = await fetch("/api/files", { method: "POST", body: form });
    const d = (await r.json().catch(() => ({}))) as { file?: { id: string; filename: string }; error?: string };
    if (!r.ok || !d.file) return setError(d.error ?? "The receipt didn't upload.");
    set(i, { receiptFileId: d.file.id, receiptName: d.file.filename });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = lines.map((l) => ({ ...l, cents: parseMoneyInput(l.amount), taxC: l.tax.trim() ? parseMoneyInput(l.tax) : 0 }));
    if (parsed.some((l) => !l.description.trim() || Number.isNaN(l.cents) || l.cents <= 0 || Number.isNaN(l.taxC))) {
      return setError("Every line needs a description and an amount.");
    }
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/expense-claims", {
      title: title.trim(),
      lines: parsed.map((l) => ({
        spentAt: `${l.spentAt}T12:00:00.000Z`,
        description: l.description.trim(),
        category: l.category,
        amountCents: l.cents,
        ...(l.taxC ? { taxCents: l.taxC } : {}),
        ...(l.receiptFileId ? { receiptFileId: l.receiptFileId } : {}),
      })),
    });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't save the claim.");
    setOpen(false);
    setTitle("");
    setLines([blank()]);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> New claim
      </button>
      {open ? (
        <Dialog title="New expense claim" onClose={() => !busy && setOpen(false)} wide>
          <form onSubmit={save} className="flex flex-col gap-4">
            <label>
              <span className={labelCls}>What was it for</span>
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Client visit, Boston" required />
            </label>
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[130px_1fr_130px_100px_90px_auto_36px] items-center gap-2">
                  <input type="date" className={denseInputCls} value={l.spentAt} onChange={(e) => set(i, { spentAt: e.target.value })} aria-label={`Line ${i + 1} date`} />
                  <input className={denseInputCls} value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="Description" aria-label={`Line ${i + 1} description`} />
                  <select className={denseInputCls} value={l.category} onChange={(e) => set(i, { category: e.target.value })} aria-label={`Line ${i + 1} category`}>
                    {CATEGORIES.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input className={denseInputCls} inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="Amount" aria-label={`Line ${i + 1} amount`} />
                  <input className={denseInputCls} inputMode="decimal" value={l.tax} onChange={(e) => set(i, { tax: e.target.value })} placeholder="Tax" aria-label={`Line ${i + 1} tax included`} />
                  <label className={aosButton({ variant: "quiet", size: "xs", className: "cursor-pointer" })}>
                    <Paperclip size={14} aria-hidden />
                    <span className="max-w-[90px] truncate">{l.receiptName || "Receipt"}</span>
                    <input type="file" className="sr-only" accept="image/*,application/pdf" onChange={(e) => e.target.files?.[0] && void upload(i, e.target.files[0])} />
                  </label>
                  <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })} disabled={lines.length <= 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </div>
              ))}
              <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "self-start" })} onClick={() => setLines([...lines, blank()])}>
                <Plus size={14} aria-hidden /> Add line
              </button>
            </div>
            <p className="text-sm text-muted">Tax is the recoverable part already included in the amount. Receipts are stored in Files under /files/receipts.</p>
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

export function ClaimActions({
  id,
  label,
  status,
  isClaimant,
  approvalId,
  totalCents,
  lines,
  workspaceId,
}: {
  id: string;
  label: string;
  status: string;
  isClaimant: boolean;
  approvalId: string | null;
  totalCents: number;
  lines: Array<{ description: string; category: string; amountCents: number; receiptFileId: string | null }>;
  workspaceId: string;
}) {
  const router = useRouter();
  const gated = useGated();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(action: string, body: Record<string, unknown>, done: string) {
    setBusy(true);
    gated.setError(null);
    const r = await jsonPost(`/api/ops/expense-claims/${id}/${action}`, body);
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok && r.status !== 202) return gated.setError(d.error ?? "That didn't work.");
    gated.setNote(done);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? (
        <Dialog title={label} onClose={() => !busy && !gated.busy && setOpen(false)}>
          <ul className="flex flex-col gap-1 text-md">
            {lines.map((l, i) => (
              <li key={i} className="flex items-center justify-between gap-3">
                <span className="truncate">
                  {l.description} <span className="text-sm text-muted">· {CATEGORIES.find((c) => c.id === l.category)?.label ?? l.category}</span>
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  {l.receiptFileId ? (
                    <a className="text-sm font-semibold underline" target="_blank" rel="noreferrer" href={`/api/files/${l.receiptFileId}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`}>
                      Receipt
                    </a>
                  ) : null}
                  {money(l.amountCents)}
                </span>
              </li>
            ))}
            <li className="flex justify-between border-t border-line pt-1 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{money(totalCents)}</span>
            </li>
          </ul>
          {status === "draft" && isClaimant ? (
            <button type="button" disabled={busy} className={aosButton({ variant: "primary", size: "sm", className: "self-start" })} onClick={() => call("submit", {}, "Submitted. Someone else approves it in the Actions queue.")}>
              Submit for approval
            </button>
          ) : null}
          {status === "submitted" && !isClaimant ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted">Approve the request in the Actions queue first, then post it here. You can't approve your own claim.</p>
              <div className="flex flex-wrap gap-2">
                <a href="/dashboard/actions" className={aosButton({ variant: "review", size: "sm" })}>
                  Review in Actions
                </a>
                <button type="button" disabled={busy || !approvalId} className={aosButton({ variant: "primary", size: "sm" })} onClick={() => call("approve", { approvalId }, "Approved and posted.")}>
                  Post approved claim
                </button>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex-1">
                  <span className={labelCls}>Reason to reject</span>
                  <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <button type="button" disabled={busy || !reason.trim()} className={aosButton({ variant: "deny" })} onClick={() => call("reject", { reason }, "Rejected.")}>
                  Reject
                </button>
              </div>
            </div>
          ) : null}
          {status === "approved" ? (
            <button
              type="button"
              disabled={gated.busy || !!gated.pending}
              className={aosButton({ variant: "primary", size: "sm", className: "self-start" })}
              onClick={() =>
                gated.start({
                  label: "Reimburse expense claim",
                  summary: `Record the reimbursement of ${money(totalCents)} for ${label}.`,
                  executeLabel: "Record reimbursement",
                  send: (aid) => jsonPost(`/api/ops/expense-claims/${id}/reimburse`, aid ? { approvalId: aid } : {}),
                  onDone: () => {
                    gated.setNote("Reimbursed.");
                    router.refresh();
                  },
                })
              }
            >
              Reimburse
            </button>
          ) : null}
          {gated.card}
          {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
          {gated.note ? <Note>{gated.note}</Note> : null}
        </Dialog>
      ) : null}
    </>
  );
}
