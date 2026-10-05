// ShapesOS — Phase 13 (twinui): the digital twin's site list — a dense table
// (name, code, kind, status, objects, updated), "Add a sample site" (POST
// TWIN_API.sample with a kind: a site bound to real seeded ops records) and
// "New site" (POST TWIN_API.sites through the gated-write pattern).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Map as MapIcon, Plus, Sparkles } from "lucide-react";
import type { TwinSiteKind } from "@/lib/twin/types";
import { TWIN_API, TWIN_SITE_KINDS } from "@/lib/twin/types";
import { SITE_KIND_LABEL } from "@/lib/twin/view-model";
import { TWIN_SLUGS, createSiteBody, errorText } from "@/lib/twin/client-api";
import { MenuSurface, MenuRow } from "@/components/aos/Menu";
import { aosButton } from "@/components/aos/button";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import { btnGhost, btnPrimary, errorBoxCls, inputCls, labelCls, selectCls, tableCls, tableWrapCls, tdCls, thCls } from "@/components/crm/ui";
import { EmptyBlock, OpsModal, fmtDateTime, useGatedWrite, useOpsList } from "@/components/ops/shared";
import { cn } from "@/lib/utils";
import { SITE_ICON } from "./TwinTopBar";

export interface TwinSiteRow {
  id: string;
  kind: TwinSiteKind;
  status: "draft" | "published";
  name: string;
  code: string;
  objectCount: number;
  updatedAt: string;
}

/** The new site's id from whatever shape the create / sample endpoints answer with. */
function idFrom(data: unknown): string | null {
  const d = data as Record<string, unknown> | null;
  if (!d) return null;
  const pick = (v: unknown) => (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null);
  return (typeof d.siteId === "string" ? d.siteId : null) ?? pick(d.site) ?? pick(d.row) ?? (typeof d.id === "string" ? d.id : null);
}

