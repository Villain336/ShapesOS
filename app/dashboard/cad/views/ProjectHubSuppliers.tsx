"use client";

// Marketr — CAD + Hardware slice 4: project hub suppliers.
// Supplier tracking: who they are, lead times, and their quoted costs on
// linked parts. Deleting a supplier with linked parts fails closed —
// unlink first, explicitly, so cost lineage never disappears silently.

import { useCallback, useEffect, useState } from "react";
import { Plus, Loader2, Trash2 } from "lucide-react";
import { ErrorNote, LoadingNote, StatusPill } from "./ProjectHubTab";
import { confirmAction } from "@/lib/ui/feedback";

interface SupplierRow {
  id: string;
  name: string;
  contact: string | null;
  leadTime: string | null;
  notes: string | null;
  _count: { partLinks: number };
}

interface SupplierDetail {
  supplier: SupplierRow;
  partLinks: {
    id: string;
    preferred: boolean;
    quotedUnitCost: number | null;
    currency: string;
    quotedDate: string | null;
    quoteSource: string | null;
    part: { id: string; name: string; sku: string | null; onHandQty: number; unitOfMeasure: string };
  }[];
}

export function ProjectHubSuppliers({ projectId }: { projectId: string }) {
  void projectId; // suppliers are tenant-level; the hub gives them a home per project.
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cad/suppliers");
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load suppliers.");
      setSuppliers(body.suppliers as SupplierRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load suppliers.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add supplier
        </button>
      </div>

      {showCreate && (
        <CreateSupplierForm
          onDone={() => {
            setShowCreate(false);
            load();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {loading ? (
        <LoadingNote label="Loading suppliers" />
      ) : error ? (
        <ErrorNote message={error} />
      ) : suppliers.length === 0 ? (
        <p className="text-sm text-muted">
          No suppliers yet. Add one, then link it to parts with its quoted
          costs from the inventory tab.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2.5">Supplier</th>
                <th className="px-3 py-2.5">Contact</th>
                <th className="px-3 py-2.5">Lead time</th>
                <th className="px-3 py-2.5">Linked parts</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <SupplierRowView
                  key={s.id}
                  supplier={s}
                  open={openId === s.id}
                  onToggle={() => setOpenId((o) => (o === s.id ? null : s.id))}
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

function SupplierRowView({
  supplier,
  open,
  onToggle,
  onChanged,
}: {
  supplier: SupplierRow;
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
            {supplier.name}
          </button>
          {supplier.notes && (
            <p className="mt-0.5 max-w-md truncate text-xs text-muted">{supplier.notes}</p>
          )}
        </td>
        <td className="px-3 py-2.5 text-sm text-muted">{supplier.contact ?? "—"}</td>
        <td className="px-3 py-2.5 text-sm text-muted">{supplier.leadTime ?? "—"}</td>
        <td className="px-3 py-2.5 font-mono text-xs text-muted">{supplier._count.partLinks}</td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-canvas">
          <td colSpan={4} className="px-3 py-3">
            <SupplierDetailView supplierId={supplier.id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function SupplierDetailView({ supplierId, onChanged }: { supplierId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/suppliers/${supplierId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load the supplier.");
      setDetail(body as SupplierDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the supplier.");
    } finally {
      setLoading(false);
    }
  }, [supplierId]);

  useEffect(() => {
    load();
  }, [load]);

  const deleteSupplier = async () => {
    if (!await confirmAction("Delete this supplier? Linked parts must be unlinked first.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/suppliers/${supplierId}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not delete the supplier.");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the supplier.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingNote label="Loading the supplier" />;
  if (error || !detail) return <ErrorNote message={error ?? "Could not load the supplier."} />;

  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-ink">Linked parts & quotes</h4>
      {detail.partLinks.length === 0 ? (
        <p className="mb-3 text-sm text-muted">
          No parts linked. Link parts with quoted costs from the inventory tab.
        </p>
      ) : (
        <ul className="mb-3 space-y-2">
          {detail.partLinks.map((l) => (
            <li key={l.id} className="rounded-lg border border-line bg-paper p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{l.part.name}</span>
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
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={deleteSupplier}
        disabled={busy}
        className="flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-ink)] disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Delete supplier
      </button>
    </div>
  );
}

function CreateSupplierForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [leadTime, setLeadTime] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cad/suppliers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          contact: contact.trim() || null,
          leadTime: leadTime.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not create the supplier.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the supplier.");
    } finally {
      setBusy(false);
    }
  };

  const field = "h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink";

  return (
    <div className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-sup-name">Supplier name</label>
          <input id="hw-sup-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Composites" className={field} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-sup-contact">Contact</label>
          <input id="hw-sup-contact" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Sales rep, phone, email" className={field} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-sup-lead">Lead time</label>
          <input id="hw-sup-lead" value={leadTime} onChange={(e) => setLeadTime(e.target.value)} placeholder="2–3 weeks" className={field} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-sup-notes">Notes</label>
          <input id="hw-sup-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="MOQ, quality notes" className={field} />
        </div>
      </div>
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
          Add supplier
        </button>
      </div>
    </div>
  );
}
