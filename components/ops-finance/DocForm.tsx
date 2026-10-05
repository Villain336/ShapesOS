"use client";

// ShapesOS — Phase 10 (finance): shared form parts for finance documents —
// a CRM-lead customer picker and a line editor with per-line tax rates
// (the server computes the tax; the preview here is only an estimate).

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { aosButton } from "@/components/aos";
import { denseInputCls, inputCls, labelCls, money, parseMoneyInput } from "./kit";

export interface TaxRateOption {
  id: string;
  name: string;
  rateBps: number;
}

export interface LineDraft {
  description: string;
  qty: string;
  price: string;
  taxRateId: string;
  accountId?: string;
}

export const emptyLine = (): LineDraft => ({ description: "", qty: "1", price: "", taxRateId: "" });

export interface ParsedLine {
  description: string;
  qty: number;
  priceCents: number;
  taxRateId?: string;
  accountId?: string;
}

/** Parse drafts → API lines; null when any line is incomplete. */
export function parseLines(lines: LineDraft[]): ParsedLine[] | null {
  const out: ParsedLine[] = [];
  for (const l of lines) {
    const qty = Number(l.qty);
    const priceCents = parseMoneyInput(l.price);
    if (!l.description.trim() || !Number.isInteger(qty) || qty < 1 || Number.isNaN(priceCents)) return null;
    out.push({
      description: l.description.trim(),
      qty,
      priceCents,
      ...(l.taxRateId ? { taxRateId: l.taxRateId } : {}),
      ...(l.accountId ? { accountId: l.accountId } : {}),
    });
  }
  return out.length ? out : null;
}

export function estimateTotals(lines: LineDraft[], rates: TaxRateOption[]) {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const qty = Number(l.qty) || 0;
    const price = parseMoneyInput(l.price);
    if (Number.isNaN(price)) continue;
    subtotal += qty * price;
    const r = rates.find((x) => x.id === l.taxRateId);
    if (r) tax += Math.floor((2 * qty * price * r.rateBps + 10_000) / 20_000);
  }
  return { subtotal, tax, total: subtotal + tax };
}

export function LinesEditor({
  lines,
  onChange,
  rates,
  accounts,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  rates: TaxRateOption[];
  /** When given, each line can pick an expense account (vendor bills). */
  accounts?: Array<{ id: string; code: string; name: string }>;
}) {
  const set = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const cols = accounts ? "grid-cols-[1fr_64px_110px_140px_150px_36px]" : "grid-cols-[1fr_64px_110px_150px_36px]";
  const t = estimateTotals(lines, rates);
  return (
    <div className="flex flex-col gap-2">
      <div className={`grid ${cols} gap-2 text-xs font-semibold text-muted`}>
        <span>Description</span>
        <span>Qty</span>
        <span>Unit price</span>
        {accounts ? <span>Account</span> : null}
        <span>Tax</span>
        <span />
      </div>
      {lines.map((l, i) => (
        <div key={i} className={`grid ${cols} items-center gap-2`}>
          <input className={denseInputCls} value={l.description} onChange={(e) => set(i, { description: e.target.value })} placeholder="What is it" aria-label={`Line ${i + 1} description`} />
          <input className={denseInputCls} inputMode="numeric" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label={`Line ${i + 1} quantity`} />
          <input className={denseInputCls} inputMode="decimal" value={l.price} onChange={(e) => set(i, { price: e.target.value })} placeholder="0.00" aria-label={`Line ${i + 1} unit price`} />
          {accounts ? (
            <select className={denseInputCls} value={l.accountId ?? ""} onChange={(e) => set(i, { accountId: e.target.value })} aria-label={`Line ${i + 1} account`}>
              <option value="">Default</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          ) : null}
          <select className={denseInputCls} value={l.taxRateId} onChange={(e) => set(i, { taxRateId: e.target.value })} aria-label={`Line ${i + 1} tax rate`}>
            <option value="">No tax</option>
            {rates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({(r.rateBps / 100).toFixed(2)}%)
              </option>
            ))}
          </select>
          <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })} disabled={lines.length <= 1} onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
            <Trash2 size={14} aria-hidden />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button type="button" className={aosButton({ variant: "quiet", size: "xs" })} onClick={() => onChange([...lines, emptyLine()])}>
          <Plus size={14} aria-hidden /> Add line
        </button>
        <span className="text-sm text-muted tabular-nums">
          Subtotal {money(t.subtotal)} · Tax {money(t.tax)} · <span className="font-semibold text-ink">Total {money(t.total)}</span>
        </span>
      </div>
    </div>
  );
}

interface LeadHit {
  id: string;
  name: string;
  company: string | null;
}

export function CustomerPicker({ value, onChange }: { value: LeadHit | null; onChange: (c: LeadHit | null) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<LeadHit[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (value || q.trim().length < 2) {
      setHits([]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const r = await fetch(`/api/crm/leads?q=${encodeURIComponent(q.trim())}&limit=8`).catch(() => null);
      const d = r && r.ok ? ((await r.json()) as { leads?: Array<{ id: string; name: string; company?: string | null }> }) : null;
      setHits((d?.leads ?? []).map((l) => ({ id: l.id, name: l.name, company: l.company ?? null })));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, value]);
  return (
    <div className="relative">
      <span className={labelCls}>Customer (CRM contact)</span>
      {value ? (
        <div className="flex h-control items-center justify-between rounded-md border-[1.5px] border-control bg-paper px-3.5">
          <span className="truncate text-base">
            {value.name}
            {value.company ? <span className="text-muted"> · {value.company}</span> : null}
          </span>
          <button type="button" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })} onClick={() => onChange(null)} aria-label="Clear customer">
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : (
        <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts by name or company" />
      )}
      {hits.length > 0 ? (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg bg-paper shadow-raised" role="listbox">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="flex h-11 w-full items-center gap-2 px-3 text-left text-md hover:bg-hover-paper"
                onClick={() => {
                  onChange(h);
                  setQ("");
                }}
              >
                {h.name}
                {h.company ? <span className="text-muted">· {h.company}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