function SampleMenu({ onError }: { onError: (m: string | null) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<TwinSiteKind | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const add = async (kind: TwinSiteKind) => {
    setOpen(false);
    setBusy(kind);
    onError(null);
    try {
      const r = await fetch(TWIN_API.sample, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
      if (!r.ok) throw new Error(await errorText(r, "Could not add the sample site."));
      const id = idFrom(await r.json().catch(() => null));
      if (id) router.push(`/dashboard/ops/twin/${encodeURIComponent(id)}`);
      else router.refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not add the sample site.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div ref={ref} className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" className={btnGhost} aria-haspopup="menu" aria-expanded={open} disabled={!!busy} onClick={() => setOpen((v) => !v)}>
        <Sparkles size={14} /> {busy ? `Adding a sample ${SITE_KIND_LABEL[busy].toLowerCase()}…` : "Add a sample site"} <ChevronDown size={14} />
      </button>
      {open && (
        <MenuSurface label="Sample sites" className="absolute right-0 top-10 z-40 w-72">
          {TWIN_SITE_KINDS.map((k) => (
            <MenuRow key={k} icon={SITE_ICON[k]} label={`Sample ${SITE_KIND_LABEL[k].toLowerCase()}`} hint="bound to seeded records" onClick={() => add(k)} />
          ))}
        </MenuSurface>
      )}
    </div>
  );
}

function NewSiteDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const warehouses = useOpsList<{ id: string; name: string; code: string }>("warehouses");
  const [f, setF] = useState({ kind: "warehouse" as TwinSiteKind, name: "", code: "", gridW: "48", gridD: "36", warehouseId: "" });
  useEffect(() => {
    if (!f.warehouseId && warehouses.rows[0]) setF((x) => ({ ...x, warehouseId: warehouses.rows[0]!.id }));
  }, [warehouses.rows, f.warehouseId]);
  const done = useCallback(
    (row: Record<string, unknown>) => {
      const id = idFrom({ row });
      if (id) router.push(`/dashboard/ops/twin/${encodeURIComponent(id)}?edit=1`);
      else router.refresh();
    },
    [router],
  );
  const gate = useGatedWrite(TWIN_SLUGS.sites, "POST", done);
  const w = Number(f.gridW);
  const d = Number(f.gridD);
  const valid = f.name.trim() && f.code.trim() && f.warehouseId && Number.isInteger(w) && Number.isInteger(d) && w >= 4 && d >= 4 && w <= 400 && d <= 400;
  return (
    <OpsModal title="New site" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void gate.request(createSiteBody({ kind: f.kind, name: f.name.trim(), code: f.code.trim(), gridW: w, gridD: d, warehouseId: f.warehouseId }), `new ${f.kind} site ${f.code}`);
        }}
      >
        {gate.error && <div className={errorBoxCls}>{gate.error}</div>}
        {gate.pending && (
          <OpsApprovalCard pending={gate.pending} busy={gate.busy} executeLabel="Create site" onApprove={() => gate.decide("approved")} onDeny={() => gate.decide("denied")} onExecute={gate.execute} />
        )}
        <label>
          <span className={labelCls}>Kind</span>
          <select className={cn(selectCls, "w-full")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TwinSiteKind })}>
            {TWIN_SITE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SITE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <label>
            <span className={labelCls}>Name</span>
            <input className={cn(inputCls, "w-full")} value={f.name} placeholder="Riverside warehouse" onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            <span className={labelCls}>Code</span>
            <input className={cn(inputCls, "aos-mono w-full")} value={f.code} placeholder="WH-04" onChange={(e) => setF({ ...f, code: e.target.value })} required />
          </label>
        </div>
        <label>
          <span className={labelCls}>Warehouse (its locations are what racks, bins and docks bind to)</span>
          <select className={cn(selectCls, "w-full")} value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })} required>
            {warehouses.rows.length === 0 ? <option value="">{warehouses.loading ? "Loading…" : "No warehouses — add one in Products & inventory"}</option> : null}
            {warehouses.rows.map((wh) => (
              <option key={wh.id} value={wh.id}>
                {wh.name} ({wh.code})
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={labelCls}>Width (m, east–west)</span>
            <input className={cn(inputCls, "w-full")} inputMode="numeric" value={f.gridW} onChange={(e) => setF({ ...f, gridW: e.target.value })} />
          </label>
          <label>
            <span className={labelCls}>Depth (m, north–south)</span>
            <input className={cn(inputCls, "w-full")} inputMode="numeric" value={f.gridD} onChange={(e) => setF({ ...f, gridD: e.target.value })} />
          </label>
        </div>
        <p className="text-xs text-muted">The site starts as a draft: lay it out, then publish it.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={!valid || gate.busy}>
            {gate.busy ? "Creating" : "Create site"}
          </button>
        </div>
      </form>
    </OpsModal>
  );
}

export function TwinSitesList({ sites, canEdit, canAddSample = false, loadError }: { sites: TwinSiteRow[]; canEdit: boolean; canAddSample?: boolean; loadError?: string | null }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="stretch-heading text-xl font-heading text-ink">Digital twin</h2>
          <p className="mt-0.5 text-sm text-muted">Your warehouses, factories and stores as live 3D sites, drawn from ShapesOS records.</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {canAddSample ? <SampleMenu onError={setError} /> : null}
            <button type="button" className={aosButton({ size: "sm" })} onClick={() => setCreating(true)}>
              <Plus size={15} /> New site
            </button>
          </div>
        )}
      </div>
      {(error || loadError) && <div className={errorBoxCls}>{error ?? loadError}</div>}
      {sites.length === 0 ? (
        <EmptyBlock
          icon={MapIcon}
          title="No sites yet"
          hint={canAddSample ? "Add a sample site to see a warehouse, factory or store in 3D, or start a new one from a warehouse." : canEdit ? "Start a new site from one of your warehouses." : "An editor can add the first site."}
        />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Site</th>
                <th className={thCls}>Code</th>
                <th className={thCls}>Kind</th>
                <th className={thCls}>Status</th>
                <th className={cn(thCls, "text-right")}>Objects</th>
                <th className={thCls}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => {
                const Icon = SITE_ICON[s.kind];
                return (
                  <tr key={s.id} className="hover:bg-hover-paper">
                    <td className={tdCls}>
                      <Link href={`/dashboard/ops/twin/${encodeURIComponent(s.id)}`} className="inline-flex items-center gap-2 font-semibold text-ink hover:underline">
                        <Icon size={15} aria-hidden /> {s.name}
                      </Link>
                    </td>
                    <td className={cn(tdCls, "aos-mono text-xs")}>{s.code}</td>
                    <td className={tdCls}>{SITE_KIND_LABEL[s.kind]}</td>
                    <td className={tdCls}>
                      <span className="inline-flex h-6 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">{s.status === "draft" ? "Draft" : "Published"}</span>
                    </td>
                    <td className={cn(tdCls, "text-right tabular-nums")}>{s.objectCount}</td>
                    <td className={cn(tdCls, "text-muted")}>{fmtDateTime(s.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewSiteDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
