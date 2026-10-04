// ShapesOS — Phase 13 (twinui): the "Edit layout" mode (editor role and up).
// A palette of object kinds (pick one, click the ground to place it on the
// snapped grid), and for the selected object: label, position, size, rotate
// 90°, delete, and a searchable binding picker (locations of the site's
// warehouse by code/path filtered by kind, work centres, registers,
// products). Every write goes through TWIN_API.objects (generic ops CRUD)
// with the gated-write UI; server validation errors (overlaps, bindings in
// another workspace…) show inline.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Building2,
  Columns3,
  DoorOpen,
  Footprints,
  Forklift,
  Grid2x2,
  Link2,
  LayoutGrid,
  ParkingSquare,
  RotateCw,
  Search,
  Trash2,
  Wrench,
  Calculator,
  type LucideIcon,
} from "lucide-react";
import type { TwinBindingType, TwinFootprint, TwinObject, TwinObjectKind, TwinSnapshot } from "@/lib/twin/types";
import { TWIN_BINDABLE, TWIN_OBJECT_KINDS } from "@/lib/twin/types";
import { BINDING_LABEL, KIND_LABEL } from "@/lib/twin/view-model";
import { clampFootprint, rotateFootprint } from "@/lib/twin/scene-kit";
import { LOCATION_KINDS_FOR, overlapWith } from "@/lib/twin/derive";
import { TWIN_SLUGS, createObjectBody, deleteObject, patchObjectBody } from "@/lib/twin/client-api";
import { useGatedWrite } from "@/components/ops/shared";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import { btnDenySm, btnGhostSm, btnPrimarySm, errorBoxCls, inputCls, labelCls, noteBoxCls } from "@/components/crm/ui";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<TwinObjectKind, LucideIcon> = {
  building: Building2,
  dock_door: DoorOpen,
  rack: Columns3,
  bin_zone: Grid2x2,
  yard_slot: ParkingSquare,
  work_center: Wrench,
  register: Calculator,
  shelf: LayoutGrid,
  path: Footprints,
  equipment: Forklift,
};

/** Sensible default sizes (w × d × h metres) for a new object. */
export const DEFAULT_SIZE: Record<TwinObjectKind, { w: number; d: number; h: number }> = {
  building: { w: 12, d: 8, h: 5 },
  dock_door: { w: 4, d: 1, h: 4 },
  rack: { w: 8, d: 1, h: 5 },
  bin_zone: { w: 4, d: 3, h: 1 },
  yard_slot: { w: 4, d: 10, h: 1 },
  work_center: { w: 4, d: 4, h: 3 },
  register: { w: 2, d: 1, h: 1 },
  shelf: { w: 6, d: 1, h: 2 },
  path: { w: 10, d: 2, h: 1 },
  equipment: { w: 1, d: 2, h: 2 },
};

export type Placing = { kind: TwinObjectKind; w: number; d: number } | null;

/** The layout writes shared by the editor panel and the canvas (place, drag). */
export function useLayoutWrites(snapshot: TwinSnapshot, resync: () => Promise<unknown>) {
  const done = useCallback(() => void resync(), [resync]);
  const create = useGatedWrite(TWIN_SLUGS.objects, "POST", done);
  const patch = useGatedWrite(TWIN_SLUGS.objects, "PATCH", done);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const place = useCallback(
    async (kind: TwinObjectKind, cell: { x: number; z: number }) => {
      const size = DEFAULT_SIZE[kind];
      const n = snapshot.objects.filter((o) => o.kind === kind).length + 1;
      const footprint = clampFootprint({ x: cell.x, z: cell.z, ...size, rotation: 0 }, snapshot.site);
      await create.request(createObjectBody(snapshot.site.id, { kind, label: `${KIND_LABEL[kind]} ${n}`, footprint, binding: null }), `place ${KIND_LABEL[kind].toLowerCase()} at ${footprint.x}, ${footprint.z}`);
    },
    [create, snapshot.objects, snapshot.site],
  );

  const move = useCallback(
    async (o: TwinObject, footprint: TwinFootprint) => {
      await patch.request(patchObjectBody(o.id, { footprint: { x: footprint.x, z: footprint.z } }), `move ${o.label} to ${footprint.x}, ${footprint.z}`);
      await resync(); // refused or gated → the object snaps back to the server's footprint
    },
    [patch, resync],
  );

  const remove = useCallback(
    async (o: TwinObject) => {
      setDeleting(true);
      setDeleteError(null);
      try {
        await deleteObject(o.id);
        await resync();
        return true;
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : "Could not delete the object.");
        return false;
      } finally {
        setDeleting(false);
      }
    },
    [resync],
  );

  return { create, patch, place, move, remove, deleting, deleteError };
}

