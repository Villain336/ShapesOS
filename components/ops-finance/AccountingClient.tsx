"use client";

// ShapesOS — Phase 10 (finance): client islands for /dashboard/ops/accounting
// (new account, tax rate, active toggle, manual journal entry, reversal,
// reports, finance settings). Gated writes run through useGated().

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Plus, Trash2, Undo2 } from "lucide-react";
import { aosButton } from "@/components/aos";
import { Dialog, ErrorLine, Note, cellCls, denseInputCls, fmtDay, inputCls, labelCls, money, numCls, parseMoneyInput, rowCls, DataTable } from "./kit";
import { jsonPost, useGated } from "./useGated";

export interface AccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Accounts + tax rates
// ---------------------------------------------------------------------------

export function NewAccountButton({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", type: "expense", parentId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/accounts", { code: form.code.trim(), name: form.name.trim(), type: form.type, ...(form.parentId ? { parentId: form.parentId } : {}) });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't add the account.");
    setOpen(false);
    setForm({ code: "", name: "", type: "expense", parentId: "" });
    router.refresh();
  }
  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> New account
      </button>
      {open ? (
        <Dialog title="New account" onClose={() => !busy && setOpen(false)}>
          <form onSubmit={save} className="flex flex-col gap-4">
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <label>
                <span className={labelCls}>Code</span>
                <input className={inputCls} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="6250" required />
              </label>
              <label>
                <span className={labelCls}>Name</span>
                <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Training" required />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label>
                <span className={labelCls}>Type</span>
                <select className={inputCls} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {["asset", "liability", "equity", "income", "expense"].map((t) => (
                    <option key={t} value={t}>
                      {t[0]!.toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelCls}>Parent (optional)</span>
                <select className={inputCls} value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
                  <option value="">None</option>
                  {accounts
                    .filter((a) => a.type === form.type)
                    .map((a) => (
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
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                {busy ? "Adding" : "Add account"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function ActiveToggle({ entity, id, active, label }: { entity: "accounts" | "tax-rates"; id: string; active: boolean; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    const r = await jsonPost(`/api/ops/${entity}`, { id, active: !active }, "PATCH");
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't change it.");
    router.refresh();
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" disabled={busy} onClick={toggle} className={aosButton({ variant: "quiet", size: "xs" })} aria-label={`${active ? "Deactivate" : "Reactivate"} ${label}`}>
        {active ? "Deactivate" : "Reactivate"}
      </button>
      {error ? <span className="max-w-[260px] text-xs text-failed-text">{error}</span> : null}
    </span>
  );
}

export function NewTaxRateButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pct, setPct] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const bps = Math.round(Number(pct) * 100);
    if (!Number.isFinite(bps) || bps < 0 || bps > 10_000) return setError("Enter a rate between 0 and 100%.");
    setBusy(true);
    setError(null);
    const r = await jsonPost("/api/ops/tax-rates", { name: name.trim(), rateBps: bps });
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't add the rate.");
    setOpen(false);
    setName("");
    setPct("");
    router.refresh();
  }
  return (
    <>
      <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> New tax rate
      </button>
      {open ? (
        <Dialog title="New tax rate" onClose={() => !busy && setOpen(false)}>
          <form onSubmit={save} className="flex flex-col gap-4">
            <label>
              <span className={labelCls}>Name</span>
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="State sales tax" required />
            </label>
            <label>
              <span className={labelCls}>Rate (%)</span>
              <input className={inputCls} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="8.25" required />
            </label>
            <p className="text-sm text-muted">Rates can't be edited once documents use them. To change one, add a new rate and deactivate the old one.</p>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
                {busy ? "Adding" : "Add rate"}
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Journal: manual entry (gated OPS_JOURNAL_POST) and reversal (OPS_JOURNAL_REVERSE)
// ---------------------------------------------------------------------------

interface DraftLine {
  accountId: string;
  debit: string;
  credit: string;
}

export function ManualEntryButton({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const gated = useGated();
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftLine[]>([
    { accountId: "", debit: "", credit: "" },
    { accountId: "", debit: "", credit: "" },
  ]);
  const active = accounts.filter((a) => a.active);
  const cents = (v: string) => (v.trim() ? parseMoneyInput(v) : 0);
  const totalD = lines.reduce((s, l) => s + (cents(l.debit) || 0), 0);
  const totalC = lines.reduce((s, l) => s + (cents(l.credit) || 0), 0);
  const set = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      entryDate: `${date}T00:00:00.000Z`,
      ...(memo.trim() ? { memo: memo.trim() } : {}),
      lines: lines.map((l) => ({ accountId: l.accountId, debitCents: cents(l.debit) || 0, creditCents: cents(l.credit) || 0 })),
    };
    if (body.lines.some((l) => !l.accountId || Number.isNaN(l.debitCents) || Number.isNaN(l.creditCents))) {
      return gated.setError("Every line needs an account and a valid amount.");
    }
    if (totalD !== totalC || totalD === 0) return gated.setError("Debits must equal credits.");
    void gated.start({
      label: "Post journal entry",
      summary: `Post a manual entry of ${money(totalD)} dated ${fmtDay(body.entryDate)}${memo ? ` — ${memo}` : ""}`,
      executeLabel: "Post entry",
      send: (approvalId) => jsonPost("/api/ops/journal-entries", { ...body, ...(approvalId ? { approvalId } : {}) }),
      onDone: () => {
        setOpen(false);
        router.refresh();
      },
    });
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden /> Manual entry
      </button>
      {open ? (
        <Dialog title="Manual journal entry" onClose={() => !gated.busy && setOpen(false)} wide>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="grid grid-cols-[160px_1fr] gap-3">
              <label>
                <span className={labelCls}>Date</span>
                <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} required />
              </label>
              <label>
                <span className={labelCls}>Memo</span>
                <input className={inputCls} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Owner contribution" />
              </label>
            </div>
            <div className="flex flex-col gap-2">
              {lines.map((l, i) => (
                <div key={i} className="grid grid-cols-[1fr_120px_120px_36px] items-center gap-2">
                  <select className={denseInputCls} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={`Line ${i + 1} account`}>
                    <option value="">Account…</option>
                    {active.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                  <input className={denseInputCls} inputMode="decimal" placeholder="Debit" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} aria-label={`Line ${i + 1} debit`} />
                  <input className={denseInputCls} inputMode="decimal" placeholder="Credit" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} aria-label={`Line ${i + 1} credit`} />
                  <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })} disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setLines([...lines, { accountId: "", debit: "", credit: "" }])}>
                  <Plus size={14} aria-hidden /> Add line
                </button>
                <span className="text-sm text-muted tabular-nums">
                  Debits {money(totalD)} · Credits {money(totalC)}
                </span>
              </div>
            </div>
            <p className="text-sm text-muted">Posting moves the books, so it needs an approval first. Entries can't be edited later; reverse them instead.</p>
            {gated.card}
            {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
            {gated.note ? <Note>{gated.note}</Note> : null}
            {!gated.pending ? (
              <div className="flex justify-end gap-2">
                <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={gated.busy} className={aosButton({ variant: "primary" })}>
                  {gated.busy ? "Requesting" : "Request approval"}
                </button>
              </div>
            ) : null}
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function ReverseButton({ entryId, totalCents, memo }: { entryId: string; totalCents: number; memo: string | null }) {
  const router = useRouter();
  const gated = useGated();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => setOpen(true)}>
        <Undo2 size={14} aria-hidden /> Reverse
      </button>
      {open ? (
        <Dialog title="Reverse entry" onClose={() => !gated.busy && setOpen(false)}>
          <p className="text-md text-ink">
            This posts the mirror of the {money(totalCents)} entry{memo ? ` "${memo}"` : ""} today. The original stays in the journal.
          </p>
          {gated.card}
          {gated.error ? <ErrorLine>{gated.error}</ErrorLine> : null}
          {!gated.pending ? (
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "quiet" })} onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                disabled={gated.busy}
                className={aosButton({ variant: "primary" })}
                onClick={() =>
                  gated.start({
                    label: "Reverse journal entry",
                    summary: `Reverse the ${money(totalCents)} entry${memo ? ` "${memo}"` : ""}`,
                    executeLabel: "Post reversal",
                    send: (approvalId) => jsonPost(`/api/ops/accounting/journal/${entryId}/reverse`, approvalId ? { approvalId } : {}),
                    onDone: () => {
                      setOpen(false);
                      router.refresh();
                    },
                  })
                }
              >
                Request approval
              </button>
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

type ReportRow = { accountId: string; code: string; name: string; balanceCents?: number; debitCents?: number; creditCents?: number };
interface ReportBody {
  report: {
    rows?: ReportRow[];
    totalDebitCents?: number;
    totalCreditCents?: number;
    income?: ReportRow[];
    expenses?: ReportRow[];
    totalIncomeCents?: number;
    totalExpenseCents?: number;
    netIncomeCents?: number;
    assets?: ReportRow[];
    liabilities?: ReportRow[];
    equity?: ReportRow[];
    totalAssetsCents?: number;
    totalLiabilitiesCents?: number;
    totalEquityCents?: number;
    currentEarningsCents?: number;
    balanced?: boolean;
  };
}

const KINDS = [
  { id: "profit_and_loss", label: "Profit and loss" },
  { id: "balance_sheet", label: "Balance sheet" },
  { id: "trial_balance", label: "Trial balance" },
] as const;

function Section({ title, rows, total, totalLabel }: { title: string; rows: ReportRow[]; total: number; totalLabel: string }) {
  return (
    <>
      <tr>
        <td colSpan={2} className="px-5 pt-4 pb-1 text-sm font-semibold text-muted">
          {title}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.accountId} className={rowCls}>
          <td className={cellCls}>
            <span className="aos-mono mr-2 text-xs text-muted">{r.code}</span>
            {r.name}
          </td>
          <td className={numCls}>{money(r.balanceCents)}</td>
        </tr>
      ))}
      <tr className="border-b border-line">
        <td className={`${cellCls} font-semibold`}>{totalLabel}</td>
        <td className={`${numCls} font-semibold`}>{money(total)}</td>
      </tr>
    </>
  );
}

export function ReportsView() {
  const today = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("profit_and_loss");
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<ReportBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/ops/accounting/reports?kind=${kind}&from=${from}&to=${to}`)
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as ReportBody & { error?: string };
        if (!live) return;
        if (!r.ok) throw new Error(d.error ?? "Couldn't load the report.");
        setData(d);
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load the report."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [kind, from, to]);

  const rep = data?.report;
  return (
    <section className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Report">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              aria-pressed={kind === k.id}
              onClick={() => setKind(k.id)}
              className={kind === k.id ? aosButton({ variant: "primary", size: "xs" }) : aosButton({ variant: "secondary", size: "xs" })}
            >
              {k.label}
            </button>
          ))}
        </div>
        {kind === "profit_and_loss" ? (
          <label className="ml-auto">
            <span className={labelCls}>From</span>
            <input type="date" className={denseInputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
        ) : null}
        <label className={kind === "profit_and_loss" ? "" : "ml-auto"}>
          <span className={labelCls}>{kind === "profit_and_loss" ? "To" : "As of"}</span>
          <input type="date" className={denseInputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {error ? (
        <div className="px-5 py-4">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : loading && !rep ? (
        <p className="px-5 py-6 text-md text-muted">Loading</p>
      ) : rep ? (
        <DataTable head={[{ label: "Account" }, { label: kind === "trial_balance" ? "Debit / credit" : "Amount", align: "right" }]} minWidth={480}>
          {kind === "profit_and_loss" ? (
            <>
              <Section title="Income" rows={rep.income ?? []} total={rep.totalIncomeCents ?? 0} totalLabel="Total income" />
              <Section title="Expenses" rows={rep.expenses ?? []} total={rep.totalExpenseCents ?? 0} totalLabel="Total expenses" />
              <tr>
                <td className={`${cellCls} text-base font-bold`}>Net income</td>
                <td className={`${numCls} text-base font-bold`}>{money(rep.netIncomeCents)}</td>
              </tr>
            </>
          ) : kind === "balance_sheet" ? (
            <>
              <Section title="Assets" rows={rep.assets ?? []} total={rep.totalAssetsCents ?? 0} totalLabel="Total assets" />
              <Section title="Liabilities" rows={rep.liabilities ?? []} total={rep.totalLiabilitiesCents ?? 0} totalLabel="Total liabilities" />
              <Section
                title="Equity"
                rows={[...(rep.equity ?? []), { accountId: "earnings", code: "", name: "Current earnings", balanceCents: rep.currentEarningsCents ?? 0 }]}
                total={rep.totalEquityCents ?? 0}
                totalLabel="Total equity"
              />
              <tr>
                <td className={`${cellCls} text-sm text-muted`}>{rep.balanced ? "Assets equal liabilities plus equity." : "Out of balance — check recent manual entries."}</td>
                <td className={numCls} />
              </tr>
            </>
          ) : (
            <>
              {(rep.rows ?? []).map((r) => (
                <tr key={r.accountId} className={rowCls}>
                  <td className={cellCls}>
                    <span className="aos-mono mr-2 text-xs text-muted">{r.code}</span>
                    {r.name}
                  </td>
                  <td className={numCls}>{r.debitCents ? `${money(r.debitCents)} Dr` : `${money(r.creditCents)} Cr`}</td>
                </tr>
              ))}
              <tr>
                <td className={`${cellCls} font-semibold`}>Totals</td>
                <td className={`${numCls} font-semibold`}>
                  {money(rep.totalDebitCents)} Dr · {money(rep.totalCreditCents)} Cr
                </td>
              </tr>
            </>
          )}
        </DataTable>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Finance settings: invoice sender + the workspace's own Stripe
// ---------------------------------------------------------------------------

export interface SettingsView {
  stripeConnected: boolean;
  stripeSecretHint: string | null;
  stripeWebhookConfigured: boolean;
  invoiceFromName: string | null;
  invoiceFooter: string | null;
  currency: string;
}

export function FinanceSettingsForm({ initial, webhookUrl, isAdmin }: { initial: SettingsView; webhookUrl: string; isAdmin: boolean }) {
  const router = useRouter();
  const [fromName, setFromName] = useState(initial.invoiceFromName ?? "");
  const [footer, setFooter] = useState(initial.invoiceFooter ?? "");
  const [secret, setSecret] = useState("");
  const [whsec, setWhsec] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    setNote(null);
    const r = await jsonPost(
      "/api/ops/finance/settings",
      { invoiceFromName: fromName, invoiceFooter: footer, ...(secret ? { stripeSecretKey: secret } : {}), ...(whsec ? { stripeWebhookSecret: whsec } : {}), ...extra },
      "PUT",
    );
    const d = (await r.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!r.ok) return setError(d.error ?? "Couldn't save.");
    setSecret("");
    setWhsec("");
    setNote("Saved.");
    router.refresh();
  }

  return (
    <form
      className="flex flex-col gap-5 px-5 py-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <label>
          <span className={labelCls}>Sender name on invoices</span>
          <input className={inputCls} value={fromName} onChange={(e) => setFromName(e.target.value)} disabled={!isAdmin} placeholder="Your company" />
        </label>
        <label>
          <span className={labelCls}>Footer</span>
          <input className={inputCls} value={footer} onChange={(e) => setFooter(e.target.value)} disabled={!isAdmin} placeholder="Bank details, tax number, thanks" />
        </label>
      </div>
      <div className="flex flex-col gap-3 rounded-md bg-canvas px-4 py-4">
        <h3 className="text-base font-semibold text-ink">Stripe payments</h3>
        <p className="text-sm text-muted">
          {initial.stripeConnected
            ? `Connected with your key ${initial.stripeSecretHint ?? ""}. Invoices can carry a "Pay online" link.`
            : "Connect your own Stripe account to add a pay-online link to invoices. Payments go straight to your Stripe account."}
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <label>
            <span className={labelCls}>{initial.stripeConnected ? "Replace secret key" : "Secret key"}</span>
            <input className={inputCls} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} disabled={!isAdmin} placeholder="sk_live_…" />
          </label>
          <label>
            <span className={labelCls}>Webhook signing secret {initial.stripeWebhookConfigured ? "(set)" : ""}</span>
            <input className={inputCls} type="password" autoComplete="off" value={whsec} onChange={(e) => setWhsec(e.target.value)} disabled={!isAdmin} placeholder="whsec_…" />
          </label>
        </div>
        <p className="text-sm text-muted">
          In Stripe, add a webhook for <span className="aos-mono text-xs">checkout.session.completed</span> pointing at{" "}
          <span className="aos-mono text-xs break-all">{webhookUrl}</span>, then paste its signing secret here.
        </p>
      </div>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {note ? <Note>{note}</Note> : null}
      {isAdmin ? (
        <div className="flex flex-wrap justify-end gap-2">
          {initial.stripeConnected ? (
            <button type="button" disabled={busy} className={aosButton({ variant: "deny" })} onClick={() => void save({ disconnectStripe: true })}>
              Disconnect Stripe
            </button>
          ) : null}
          <button type="submit" disabled={busy} className={aosButton({ variant: "primary" })}>
            {busy ? "Saving" : "Save settings"}
          </button>
        </div>
      ) : (
        <p className="text-sm text-muted">Only admins can change finance settings.</p>
      )}
    </form>
  );
}

export function PdfLink({ href, label = "PDF" }: { href: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={aosButton({ variant: "quiet", size: "xs" })}>
      <Download size={14} aria-hidden /> {label}
    </a>
  );
}
