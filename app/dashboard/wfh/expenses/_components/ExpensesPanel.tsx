// Marketr — Wave 2 WFH mode slice 6: expenses panel (client).
// Category allocation editor + record-expense form + monthly summary.

"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";

interface Category {
  id: string;
  key: string;
  name: string;
  description: string;
  allocationMethod: string;
  allocationPct: number;
  officeSqft: number | null;
  totalSqft: number | null;
}

interface Expense {
  id: string;
  amountCents: number;
  currency: string;
  occurredOn: string;
  allocationMethod: string;
  allocationPct: number;
  deductibleCents: number;
  note: string | null;
  receiptUrl: string | null;
  category: { key: string; name: string };
}

interface Summary {
  month: string;
  categories: { key: string; name: string; totalCents: number; deductibleCents: number; count: number }[];
  totalCents: number;
  totalDeductibleCents: number;
  expenseCount: number;
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const labelCls = "block text-xs font-semibold text-muted";

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ExpensesPanel() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));

  const [catKey, setCatKey] = useState("internet");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");

  const [editing, setEditing] = useState<Record<string, string>>({});

  async function reload(targetMonth: string) {
    const [cres, eres, sres] = await Promise.all([
      fetch("/api/wfh/expenses/categories"),
      fetch(`/api/wfh/expenses?month=${targetMonth}`),
      fetch(`/api/wfh/expenses/summary?month=${targetMonth}`),
    ]);
    if (cres.ok) setCategories((await cres.json()).categories);
    if (eres.ok) setExpenses((await eres.json()).expenses);
    if (sres.ok) setSummary(await sres.json());
    setLoaded(true);
  }

  useEffect(() => {
    reload(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  async function record() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryKey: catKey,
          amountCents: Math.round(Number(amount) * 100),
          occurredOn: new Date(`${date}T12:00:00Z`).toISOString(),
          note: note || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.length ? data.details.join(" ") : (data.error ?? "Record failed"));
      }
      setAmount("");
      setNote("");
      await reload(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Record failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveAllocation(c: Category) {
    // A blank field is "not set", never 0% (Number("") is 0).
    const raw = String(editing[c.key] ?? "").trim();
    const pct = raw === "" ? NaN : Number(raw);
    if (!isFinite(pct) || pct < 0 || pct > 100) {
      setError("Enter a percent between 0 and 100.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/expenses/categories/${c.key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: c.allocationMethod, percent: pct }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.length ? data.details.join(" ") : (data.error ?? "Save failed"));
      }
      await reload(month);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading expenses…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div
          className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
          role="alert"
        >
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Monthly summary */}
      <div className="rounded-lg bg-paper px-4 py-4 shadow-hairline">
        <div className="flex items-center justify-between">
          <h2 className="aos-subheading">Monthly summary</h2>
          <input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        {summary && (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-md bg-canvas px-3 py-2">
              <p className="text-xs font-semibold text-muted">Total spent</p>
              <p className="text-lg font-bold text-ink">{money(summary.totalCents)}</p>
            </div>
            <div className="rounded-md bg-canvas px-3 py-2">
              <p className="text-xs font-semibold text-muted">Deductible portion</p>
              <p className="text-lg font-bold text-ink">{money(summary.totalDeductibleCents)}</p>
            </div>
            <div className="rounded-md bg-canvas px-3 py-2">
              <p className="text-xs font-semibold text-muted">Expenses</p>
              <p className="text-lg font-bold text-ink">{summary.expenseCount}</p>
            </div>
          </div>
        )}
        {summary && summary.categories.length > 0 && (
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="py-1.5 font-medium">Category</th>
                <th className="py-1.5 font-medium">Spent</th>
                <th className="py-1.5 font-medium">Deductible</th>
              </tr>
            </thead>
            <tbody>
              {summary.categories.map((c) => (
                <tr key={c.key} className="border-b border-line">
                  <td className="py-1.5 text-ink">{c.name} <span className="text-muted">({c.count})</span></td>
                  <td className="py-1.5 text-muted">{money(c.totalCents)}</td>
                  <td className="py-1.5 font-medium text-ink">{money(c.deductibleCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-subtle">
          A starting point for your accountant — not tax advice.
        </p>
      </div>

      {/* Record expense */}
      <div className="rounded-lg bg-paper px-4 py-4 shadow-hairline">
        <h2 className="aos-subheading flex items-center gap-2">
          <Plus className="h-4 w-4" /> Record expense
        </h2>
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <div>
            <label className={labelCls}>Category</label>
            <select className={`${inputCls} mt-1 w-full`} value={catKey} onChange={(e) => setCatKey(e.target.value)}>
              {categories.map((c) => (
                <option key={c.key} value={c.key}>{c.name} ({c.allocationPct}%)</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Amount ($)</label>
            <input className={`${inputCls} mt-1 w-full`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="89.99" inputMode="decimal" />
          </div>
          <div>
            <label className={labelCls}>Date</label>
            <input type="date" className={`${inputCls} mt-1 w-full`} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Note <span className="font-normal text-subtle">(optional)</span></label>
            <input className={`${inputCls} mt-1 w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="September bill" />
          </div>
        </div>
        <button type="button" onClick={record} disabled={busy || !amount} className={`${btnPrimary} mt-3`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Record
        </button>
      </div>

      {/* Allocation rules */}
      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">Allocation rules</h2>
          <p className="text-xs text-muted">
            What % of each bill counts as business use. Applies to new expenses only.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Method</th>
              <th className="px-4 py-2 font-medium">Business %</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.key} className="border-b border-line hover:bg-hover-paper">
                <td className="px-4 py-2">
                  <p className="font-medium text-ink">{c.name}</p>
                  <p className="text-xs text-muted">{c.description}</p>
                </td>
                <td className="px-4 py-2 text-muted">
                  {c.allocationMethod === "square_footage" ? `sqft (${c.officeSqft}/${c.totalSqft})` : "flat %"}
                </td>
                <td className="px-4 py-2">
                  <input
                    className={`${inputCls} w-20`}
                    value={editing[c.key] ?? String(c.allocationPct)}
                    onChange={(e) => setEditing((ed) => ({ ...ed, [c.key]: e.target.value }))}
                    inputMode="decimal"
                  />
                </td>
                <td className="px-4 py-2">
                  <button type="button" onClick={() => saveAllocation(c)} disabled={busy} className={btnGhost}>
                    Save
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent expenses */}
      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <div className="border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">
            {month} <span className="font-normal text-muted">({expenses.length})</span>
          </h2>
        </div>
        {expenses.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            Nothing recorded this month yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Alloc.</th>
                <th className="px-4 py-2 font-medium">Deductible</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-line hover:bg-hover-paper">
                  <td className="px-4 py-2 text-muted">{new Date(e.occurredOn).toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-ink">{e.category.name}{e.note && <span className="block text-xs text-muted">{e.note}</span>}</td>
                  <td className="px-4 py-2 text-muted">{money(e.amountCents)}</td>
                  <td className="px-4 py-2 text-muted">{e.allocationPct}%</td>
                  <td className="px-4 py-2 font-medium text-ink">{money(e.deductibleCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