type Writes = ReturnType<typeof useLayoutWrites>;

function GateBlock({ gate, label }: { gate: Writes["create"]; label: string }) {
  return (
    <>
      {gate.error && (
        <div className={cn(errorBoxCls, "flex items-start gap-2")} role="alert">
          <span aria-hidden className="mt-1 inline-block h-2 w-2 shrink-0 bg-failed" />
          {gate.error}
        </div>
      )}
      {gate.pending && (
        <OpsApprovalCard
          pending={gate.pending}
          busy={gate.busy}
          executeLabel={label}
          onApprove={() => gate.decide("approved")}
          onDeny={() => gate.decide("denied")}
          onExecute={gate.execute}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Binding picker
// ---------------------------------------------------------------------------

interface Candidate {
  id: string;
  label: string;
  hint: string;
}

async function loadCandidates(type: TwinBindingType, kind: TwinObjectKind, warehouseId: string): Promise<Candidate[]> {
  const get = async (url: string) => {
    const r = await fetch(url);
    const d = (await r.json().catch(() => ({}))) as { rows?: Record<string, unknown>[]; error?: string };
    if (!r.ok) throw new Error(d.error ?? "Could not load records.");
    return d.rows ?? [];
  };
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (type) {
    case "location": {
      const rows = await get(`/api/ops/locations?limit=200&warehouseId=${encodeURIComponent(warehouseId)}`);
      const kinds = LOCATION_KINDS_FOR[kind];
      return rows
        .filter((r) => !kinds || kinds.includes(s(r.kind)))
        .map((r) => ({ id: s(r.id), label: s(r.path) || s(r.code), hint: [s(r.kind), s(r.name)].filter(Boolean).join(" · ") }));
    }
    case "work_center":
      return (await get("/api/ops/work-centers?limit=200")).map((r) => ({ id: s(r.id), label: s(r.name), hint: s(r.code) }));
    case "register":
      return (await get("/api/ops/pos-registers?limit=200")).map((r) => ({ id: s(r.id), label: s(r.name), hint: r.active === false ? "inactive" : "" }));
    case "product":
      return (await get("/api/ops/products?limit=200")).map((r) => ({ id: s(r.id), label: s(r.name), hint: s(r.sku) }));
  }
}

function BindingPicker({ o, warehouseId, gate }: { o: TwinObject; warehouseId: string; gate: Writes["patch"] }) {
  const types = TWIN_BINDABLE[o.kind];
  const [type, setType] = useState<TwinBindingType | null>(types[0] ?? null);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!type) return;
    let live = true;
    setRows(null);
    setError(null);
    loadCandidates(type, o.kind, warehouseId)
      .then((r) => live && setRows(r))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load records."));
    return () => {
      live = false;
    };
  }, [type, o.kind, warehouseId]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => !t || r.label.toLowerCase().includes(t) || r.hint.toLowerCase().includes(t)).slice(0, 30);
  }, [rows, q]);
  if (!type) return <p className="text-xs text-muted">{KIND_LABEL[o.kind]}s aren&rsquo;t bound to a record.</p>;
  return (
    <div className="flex flex-col gap-2">
      {types.length > 1 && (
        <div role="group" aria-label="Bind to" className="inline-flex gap-1">
          {types.map((t) => (
            <button key={t} type="button" aria-pressed={t === type} onClick={() => setType(t)} className={cn("h-8 rounded-full px-3 text-sm font-semibold", t === type ? "bg-ink text-paper" : "bg-paper text-ink shadow-control")}>
              {BINDING_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input className={cn(inputCls, "w-full pl-8")} placeholder={`Find a ${BINDING_LABEL[type].toLowerCase()}…`} aria-label={`Find a ${BINDING_LABEL[type].toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="text-xs text-failed-text">{error}</p>}
      {rows === null && !error ? <p className="text-xs text-muted">Loading…</p> : null}
      {rows && shown.length === 0 ? <p className="text-xs text-muted">No {BINDING_LABEL[type].toLowerCase()}s match. Create one in its ops page first.</p> : null}
      <ul className="max-h-44 overflow-y-auto rounded-md border border-line">
        {shown.map((r) => {
          const current = o.binding?.type === type && o.binding.id === r.id;
          return (
            <li key={r.id}>
              <button
                type="button"
                disabled={gate.busy || current}
                onClick={() => gate.request(patchObjectBody(o.id, { binding: { type, id: r.id } }), `bind ${o.label} to ${r.label}`)}
                className={cn("flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover-paper", current && "bg-hover-paper")}
              >
                <span className="aos-mono truncate text-xs text-ink">{r.label}</span>
                <span className="shrink-0 text-xs text-muted">{current ? "Bound" : r.hint}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {o.binding && (
        <button type="button" className={cn(btnGhostSm, "self-start")} disabled={gate.busy} onClick={() => gate.request(patchObjectBody(o.id, { binding: null }), `unbind ${o.label}`)}>
          Unbind
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor panel
// ---------------------------------------------------------------------------

function NumberField({ label, value, onChange, min = 0 }: { label: string; value: number; onChange: (n: number) => void; min?: number }) {
  return (
    <label className="flex flex-col">
      <span className={labelCls}>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        step={1}
        className={cn(inputCls, "w-full tabular-nums")}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
    </label>
  );
}

function ObjectForm({ o, snapshot, writes, onDeleted }: { o: TwinObject; snapshot: TwinSnapshot; writes: Writes; onDeleted: () => void }) {
  const [label, setLabel] = useState(o.label);
  const [fp, setFp] = useState<TwinFootprint>(o.footprint);
  useEffect(() => {
    setLabel(o.label);
    setFp(o.footprint);
  }, [o.label, o.footprint]);
  const clamped = clampFootprint(fp, snapshot.site);
  // Same rule the server applies (lib/twin/derive.ts): only paths and equipment may overlap.
  const clash = overlapWith({ id: o.id, kind: o.kind, label: o.label, footprint: clamped }, snapshot.objects);
  const dirty = label.trim() !== o.label || JSON.stringify(clamped) !== JSON.stringify(o.footprint);
  const set = (k: keyof TwinFootprint) => (n: number) => setFp({ ...fp, [k]: n });
  const gate = writes.patch;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void gate.request(patchObjectBody(o.id, { label: label.trim(), footprint: clamped }), `update ${o.label}`);
      }}
    >
      <label className="flex flex-col">
        <span className={labelCls}>Label</span>
        <input className={cn(inputCls, "w-full")} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} required />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="X (m)" value={fp.x} onChange={set("x")} />
        <NumberField label="Z (m)" value={fp.z} onChange={set("z")} />
        <NumberField label="Height" value={fp.h} onChange={set("h")} min={1} />
        <NumberField label="Width" value={fp.w} onChange={set("w")} min={1} />
        <NumberField label="Depth" value={fp.d} onChange={set("d")} min={1} />
        <div className="flex flex-col">
          <span className={labelCls}>Turn</span>
          <button type="button" className={cn(btnGhostSm, "h-control-sm")} onClick={() => setFp(rotateFootprint(fp, snapshot.site))} aria-label={`Rotate 90°, now ${fp.rotation}°`}>
            <RotateCw size={13} /> {fp.rotation}°
          </button>
        </div>
      </div>
      {clash ? <p className="text-xs text-muted">Overlaps {clash.label} — the server will refuse overlapping objects.</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={btnPrimarySm} disabled={!dirty || gate.busy}>
          Save changes
        </button>
        <button
          type="button"
          className={btnDenySm}
          disabled={writes.deleting}
          onClick={async () => {
            if (await writes.remove(o)) onDeleted();
          }}
        >
          <Trash2 size={13} /> Delete
        </button>
      </div>
      {writes.deleteError && (
        <div className={errorBoxCls} role="alert">
          {writes.deleteError}
        </div>
      )}
      <div className="border-t border-line pt-3">
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Link2 size={14} aria-hidden /> Bound record
        </p>
        <p className="mb-2 text-xs text-muted">
          {o.binding ? (o.bindingBroken ? "Unbound — the record is gone." : `${BINDING_LABEL[o.binding.type]}: ${o.binding.label ?? o.binding.id}`) : "Not bound. Live state comes from the bound record."}
        </p>
        <BindingPicker key={o.id} o={o} warehouseId={snapshot.site.warehouseId} gate={gate} />
      </div>
    </form>
  );
}

export function TwinLayoutEditor({
  snapshot,
  selected,
  placing,
  onPlacing,
  writes,
  onDeselect,
  className,
}: {
  snapshot: TwinSnapshot;
  selected: TwinObject | null;
  placing: Placing;
  onPlacing: (p: Placing) => void;
  writes: Writes;
  onDeselect: () => void;
  className?: string;
}) {
  return (
    <aside aria-label="Layout editor" className={cn("flex min-h-0 flex-col rounded-lg bg-paper shadow-hairline", className)}>
      <div className="border-b border-line px-4 py-3">
        <h2 className="stretch-heading text-lg font-heading text-ink">Edit layout</h2>
        <p className="text-xs text-muted">Pick a kind, then click the ground to place it. Drag a selected object to move it; it snaps to the 1 m grid.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div role="group" aria-label="Object kinds" className="flex flex-wrap gap-1.5">
          {TWIN_OBJECT_KINDS.map((k) => {
            const Icon = KIND_ICON[k] ?? Box;
            const on = placing?.kind === k;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => onPlacing(on ? null : { kind: k, w: DEFAULT_SIZE[k].w, d: DEFAULT_SIZE[k].d })}
                className={cn("aos-press inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm font-semibold", on ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline")}
              >
                <Icon size={14} aria-hidden />
                {KIND_LABEL[k]}
              </button>
            );
          })}
        </div>
        {placing && <p className={cn(noteBoxCls, "mt-2")}>Click a free spot on the ground to place a {KIND_LABEL[placing.kind].toLowerCase()} ({placing.w} × {placing.d} m).</p>}
        <div className="mt-3 flex flex-col gap-2">
          <GateBlock gate={writes.create} label="Place the object" />
          <GateBlock gate={writes.patch} label="Save the layout change" />
          {writes.create.note && !writes.create.pending ? <p className={noteBoxCls}>Placed.</p> : null}
        </div>
        <div className="mt-3 border-t border-line pt-3">
          {selected ? (
            <>
              <p className="mb-2 text-xs font-semibold text-muted">
                Selected · {KIND_LABEL[selected.kind]}
              </p>
              <ObjectForm o={selected} snapshot={snapshot} writes={writes} onDeleted={onDeselect} />
            </>
          ) : (
            <p className="text-sm text-muted">Select an object to move, resize, rotate, bind or delete it.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
