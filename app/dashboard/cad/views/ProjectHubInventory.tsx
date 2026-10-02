"use client";

// Marketr — CAD + Hardware slice 4: project hub inventory.
// Parts inventory with auditable stock adjustments. On-hand quantity is
// NEVER edited directly — every movement is an event (who/when/delta/
// reason). Going below zero requires explicit confirmation. Supplier
// links carry quoted costs with source + date; only USD quotes flow into
// costing (no FX is ever invented).

import { useCallback, useEffect, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { ErrorNote, LoadingNote, StatusPill } from "./ProjectHubTab";

interface PartRow {
  id: string;
  name: string;
  sku: string | null;
  category: string;
  onHandQty: number;
  reorderPoint: number;
  unitOfMeasure: string;
  storageLocation: string | null;
  lowStock: boolean;
}

interface PartDetail {
  part: PartRow & { createdAt: string };
  supplierLinks: {
    id: string;
    preferred: boolean;
    quotedUnitCost: number | null;
    currency: string;
    quotedDate: string | null;
    quoteSource: string | null;
    supplier: { id: string; name: string; contact: string | null; leadTime: string | null };
  }[];
  recentEvents: {
    id: string;
    delta: number;
    quantityAfter: number;
    reason: string;
    actor: string;
    createdAt: string;
  }[];
}

interface SupplierRow {
  id: string;
  name: string;
}

export function ProjectHubInventory({ projectId }: { projectId: string }) {
  void projectId; // inventory is tenant-level; the hub gives it a home per project.
  const [parts, setParts] = useState<PartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lowOnly, setLowOnly] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = lowOnly ? "?lowStock=1" : "";
      const res = await fetch(`/api/cad/parts${q}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load parts.");
      setParts(body.parts as PartRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load parts.");
    } finally {
      setLoading(false);
    }
  }, [lowOnly]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLowOnly((v) => !v)}
          aria-pressed={lowOnly}
          className={`h-10 rounded-full px-4 text-sm font-semibold ${
            lowOnly
              ? "bg-ink text-paper"
              : "bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
          }`}
        >
          Low stock only
        </button>
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add part
        </button>
      </div>

      {showCreate && (
        <CreatePartForm
          onDone={() => {
            setShowCreate(false);
            load();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {loading ? (
        <LoadingNote label="Loading parts" />
      ) : error ? (
        <ErrorNote message={error} />
      ) : parts.length === 0 ? (
        <p className="text-sm text-muted">
          {lowOnly
            ? "No parts at or below their reorder point."
            : "No parts in inventory yet. Add a part to start tracking stock."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2.5">Part</th>
                <th className="px-3 py-2.5">Category</th>
                <th className="px-3 py-2.5">On hand</th>
                <th className="px-3 py-2.5">Reorder point</th>
                <th className="px-3 py-2.5">Location</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <PartRowView
                  key={p.id}
                  part={p}
                  open={openId === p.id}
                  onToggle={() => setOpenId((o) => (o === p.id ? null : p.id))}
                  onChanged={load}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PartRowView({
  part,
  open,
  onToggle,
  onChanged,
}: {
  part: PartRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr className="border-b border-line last:border-0 hover:bg-hover-paper">
        <td className="px-3 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            {part.name}
          </button>
          {part.sku && <span className="ml-2 font-mono text-xs text-muted">{part.sku}</span>}
        </td>
        <td className="px-3 py-2.5"><StatusPill>{part.category}</StatusPill></td>
        <td className="px-3 py-2.5">
          <span className="font-mono text-xs text-ink">
            {part.onHandQty} {part.unitOfMeasure}
          </span>{" "}
          {part.lowStock && <StatusPill>Low stock</StatusPill>}
        </td>
        <td className="px-3 py-2.5 font-mono text-xs text-muted">{part.reorderPoint}</td>
        <td className="px-3 py-2.5 text-sm text-muted">{part.storageLocation ?? "—"}</td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-canvas">
          <td colSpan={5} className="px-3 py-3">
            <PartDetailView partId={part.id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function PartDetailView({ partId, onChanged }: { partId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [confirmBelowZero, setConfirmBelowZero] = useState(false);
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/parts/${partId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load the part.");
      setDetail(body as PartDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the part.");
    } finally {
      setLoading(false);
    }
  }, [partId]);

  useEffect(() => {
    load();
  }, [load]);

  const adjust = async () => {
    setAdjustBusy(true);
    setAdjustError(null);
    try {
      const res = await fetch(`/api/cad/parts/${partId}/adjust`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: Number(delta), reason: reason.trim(), confirmBelowZero }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Adjustment failed.");
      setDelta("");
      setReason("");
      setConfirmBelowZero(false);
      await load();
      onChanged();
    } catch (e) {
      setAdjustError(e instanceof Error ? e.message : "Adjustment failed.");
    } finally {
      setAdjustBusy(false);
    }
  };

  if (loading) return <LoadingNote label="Loading the part" />;
  if (error || !detail) return <ErrorNote message={error ?? "Could not load the part."} />;

  const projected = delta.trim() === "" || Number.isNaN(Number(delta))
    ? null
    : detail.part.onHandQty + Number(delta);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-line bg-paper p-4">
        <h4 className="mb-2 text-sm font-semibold text-ink">Stock adjustment</h4>
        <p className="mb-3 text-xs text-muted">
          Every adjustment is an auditable event — who, when, how many, why.
          On-hand is never edited directly. Going below zero needs explicit
          confirmation.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink" htmlFor={`hw-delta-${partId}`}>
              Delta (+ in / − out)
            </label>
            <input
              id={`hw-delta-${partId}`}
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="-4"
              inputMode="decimal"
              className="h-10 w-full rounded-md border border-control bg-paper px-3 font-mono text-sm text-ink"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-ink" htmlFor={`hw-reason-${partId}`}>
              Reason (required)
            </label>
            <input
              id={`hw-reason-${partId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="received PO-114"
              className="h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
            />
          </div>
        </div>
        {projected != null && projected < 0 && (
          <label className="mt-2 flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={confirmBelowZero}
              onChange={(e) => setConfirmBelowZero(e.target.checked)}
              className="mt-1"
            />
            <span>
              I confirm this adjustment intentionally takes stock below zero
              (to {projected} {detail.part.unitOfMeasure}).
            </span>
          </label>
        )}
        {adjustError && <p className="mt-2 text-sm text-failed-text">{adjustError}</p>}
        <button
          type="button"
          onClick={adjust}
          disabled={
            adjustBusy ||
            !reason.trim() ||
            delta.trim() === "" ||
            Number.isNaN(Number(delta)) ||
            Number(delta) === 0 ||
            (projected != null && projected < 0 && !confirmBelowZero)
          }
          className="mt-3 flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
        >
          {adjustBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Apply adjustment
          {projected != null && <span className="font-mono text-xs">→ {projected}</span>}
        </button>

        <h4 className="mb-2 mt-5 text-sm font-semibold text-ink">Audit trail</h4>
        <ul className="space-y-1.5">
          {detail.recentEvents.map((e) => (
            <li key={e.id} className="text-sm">
              <span className={`font-mono text-xs ${e.delta >= 0 ? "text-ink" : "text-ink"}`}>
                {e.delta >= 0 ? "+" : ""}{e.delta}
              </span>{" "}
              <span className="text-ink">{e.reason}</span>{" "}
              <span className="font-mono text-xs text-muted">
                → {e.quantityAfter} · {e.actor} · {new Date(e.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-line bg-paper p-4">
        <h4 className="mb-2 text-sm font-semibold text-ink">Suppliers & quotes</h4>
        <p className="mb-3 text-xs text-muted">
          A quoted cost needs its source (who said this price, and where it's
          from). One preferred supplier per part — marking a new one demotes
          the previous.
        </p>
        {detail.supplierLinks.length === 0 ? (
          <p className="mb-3 text-sm text-muted">No suppliers linked yet.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {detail.supplierLinks.map((l) => (
              <li key={l.id} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{l.supplier.name}</span>
                  {l.preferred && <StatusPill>Preferred</StatusPill>}
                </div>
                {l.quotedUnitCost != null ? (
                  <p className="mt-1 font-mono text-xs text-muted">
                    {l.currency} {l.quotedUnitCost}
                    {l.quotedDate && ` · ${new Date(l.quotedDate).toISOString().slice(0, 10)}`}
                    {l.quoteSource && ` · ${l.quoteSource}`}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted">No quoted cost on this link.</p>
                )}
                {l.supplier.leadTime && (
                  <p className="mt-0.5 text-xs text-muted">Lead time: {l.supplier.leadTime}</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <LinkSupplierForm
          partId={partId}
          onDone={() => {
            load();
            onChanged();
          }}
        />
      </div>
    </div>
  );
}

function LinkSupplierForm({ partId, onDone }: { partId: string; onDone: () => void }) {
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [cost, setCost] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [quotedDate, setQuotedDate] = useState("");
  const [quoteSource, setQuoteSource] = useState("");
  const [preferred, setPreferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/cad/suppliers")
      .then((r) => r.json())
      .then((b) => setSuppliers((b?.suppliers ?? []) as SupplierRow[]))
      .catch(() => setSuppliers([]));
  }, []);

  const submit = async () => {
    if (!supplierId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/parts/${partId}/suppliers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          supplierId,
          quotedUnitCost: cost.trim() === "" ? null : Number(cost),
          currency,
          quotedDate: quotedDate || null,
          quoteSource: quoteSource.trim() || null,
          preferred,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not link the supplier.");
      setCost("");
      setQuotedDate("");
      setQuoteSource("");
      setPreferred(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link the supplier.");
    } finally {
      setBusy(false);
    }
  };

  const field = "h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink";

  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <p className="mb-2 text-xs font-semibold text-ink">Link a supplier</p>
      <div className="grid gap-2">
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={field} aria-label="Supplier">
          <option value="">Choose a supplier</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            placeholder="Quoted unit cost"
            inputMode="decimal"
            className={`${field} font-mono`}
            aria-label="Quoted unit cost"
          />
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            placeholder="USD"
            maxLength={3}
            className={`${field} font-mono`}
            aria-label="Currency"
          />
        </div>
        <input
          type="date"
          value={quotedDate}
          onChange={(e) => setQuotedDate(e.target.value)}
          className={field}
          aria-label="Quoted date"
        />
        <input
          value={quoteSource}
          onChange={(e) => setQuoteSource(e.target.value)}
          placeholder="Quote source — who said this price (required with a cost)"
          className={field}
          aria-label="Quote source"
        />
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={preferred}
            onChange={(e) => setPreferred(e.target.checked)}
          />
          Mark as preferred supplier
        </label>
      </div>
      {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
      <button
        type="button"
        onClick={submit}
        disabled={busy || !supplierId}
        className="mt-2 flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Link supplier
      </button>
    </div>
  );
}

const CATEGORIES = [
  "mechanical",
  "electrical",
  "fastener",
  "pcb",
  "cable",
  "tooling",
  "consumable",
  "other",
];

function CreatePartForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [category, setCategory] = useState("other");
  const [onHandQty, setOnHandQty] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [unitOfMeasure, setUnitOfMeasure] = useState("pcs");
  const [storageLocation, setStorageLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cad/parts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          sku: sku.trim() || null,
          category,
          onHandQty: onHandQty.trim() === "" ? 0 : Number(onHandQty),
          reorderPoint: reorderPoint.trim() === "" ? 0 : Number(reorderPoint),
          unitOfMeasure: unitOfMeasure.trim() || "pcs",
          storageLocation: storageLocation.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not create the part.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the part.");
    } finally {
      setBusy(false);
    }
  };

  const field = "h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink";

  return (
    <div className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-name">Part name</label>
          <input id="hw-part-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Carbon arm 220mm" className={field} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-sku">SKU / MPN</label>
          <input id="hw-part-sku" value={sku} onChange={(e) => setSku(e.target.value)} placeholder="CA-220" className={`${field} font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-cat">Category</label>
          <select id="hw-part-cat" value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-onhand">Opening on-hand</label>
          <input id="hw-part-onhand" value={onHandQty} onChange={(e) => setOnHandQty(e.target.value)} placeholder="0" inputMode="decimal" className={`${field} font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-reorder">Reorder point</label>
          <input id="hw-part-reorder" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} placeholder="0" inputMode="decimal" className={`${field} font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-uom">Unit of measure</label>
          <input id="hw-part-uom" value={unitOfMeasure} onChange={(e) => setUnitOfMeasure(e.target.value)} placeholder="pcs" className={field} />
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-part-loc">Storage location</label>
          <input id="hw-part-loc" value={storageLocation} onChange={(e) => setStorageLocation(e.target.value)} placeholder="bin A-3" className={field} />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">
        The opening on-hand is recorded as an "opening balance" audit event.
      </p>
      {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-10 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !name.trim()}
          className="flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Add part
        </button>
      </div>
    </div>
  );
}
