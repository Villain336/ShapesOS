// Marketr CRM — new invoice modal (Phase 17 slice 2).
// Draft creation is a free logged write; the invoice stays a draft until
// the send is approved. Customer = an existing CRM lead (lead-turned-customer).

"use client";

import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2, Loader2, Search } from "lucide-react";
import { formatMoney } from "./types";

interface LineItem {
  description: string;
  qty: string;
  price: string; // dollars, converted to cents on submit
}

interface LeadHit {
  id: string;
  name: string;
  company: string | null;
}

function toCents(dollars: string): number | null {
  const t = dollars.trim().replace(/[$,]/g, "");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function NewInvoiceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerHits, setCustomerHits] = useState<LeadHit[]>([]);
  const [customer, setCustomer] = useState<LeadHit | null>(null);
  const [searching, setSearching] = useState(false);
  const [showHits, setShowHits] = useState(false);
  const [items, setItems] = useState<LineItem[]>([{ description: "", qty: "1", price: "" }]);
  const [tax, setTax] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (customer) return;
    const needle = customerQuery.trim();
    if (needle.length < 2) {
      setCustomerHits([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/crm/leads?q=${encodeURIComponent(needle)}&limit=8`);
        const d = await r.json();
        if (r.ok) {
          setCustomerHits(
            ((d.leads ?? []) as Array<{ id: string; name: string; company?: string | null }>).map((l) => ({
              id: l.id,
              name: l.name,
              company: l.company ?? null,
            })),
          );
          setShowHits(true);
        }
      } catch {
        /* best-effort */
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [customerQuery, customer]);

  const totals = (() => {
    let subtotal = 0;
    let valid = items.length > 0;
    for (const it of items) {
      const qty = Number(it.qty);
      const priceCents = toCents(it.price);
      if (!it.description.trim() || !Number.isInteger(qty) || qty < 1 || priceCents === null) {
        valid = false;
      } else {
        subtotal += qty * priceCents;
      }
    }
    const taxCents = tax.trim() === "" ? 0 : toCents(tax);
    if (taxCents === null) valid = false;
    return { subtotal, taxCents: taxCents ?? 0, total: subtotal + (taxCents ?? 0), valid };
  })();

  async function submit() {
    setError(null);
    if (!totals.valid) {
      setError("Each line needs a description, a whole-number quantity, and a valid price.");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        lineItems: items.map((it) => ({
          description: it.description.trim(),
          qty: Number(it.qty),
          priceCents: toCents(it.price)!,
        })),
        taxCents: totals.taxCents,
      };
      if (customer) body.customerId = customer.id;
      if (dueAt) body.dueAt = new Date(`${dueAt}T00:00:00`).toISOString();
      const r = await fetch("/api/ops/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to create invoice.");
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create invoice.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="crm-backdrop" onClick={onClose} />
      <div className="crm-modal">
        <div className="flex items-start justify-between border-b border-stone-200 px-5 py-4">
          <div>
            <h3 className="text-lg font-bold tracking-tight text-stone-900">New invoice</h3>
            <p className="mt-0.5 text-[13px] text-stone-500">
              Created as a draft — sending it needs your approval.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}

          {/* Customer */}
          <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
            Customer (CRM lead)
          </label>
          <div className="relative mt-1">
            {customer ? (
              <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2">
                <span className="text-[13px] font-medium text-stone-800">
                  {customer.name}
                  {customer.company && <span className="text-stone-400"> · {customer.company}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setCustomer(null);
                    setCustomerQuery("");
                  }}
                  className="text-[12px] font-semibold text-stone-500 hover:text-stone-800"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                  <input
                    className="crm-input w-full pl-8"
                    placeholder="Search leads by name or company…"
                    value={customerQuery}
                    onChange={(e) => setCustomerQuery(e.target.value)}
                    onFocus={() => customerHits.length > 0 && setShowHits(true)}
                  />
                  {searching && <Loader2 size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-stone-400" />}
                </div>
                {showHits && customerHits.length > 0 && (
                  <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-stone-200 bg-white shadow-lg">
                    {customerHits.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        onClick={() => {
                          setCustomer(h);
                          setShowHits(false);
                        }}
                        className="block w-full px-3 py-2 text-left text-[13px] hover:bg-stone-50"
                      >
                        <span className="font-medium text-stone-800">{h.name}</span>
                        {h.company && <span className="text-stone-400"> · {h.company}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Line items */}
          <div className="mt-4 flex items-center justify-between">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
              Line items
            </label>
            <button
              type="button"
              onClick={() => setItems([...items, { description: "", qty: "1", price: "" }])}
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--brand-700)] hover:underline"
            >
              <Plus size={13} /> Add line
            </button>
          </div>
          <div className="mt-1 space-y-2">
            {items.map((it, i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="crm-input flex-1"
                  placeholder="Description"
                  value={it.description}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                />
                <input
                  className="crm-input w-16"
                  placeholder="Qty"
                  inputMode="numeric"
                  value={it.qty}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                />
                <input
                  className="crm-input w-28"
                  placeholder="$0.00"
                  inputMode="decimal"
                  value={it.price}
                  onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))}
                />
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setItems(items.filter((_, j) => j !== i))}
                    className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-red-600"
                    aria-label="Remove line"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Tax
              </label>
              <input
                className="crm-input mt-1 w-full"
                placeholder="$0.00"
                inputMode="decimal"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">
                Due date <span className="font-normal normal-case">(optional — net-30 on send)</span>
              </label>
              <input
                type="date"
                className="crm-input mt-1 w-full"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-[13px]">
            <div className="flex justify-between text-stone-500">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatMoney(totals.subtotal)}</span>
            </div>
            <div className="flex justify-between text-stone-500">
              <span>Tax</span>
              <span className="tabular-nums">{formatMoney(totals.taxCents)}</span>
            </div>
            <div className="flex justify-between pt-1 text-[15px] font-bold text-stone-900">
              <span>Total</span>
              <span className="tabular-nums">{formatMoney(totals.total)}</span>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-stone-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-[13px] font-semibold text-stone-700"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || !totals.valid}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />} Create draft
          </button>
        </div>
      </div>
    </>
  );
}
