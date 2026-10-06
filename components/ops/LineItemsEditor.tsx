// ShapesOS Phase 10 (ops-core) — line-item editor + lead picker for the new
// ops create modals (orders). Dollars in the UI, integer cents on the wire.

"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Search, Trash2, X } from "lucide-react";
import { btnGhostSm, inputCls, labelCls } from "@/components/crm/ui";
import { fmtCents, toCents } from "./shared";

export interface EditLine {
  name: string;
  qty: string;
  price: string;
}

export function linesValid(lines: EditLine[]): boolean {
  return (
    lines.length > 0 &&
    lines.every((l) => l.name.trim() && Number.isInteger(Number(l.qty)) && Number(l.qty) >= 1 && toCents(l.price) !== null)
  );
}

export function linesSubtotal(lines: EditLine[]): number {
  return lines.reduce((s, l) => s + (Number(l.qty) || 0) * (toCents(l.price) ?? 0), 0);
}

export function LineItemsEditor({
  lines,
  onChange,
  nameLabel = "Item",
}: {
  lines: EditLine[];
  onChange: (lines: EditLine[]) => void;
  nameLabel?: string;
}) {
  const set = (i: number, patch: Partial<EditLine>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[1fr_64px_96px_28px] gap-2">
        <span className={labelCls}>{nameLabel}</span>
        <span className={labelCls}>Qty</span>
        <span className={labelCls}>Price ($)</span>
        <span />
      </div>
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_64px_96px_28px] items-center gap-2">
          <input className={inputCls} value={l.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={`${nameLabel} ${i + 1}`} />
          <input className={inputCls} value={l.qty} inputMode="numeric" onChange={(e) => set(i, { qty: e.target.value })} aria-label={`Quantity ${i + 1}`} />
          <input className={inputCls} value={l.price} inputMode="decimal" onChange={(e) => set(i, { price: e.target.value })} aria-label={`Price ${i + 1}`} />
          <button
            type="button"
            className="rounded-md p-1 text-subtle hover:bg-hover-paper hover:text-ink disabled:opacity-40"
            onClick={() => onChange(lines.filter((_, j) => j !== i))}
            disabled={lines.length === 1}
            aria-label={`Remove line ${i + 1}`}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center justify-between">
        <button type="button" className={btnGhostSm} onClick={() => onChange([...lines, { name: "", qty: "1", price: "" }])}>
          <Plus size={13} /> Add line
        </button>
        <span className="text-[0.8125rem] text-muted">
          Subtotal <span className="font-bold tabular-nums text-ink">{fmtCents(linesSubtotal(lines))}</span>
        </span>
      </div>
    </div>
  );
}

export interface PickedLead {
  id: string;
  name: string;
  company: string | null;
}

/** Search CRM leads/customers (the existing /api/crm/leads search). */
export function LeadPicker({
  value,
  onChange,
  label = "Customer",
}: {
  value: PickedLead | null;
  onChange: (v: PickedLead | null) => void;
  label?: string;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PickedLead[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (value || q.trim().length < 2) {
      setHits([]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch(`/api/crm/leads?q=${encodeURIComponent(q.trim())}&limit=8`);
        const d = await r.json();
        if (r.ok) {
          setHits(
            ((d.leads ?? []) as Array<{ id: string; name: string; company?: string | null }>).map((l) => ({
              id: l.id,
              name: l.name,
              company: l.company ?? null,
            })),
          );
        }
      } catch {
        /* best-effort search */
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, value]);

  return (
    <div className="relative">
      <span className={labelCls}>{label} (optional)</span>
      {value ? (
        <div className="flex h-control-sm items-center justify-between rounded-md border-[1.5px] border-control bg-paper px-3 text-[0.8125rem] text-ink">
          <span className="truncate">
            {value.name}
            {value.company ? ` · ${value.company}` : ""}
          </span>
          <button type="button" onClick={() => onChange(null)} aria-label="Clear" className="text-subtle hover:text-ink">
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className={`${inputCls} w-full pl-8`} placeholder="Search leads and customers…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {hits.length > 0 && !value && (
        <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-paper shadow-raised">
          {hits.map((h) => (
            <button
              key={h.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-[0.8125rem] text-ink hover:bg-hover-paper"
              onClick={() => {
                onChange(h);
                setQ("");
              }}
            >
              {h.name}
              {h.company ? <span className="text-muted"> · {h.company}</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
