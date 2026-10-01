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
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
const labelCls = "block text-[12px] font-medium text-stone-600";

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
    const pct = Number(editing[c.key]);
    if (!isFinite(pct)) return;
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
      <div className="flex items-center gap-2 text-[13px] text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading expenses…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Monthly summary */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-stone-900">Monthly summary</h2>
          <input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
        {summary && (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Total spent</p>
              <p className="text-xl font-bold text-stone-900">{money(summary.totalCents)}</p>
            </div>
            <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Deductible portion</p>
              <p className="text-xl font-bold text-[var(--brand-700)]">{money(summary.totalDeductibleCents)}</p>
            </div>
            <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">Expenses</p>
              <p className="text-xl font-bold text-stone-900">{summary.expenseCount}</p>
            </div>
          </div>
        )}
        {summary && summary.categories.length > 0 && (
          <table className="mt-3 w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 text-left text-[12px] text-stone-500">
                <th className="py-1.5 font-medium">Category</th>
                <th className="py-1.5 font-medium">Spent</th>
                <th className="py-1.5 font-medium">Deductible</th>
              </tr>
            </thead>
            <tbody>
              {summary.categories.map((c) => (
                <tr key={c.key} className="border-b border-stone-100">
                  <td className="py-1.5 text-stone-900">{c.name} <span className="text-stone-400">({c.count})</span></td>
                  <td className="py-1.5 text-stone-600">{money(c.totalCents)}</td>
                  <td className="py-1.5 font-medium text-stone-900">{money(c.deductibleCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[11px] text-stone-400">
          A starting point for your accountant — not tax advice.
        </p>
      </div>

      {/* Record expense */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
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
            <label className={labelCls}>Note <span className="font-normal text-stone-400">(optional)</span></label>
            <input className={`${inputCls} mt-1 w-full`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="September bill" />
          </div>
        </div>
        <button type="button" onClick={record} disabled={busy || !amount} className={`${btnPrimary} mt-3`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Record
        </button>
      </div>

      {/* Allocation rules */}
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-stone-900">Allocation rules</h2>
          <p className="text-[12px] text-stone-500">
            What % of each bill counts as business use. Applies to new expenses only.
          </p>
        </div>
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50 text-left text-[12px] text-stone-500">
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 font-medium">Method</th>
              <th className="px-4 py-2 font-medium">Business %</th>
              <th className="px-4 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.key} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                <td className="px-4 py-2">
                  <p className="font-medium text-stone-900">{c.name}</p>
                  <p className="text-[11px] text-stone-500">{c.description}</p>
                </td>
                <td className="px-4 py-2 text-stone-600">
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
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-stone-900">
            {month} <span className="font-normal text-stone-500">({expenses.length})</span>
          </h2>
        </div>
        {expenses.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-stone-500">
            Nothing recorded this month yet.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[12px] text-stone-500">
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Amount</th>
                <th className="px-4 py-2 font-medium">Alloc.</th>
                <th className="px-4 py-2 font-medium">Deductible</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-4 py-2 text-stone-600">{new Date(e.occurredOn).toLocaleDateString()}</td>
                  <td className="px-4 py-2 text-stone-900">{e.category.name}{e.note && <span className="block text-[11px] text-stone-500">{e.note}</span>}</td>
                  <td className="px-4 py-2 text-stone-600">{money(e.amountCents)}</td>
                  <td className="px-4 py-2 text-stone-600">{e.allocationPct}%</td>
                  <td className="px-4 py-2 font-medium text-stone-900">{money(e.deductibleCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
