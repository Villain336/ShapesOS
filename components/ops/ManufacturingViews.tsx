// ShapesOS Phase 12 (mfgpos) — /dashboard/ops/manufacturing: manufacturing
// orders, work orders (timer + time log), work centres, routings (with the
// CAD part ↔ product links the BOM is consumed through) and scrap. Reads and
// writes go through the generic /api/ops/{entity} route (rules in
// lib/ops/mfg/service.ts); confirm, complete and scrap are gated writes
// (propose → approve → execute, OpsApprovalCard). MO / work-order states
// are workflow states: neutral chips, never the agent status colours.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ClipboardList,
  Factory,
  Link2,
  Loader2,
  PackageX,
  Pause,
  Play,
  Plus,
  Route,
  Timer,
  Wrench,
} from "lucide-react";
import {
  btnGhost,
  btnGhostSm,
  btnPrimary,
  btnPrimarySm,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  trClickableCls,
} from "@/components/crm/ui";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import {
  EmptyBlock,
  LoadingLine,
  OpsModal,
  OpsSlideOver,
  ViewHeader,
  fmtCents,
  fmtDate,
  fmtDateTime,
  opsJson,
  sentence,
  toCents,
  useGatedPatch,
  useGatedWrite,
  useOpsList,
} from "./shared";
import { SubTabs } from "./SubTabs";

// ---------------------------------------------------------------------------
// Row shapes (as the generic route returns them)
// ---------------------------------------------------------------------------

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  trackInventory: boolean;
  stockQty: number;
}
interface LocationRow {
  id: string;
  path: string;
  active: boolean;
}
interface WorkCenterRow {
  id: string;
  name: string;
  code: string;
  capacity: number;
  hourlyCostCents: number;
  locationId: string | null;
  active: boolean;
}
interface Operation {
  sequence: number;
  name: string;
  workCenterId: string;
  plannedMinutes: number;
}
interface RoutingRow {
  id: string;
  productId: string;
  bomVersionId: string | null;
  name: string;
  operations: Operation[];
  active: boolean;
}
interface Component {
  bomLineId: string;
  productId: string | null;
  name: string;
  sku: string | null;
  qtyPerUnit: number;
  unitCostCents: number;
  stocked: boolean;
  consumedQty?: number;
}
interface MoRow {
  id: string;
  number: string | null;
  productId: string;
  qty: number;
  status: string;
  routingId: string | null;
  bomVersionId: string | null;
  componentLocationId: string | null;
  finishedLocationId: string | null;
  components: Component[];
  plannedStart: string | null;
  plannedCostCents: number | null;
  producedQty: number;
  scrappedQty: number;
  componentCostCents: number;
  labourCostCents: number;
  scrapCostCents: number;
  finishedCostCents: number;
  note: string | null;
  createdAt: string;
  doneAt: string | null;
}
interface WorkOrderRow {
  id: string;
  moId: string;
  sequence: number;
  name: string;
  workCenterId: string;
  plannedMinutes: number;
  status: string;
  actualSeconds: number;
  runningSince: string | null;
}
interface ScrapRow {
  id: string;
  productId: string;
  qty: number;
  locationId: string | null;
  moId: string | null;
  reason: string;
  totalCostCents: number;
  journalEntryId: string | null;
  createdAt: string;
}
interface CadCatalog {
  parts: Array<{ id: string; name: string; sku: string | null; opsProductId: string | null }>;
  bomVersions: Array<{ id: string; label: string; lineCount: number }>;
}

const MO_STATUSES = ["draft", "confirmed", "in_progress", "done", "cancelled"];

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

function moLabel(mo: Pick<MoRow, "number" | "id">): string {
  return mo.number ?? `Draft ${mo.id.slice(-6).toUpperCase()}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function liveSeconds(w: WorkOrderRow, now: number): number {
  return w.actualSeconds + (w.status === "in_progress" && w.runningSince ? Math.max(0, Math.floor((now - new Date(w.runningSince).getTime()) / 1000)) : 0);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ManufacturingWorkspace() {
  const tabs = useMemo(
    () => [
      { id: "orders", label: "Manufacturing orders", icon: Factory, render: () => <MoListView /> },
      { id: "work-orders", label: "Work orders", icon: Timer, render: () => <WorkOrdersView /> },
      { id: "work-centres", label: "Work centres", icon: Wrench, render: () => <WorkCentersView /> },
      { id: "routings", label: "Routings and BOM", icon: Route, render: () => <RoutingsView /> },
      { id: "scrap", label: "Scrap", icon: PackageX, render: () => <ScrapView /> },
    ],
    [],
  );
  return <SubTabs tabs={tabs} ariaLabel="Manufacturing views" />;
}

// ---------------------------------------------------------------------------
// Manufacturing orders
// ---------------------------------------------------------------------------

function MoListView() {
  const [status, setStatus] = useState("");
  const { rows, loading, error, reload } = useOpsList<MoRow>("manufacturing-orders", { status: status || undefined });
  const { rows: products } = useOpsList<ProductRow>("products");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const P = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Manufacturing orders" hint="Make products from their CAD bill of materials. Confirming and completing ask for approval; completion moves stock and posts the cost.">
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {MO_STATUSES.map((s) => (
            <option key={s} value={s}>
              {sentence(s)}
            </option>
          ))}
        </select>
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <Plus size={14} /> New order
        </button>
      </ViewHeader>
      {error && <div className={errorBoxCls}>{error}</div>}
      {loading ? (
        <LoadingLine label="Loading manufacturing orders" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={Factory} title="No manufacturing orders yet" hint="Create one to make a product from its routing and CAD bill of materials." />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Order</th>
                <th className={thCls}>Product</th>
                <th className={`${thCls} text-right`}>Qty</th>
                <th className={thCls}>Status</th>
                <th className={`${thCls} text-right`}>Produced</th>
                <th className={`${thCls} text-right`}>Planned cost</th>
                <th className={`${thCls} text-right`}>Actual cost</th>
                <th className={thCls}>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={trClickableCls} onClick={() => setSelectedId(m.id)}>
                  <td className={`${tdCls} font-mono text-[12px]`}>{moLabel(m)}</td>
                  <td className={tdCls}>{P.get(m.productId)?.name ?? m.productId}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{m.qty}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{sentence(m.status)}</span>
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>
                    {m.status === "done" ? `${m.producedQty}${m.scrappedQty ? ` (+${m.scrappedQty} scrap)` : ""}` : "—"}
                  </td>
                  <td className={`${tdCls} text-right tabular-nums text-muted`}>{fmtCents(m.plannedCostCents)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{m.status === "done" ? fmtCents(m.componentCostCents + m.labourCostCents) : "—"}</td>
                  <td className={`${tdCls} text-muted`}>{fmtDate(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && <MoDetail mo={selected} product={P.get(selected.productId)} onClose={() => setSelectedId(null)} onChanged={reload} />}
      {showNew && <NewMoModal products={products} onClose={() => setShowNew(false)} onCreated={reload} />}
    </div>
  );
}

function NewMoModal({ products, onClose, onCreated }: { products: ProductRow[]; onClose: () => void; onCreated: () => void }) {
  const { rows: locations } = useOpsList<LocationRow>("locations");
  const { rows: routings } = useOpsList<RoutingRow>("routings");
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [routingId, setRoutingId] = useState("");
  const [fromLoc, setFromLoc] = useState("");
  const [toLoc, setToLoc] = useState("");
  const [start, setStart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const makeable = products.filter((p) => p.trackInventory);
  const forProduct = routings.filter((r) => r.productId === productId && r.active);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/manufacturing-orders", "POST", {
        productId,
        qty: Number(qty),
        ...(routingId ? { routingId } : {}),
        ...(fromLoc ? { componentLocationId: fromLoc } : {}),
        ...(toLoc ? { finishedLocationId: toLoc } : {}),
        ...(start ? { plannedStart: new Date(start).toISOString() } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the order.");
    } finally {
      setBusy(false);
    }
  };
  const ok = productId && Number.isInteger(Number(qty)) && Number(qty) >= 1;
  return (
    <OpsModal title="New manufacturing order" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <label>
          <span className={labelCls}>Product to make</span>
          <select className={`${selectCls} w-full`} value={productId} onChange={(e) => { setProductId(e.target.value); setRoutingId(""); }}>
            <option value="">Choose a product</option>
            {makeable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={labelCls}>Quantity</span>
            <input className={`${inputCls} w-full`} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label>
            <span className={labelCls}>Routing</span>
            <select className={`${selectCls} w-full`} value={routingId} onChange={(e) => setRoutingId(e.target.value)} disabled={!productId}>
              <option value="">{forProduct.length ? "Active routing (default)" : "No routing — components only"}</option>
              {forProduct.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={labelCls}>Take components from</span>
            <select className={`${selectCls} w-full`} value={fromLoc} onChange={(e) => setFromLoc(e.target.value)}>
              <option value="">Unlocated stock</option>
              {locations.filter((l) => l.active).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={labelCls}>Put finished goods in</span>
            <select className={`${selectCls} w-full`} value={toLoc} onChange={(e) => setToLoc(e.target.value)}>
              <option value="">Unlocated stock</option>
              {locations.filter((l) => l.active).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span className={labelCls}>Planned start (optional)</span>
          <input type="date" className={`${inputCls} w-full`} value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={!ok || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {busy ? "Creating" : "Create draft"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

function MoDetail({ mo, product, onClose, onChanged }: { mo: MoRow; product?: ProductRow; onClose: () => void; onChanged: () => void }) {
  const done = useCallback(() => onChanged(), [onChanged]);
  const gate = useGatedPatch("manufacturing-orders", done);
  const [derived, setDerived] = useState<Component[] | null>(null);
  const [completing, setCompleting] = useState(false);
  const [produced, setProduced] = useState(String(mo.qty));
  const [scrapped, setScrapped] = useState("0");
  useEffect(() => {
    if (mo.status !== "draft") return;
    let live = true;
    fetch(`/api/ops/manufacturing/bom?productId=${encodeURIComponent(mo.productId)}`)
      .then((r) => r.json())
      .then((d) => live && setDerived((d.bom?.components ?? []) as Component[]))
      .catch(() => live && setDerived([]));
    return () => {
      live = false;
    };
  }, [mo.status, mo.productId]);
  const components = mo.status === "draft" ? derived : mo.components;
  const summary = `${moLabel(mo)}: ${mo.qty} × ${product?.name ?? mo.productId}.`;
  const p = Number(produced);
  const s = Number(scrapped);
  const qtyOk = Number.isInteger(p) && Number.isInteger(s) && p >= 0 && s >= 0 && p + s >= 1 && p + s <= mo.qty;

  return (
    <OpsSlideOver
      title={
        <>
          {moLabel(mo)} <span className={chipCls}>{sentence(mo.status)}</span>
        </>
      }
      meta={`${mo.qty} × ${product?.name ?? mo.productId} · created ${fmtDate(mo.createdAt)}${mo.plannedStart ? ` · planned ${fmtDate(mo.plannedStart)}` : ""}`}
      onClose={onClose}
    >
      {gate.error && <div className={`${errorBoxCls} mb-3`}>{gate.error}</div>}
      {gate.note && <div className={`${noteBoxCls} mb-3`}>{gate.note}</div>}
      {gate.pending && (
        <OpsApprovalCard
          pending={gate.pending}
          busy={gate.busy}
          executeLabel={gate.pending.actionLabel}
          onApprove={() => gate.decide("approved")}
          onDeny={() => gate.decide("denied")}
          onExecute={gate.execute}
        />
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {mo.status === "draft" && (
          <button type="button" className={btnPrimary} disabled={gate.busy} onClick={() => gate.request({ id: mo.id, status: "confirmed" }, summary)}>
            <CheckCircle2 size={14} /> Confirm order
          </button>
        )}
        {mo.status === "confirmed" && (
          <button type="button" className={btnGhost} disabled={gate.busy} onClick={() => gate.request({ id: mo.id, status: "in_progress" }, summary)}>
            <Play size={14} /> Start
          </button>
        )}
        {(mo.status === "confirmed" || mo.status === "in_progress") && (
          <button type="button" className={btnPrimary} disabled={gate.busy} onClick={() => setCompleting((v) => !v)}>
            <ClipboardList size={14} /> Complete…
          </button>
        )}
        {["draft", "confirmed", "in_progress"].includes(mo.status) && (
          <button type="button" className={btnGhost} disabled={gate.busy} onClick={() => gate.request({ id: mo.id, status: "cancelled" }, summary)}>
            <Ban size={14} /> Cancel order
          </button>
        )}
      </div>
      {completing && (
        <div className={`${noteBoxCls} mb-4 flex flex-col gap-3`}>
          <p className="text-[13px] text-ink">
            Completing uses up the components for every unit made or scrapped, adds the good units to stock and posts the cost of components and labour to the books.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className={labelCls}>Good units made</span>
              <input className={`${inputCls} w-full`} inputMode="numeric" value={produced} onChange={(e) => setProduced(e.target.value)} />
            </label>
            <label>
              <span className={labelCls}>Units scrapped</span>
              <input className={`${inputCls} w-full`} inputMode="numeric" value={scrapped} onChange={(e) => setScrapped(e.target.value)} />
            </label>
          </div>
          <div>
            <button
              type="button"
              className={btnPrimary}
              disabled={!qtyOk || gate.busy}
              onClick={() => gate.request({ id: mo.id, status: "done", producedQty: p, scrappedQty: s }, `${summary} Produce ${p}${s ? `, scrap ${s}` : ""}.`)}
            >
              <CheckCircle2 size={14} /> Complete order
            </button>
          </div>
        </div>
      )}
      {mo.status === "done" && (
        <div className="mb-4 grid grid-cols-2 gap-2 text-[13px]">
          <Stat label="Produced" value={`${mo.producedQty}${mo.scrappedQty ? ` (+${mo.scrappedQty} scrapped)` : ""}`} />
          <Stat label="Components" value={fmtCents(mo.componentCostCents)} />
          <Stat label="Labour" value={fmtCents(mo.labourCostCents)} />
          <Stat label="Finished goods value" value={fmtCents(mo.finishedCostCents)} />
          {mo.scrapCostCents > 0 && <Stat label="Scrap loss" value={fmtCents(mo.scrapCostCents)} />}
          {mo.plannedCostCents != null && <Stat label="Planned (CAD estimate)" value={fmtCents(mo.plannedCostCents)} />}
        </div>
      )}
      <h4 className="mb-2 text-[13px] font-bold text-ink">{mo.status === "draft" ? "Components (from the CAD bill of materials)" : "Components"}</h4>
      {components === null ? (
        <LoadingLine label="Loading the bill of materials" />
      ) : components.length === 0 ? (
        <p className="mb-4 text-[13px] text-muted">No bill of materials: give the product a routing that points at a CAD BOM revision.</p>
      ) : (
        <div className={`${tableWrapCls} mb-4`}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Component</th>
                <th className={`${thCls} text-right`}>Per unit</th>
                <th className={`${thCls} text-right`}>{mo.status === "done" ? "Used" : "Needed"}</th>
                <th className={`${thCls} text-right`}>Unit cost</th>
                <th className={thCls}>Stock</th>
              </tr>
            </thead>
            <tbody>
              {components.map((c) => (
                <tr key={c.bomLineId}>
                  <td className={tdCls}>
                    {c.name}
                    {c.sku && <span className="ml-1 font-mono text-[12px] text-muted">{c.sku}</span>}
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{c.qtyPerUnit}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{c.consumedQty ?? Math.ceil(c.qtyPerUnit * mo.qty - 1e-9)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{c.unitCostCents ? fmtCents(c.unitCostCents) : "—"}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{c.stocked ? "Moves stock" : "Cost only"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mo.status !== "draft" && <WorkOrderTable moId={mo.id} onChanged={onChanged} />}
    </OpsSlideOver>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-canvas px-3 py-2">
      <p className="text-[12px] font-semibold text-muted">{label}</p>
      <p className="text-[15px] font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------

function WorkOrderTable({ moId, onChanged }: { moId?: string; onChanged?: () => void }) {
  const [status, setStatus] = useState("");
  const { rows, loading, error, reload } = useOpsList<WorkOrderRow>("work-orders", { moId, status: status || undefined });
  const { rows: centres } = useOpsList<WorkCenterRow>("work-centers");
  const { rows: mos } = useOpsList<MoRow>("manufacturing-orders");
  const C = useMemo(() => new Map(centres.map((c) => [c.id, c])), [centres]);
  const M = useMemo(() => new Map(mos.map((m) => [m.id, m])), [mos]);
  const now = useNow(rows.some((r) => r.status === "in_progress"));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<WorkOrderRow | null>(null);
  const sorted = [...rows].sort((a, b) => (a.moId === b.moId ? a.sequence - b.sequence : 0));
  const move = async (w: WorkOrderRow, to: string) => {
    setBusyId(w.id);
    setActionError(null);
    try {
      await opsJson("/api/ops/work-orders", "PATCH", { id: w.id, status: to });
      await reload();
      onChanged?.();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {!moId && (
        <ViewHeader title="Work orders" hint="One step of a manufacturing order at a work centre. Start and pause the timer, or log time by hand; labour cost is logged time × the centre's hourly rate.">
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            {["pending", "in_progress", "paused", "done", "cancelled"].map((s) => (
              <option key={s} value={s}>
                {sentence(s)}
              </option>
            ))}
          </select>
        </ViewHeader>
      )}
      {moId && <h4 className="text-[13px] font-bold text-ink">Work orders</h4>}
      {(error || actionError) && <div className={errorBoxCls}>{error ?? actionError}</div>}
      {loading ? (
        <LoadingLine label="Loading work orders" />
      ) : sorted.length === 0 ? (
        <EmptyBlock icon={Timer} title="No work orders" hint="Confirming a manufacturing order creates one per routing step." />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                {!moId && <th className={thCls}>Order</th>}
                <th className={thCls}>Step</th>
                <th className={thCls}>Work centre</th>
                <th className={thCls}>Status</th>
                <th className={`${thCls} text-right`}>Planned</th>
                <th className={`${thCls} text-right`}>Actual</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((w) => {
                const open = ["pending", "in_progress", "paused"].includes(w.status);
                return (
                  <tr key={w.id}>
                    {!moId && <td className={`${tdCls} font-mono text-[12px]`}>{M.get(w.moId) ? moLabel(M.get(w.moId)!) : w.moId.slice(-6)}</td>}
                    <td className={tdCls}>
                      {w.sequence}. {w.name}
                    </td>
                    <td className={tdCls}>{C.get(w.workCenterId)?.name ?? w.workCenterId}</td>
                    <td className={tdCls}>
                      <span className={chipCls}>{sentence(w.status)}</span>
                    </td>
                    <td className={`${tdCls} text-right tabular-nums text-muted`}>{w.plannedMinutes}m</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{minutes(liveSeconds(w, now))}</td>
                    <td className={`${tdCls} whitespace-nowrap text-right`}>
                      {open && (
                        <span className="inline-flex gap-1.5">
                          {w.status !== "in_progress" ? (
                            <button type="button" className={btnPrimarySm} disabled={busyId === w.id} onClick={() => move(w, "in_progress")}>
                              <Play size={12} /> {w.status === "paused" ? "Resume" : "Start"}
                            </button>
                          ) : (
                            <button type="button" className={btnGhostSm} disabled={busyId === w.id} onClick={() => move(w, "paused")}>
                              <Pause size={12} /> Pause
                            </button>
                          )}
                          {w.status !== "pending" && (
                            <button type="button" className={btnGhostSm} disabled={busyId === w.id} onClick={() => move(w, "done")}>
                              <CheckCircle2 size={12} /> Finish
                            </button>
                          )}
                          <button type="button" className={btnGhostSm} onClick={() => setLogFor(w)}>
                            <Plus size={12} /> Log time
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {logFor && (
        <LogTimeModal
          workOrder={logFor}
          onClose={() => setLogFor(null)}
          onLogged={async () => {
            await reload();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function WorkOrdersView() {
  return <WorkOrderTable />;
}

function LogTimeModal({ workOrder, onClose, onLogged }: { workOrder: WorkOrderRow; onClose: () => void; onLogged: () => void }) {
  const [mins, setMins] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(mins);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/work-time-logs", "POST", { workOrderId: workOrder.id, minutes: n, ...(note.trim() ? { note: note.trim() } : {}) });
      onLogged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't log the time.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <OpsModal title={`Log time — ${workOrder.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <label>
          <span className={labelCls}>Minutes worked</span>
          <input className={`${inputCls} w-full`} inputMode="decimal" value={mins} onChange={(e) => setMins(e.target.value)} />
        </label>
        <label>
          <span className={labelCls}>Note (optional)</span>
          <input className={`${inputCls} w-full`} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="text-[13px] text-muted">Time logs can't be edited; a correction is a new entry.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={!(n > 0) || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Timer size={14} />} {busy ? "Logging" : "Log time"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Work centres
// ---------------------------------------------------------------------------

function WorkCentersView() {
  const { rows, loading, error, reload } = useOpsList<WorkCenterRow>("work-centers");
  const { rows: locations } = useOpsList<LocationRow>("locations");
  const L = useMemo(() => new Map(locations.map((l) => [l.id, l.path])), [locations]);
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toggle = async (c: WorkCenterRow) => {
    setBusyId(c.id);
    try {
      await opsJson("/api/ops/work-centers", "PATCH", { id: c.id, active: !c.active });
      await reload();
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Work centres" hint="Machines, benches and lines. Capacity is how many work orders run at once; the hourly cost prices logged time.">
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <Plus size={14} /> New work centre
        </button>
      </ViewHeader>
      {error && <div className={errorBoxCls}>{error}</div>}
      {loading ? (
        <LoadingLine label="Loading work centres" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={Wrench} title="No work centres yet" hint="Add the places work happens, then use them in routings." />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>Code</th>
                <th className={thCls}>Name</th>
                <th className={`${thCls} text-right`}>Capacity</th>
                <th className={`${thCls} text-right`}>Hourly cost</th>
                <th className={thCls}>Location</th>
                <th className={thCls}>Status</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className={`${tdCls} font-mono text-[12px]`}>{c.code}</td>
                  <td className={tdCls}>{c.name}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{c.capacity}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(c.hourlyCostCents)}</td>
                  <td className={`${tdCls} text-muted`}>{c.locationId ? L.get(c.locationId) ?? "—" : "—"}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{c.active ? "Active" : "Inactive"}</span>
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <button type="button" className={btnGhostSm} disabled={busyId === c.id} onClick={() => toggle(c)}>
                      {c.active ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showNew && <NewWorkCenterModal locations={locations} onClose={() => setShowNew(false)} onCreated={reload} />}
    </div>
  );
}

function NewWorkCenterModal({ locations, onClose, onCreated }: { locations: LocationRow[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [capacity, setCapacity] = useState("1");
  const [rate, setRate] = useState("");
  const [loc, setLoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = rate.trim() ? toCents(rate) : 0;
  const ok = name.trim() && /^[A-Za-z0-9._-]+$/.test(code.trim()) && Number(capacity) >= 1 && cents !== null;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/work-centers", "POST", { name: name.trim(), code: code.trim(), capacity: Number(capacity), hourlyCostCents: cents ?? 0, ...(loc ? { locationId: loc } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the work centre.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <OpsModal title="New work centre" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={labelCls}>Name</span>
            <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span className={labelCls}>Code</span>
            <input className={`${inputCls} w-full font-mono`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="CNC-1" />
          </label>
          <label>
            <span className={labelCls}>Capacity (work orders at once)</span>
            <input className={`${inputCls} w-full`} inputMode="numeric" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </label>
          <label>
            <span className={labelCls}>Hourly cost ($)</span>
            <input className={`${inputCls} w-full`} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="60.00" />
          </label>
        </div>
        <label>
          <span className={labelCls}>Location (optional)</span>
          <select className={`${selectCls} w-full`} value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">None</option>
            {locations.filter((l) => l.active).map((l) => (
              <option key={l.id} value={l.id}>
                {l.path}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={!ok || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {busy ? "Creating" : "Create work centre"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Routings + CAD part links
// ---------------------------------------------------------------------------

function useCadCatalog() {
  const [data, setData] = useState<CadCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const { data: d } = await opsJson("/api/ops/manufacturing/cad", "GET");
      setData(d as unknown as CadCatalog);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the CAD catalog.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, reload: load };
}

function RoutingsView() {
  const { rows, loading, error, reload } = useOpsList<RoutingRow>("routings");
  const { rows: products } = useOpsList<ProductRow>("products");
  const { rows: centres } = useOpsList<WorkCenterRow>("work-centers");
  const cad = useCadCatalog();
  const P = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const B = useMemo(() => new Map((cad.data?.bomVersions ?? []).map((b) => [b.id, b.label])), [cad.data]);
  const [showNew, setShowNew] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <ViewHeader title="Routings" hint="How a product is made: the CAD bill of materials revision it uses and its steps in order, each at a work centre with planned minutes per unit.">
          <button type="button" className={btnPrimary} onClick={() => setShowNew(true)} disabled={centres.length === 0}>
            <Plus size={14} /> New routing
          </button>
        </ViewHeader>
        {(error || cad.error) && <div className={errorBoxCls}>{error ?? cad.error}</div>}
        {loading ? (
          <LoadingLine label="Loading routings" />
        ) : rows.length === 0 ? (
          <EmptyBlock icon={Route} title="No routings yet" hint={centres.length ? "Create one to tell manufacturing orders which steps and parts a product needs." : "Add a work centre first."} />
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Routing</th>
                  <th className={thCls}>Product</th>
                  <th className={thCls}>Bill of materials</th>
                  <th className={thCls}>Steps</th>
                  <th className={thCls}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className={tdCls}>{r.name}</td>
                    <td className={tdCls}>{P.get(r.productId)?.name ?? r.productId}</td>
                    <td className={`${tdCls} text-muted`}>{r.bomVersionId ? B.get(r.bomVersionId) ?? r.bomVersionId : "None"}</td>
                    <td className={`${tdCls} text-muted`}>{r.operations.map((o) => o.name).join(" → ") || "—"}</td>
                    <td className={tdCls}>
                      <span className={chipCls}>{r.active ? "Active" : "Inactive"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <PartLinks catalog={cad.data} products={products} onChanged={cad.reload} />
      {showNew && <NewRoutingModal products={products} centres={centres} boms={cad.data?.bomVersions ?? []} onClose={() => setShowNew(false)} onCreated={reload} />}
    </div>
  );
}

function PartLinks({ catalog, products, onChanged }: { catalog: CadCatalog | null; products: ProductRow[]; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = async (cadPartId: string, productId: string) => {
    setBusyId(cadPartId);
    setError(null);
    try {
      await opsJson("/api/ops/manufacturing/cad", "POST", { cadPartId, productId: productId || null });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link the part.");
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <ViewHeader title="CAD parts and products" hint="A bill-of-materials line uses up stock only when its CAD part is linked to the product it is stocked as. Unlinked lines are costed but never moved." />
      {error && <div className={errorBoxCls}>{error}</div>}
      {!catalog ? (
        <LoadingLine label="Loading CAD parts" />
      ) : catalog.parts.length === 0 ? (
        <EmptyBlock icon={Link2} title="No CAD parts yet" hint="Parts come from the CAD workspace's parts inventory." />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>CAD part</th>
                <th className={thCls}>Stocked as</th>
              </tr>
            </thead>
            <tbody>
              {catalog.parts.map((p) => (
                <tr key={p.id}>
                  <td className={tdCls}>
                    {p.name}
                    {p.sku && <span className="ml-1 font-mono text-[12px] text-muted">{p.sku}</span>}
                  </td>
                  <td className={tdCls}>
                    <select className={selectCls} value={p.opsProductId ?? ""} disabled={busyId === p.id} onChange={(e) => link(p.id, e.target.value)} aria-label={`Product for ${p.name}`}>
                      <option value="">Not linked</option>
                      {products.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name} ({x.sku})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewRoutingModal({
  products,
  centres,
  boms,
  onClose,
  onCreated,
}: {
  products: ProductRow[];
  centres: WorkCenterRow[];
  boms: CadCatalog["bomVersions"];
  onClose: () => void;
  onCreated: () => void;
}) {
  const active = centres.filter((c) => c.active);
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [bomVersionId, setBom] = useState("");
  const [ops, setOps] = useState<Array<{ name: string; workCenterId: string; minutes: string }>>([{ name: "", workCenterId: active[0]?.id ?? "", minutes: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid =
    productId && name.trim() && ops.every((o) => o.name.trim() && o.workCenterId && Number.isInteger(Number(o.minutes)) && Number(o.minutes) >= 0 && o.minutes.trim() !== "");
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/routings", "POST", {
        productId,
        name: name.trim(),
        ...(bomVersionId ? { bomVersionId } : {}),
        operations: ops.map((o, i) => ({ sequence: (i + 1) * 10, name: o.name.trim(), workCenterId: o.workCenterId, plannedMinutes: Number(o.minutes) })),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the routing.");
    } finally {
      setBusy(false);
    }
  };
  const set = (i: number, patch: Partial<(typeof ops)[number]>) => setOps(ops.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <OpsModal title="New routing" onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={labelCls}>Product</span>
            <select className={`${selectCls} w-full`} value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Choose a product</option>
              {products.filter((p) => p.trackInventory).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={labelCls}>Name</span>
            <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard assembly" />
          </label>
        </div>
        <label>
          <span className={labelCls}>CAD bill of materials</span>
          <select className={`${selectCls} w-full`} value={bomVersionId} onChange={(e) => setBom(e.target.value)}>
            <option value="">None (labour only)</option>
            {boms.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} · {b.lineCount} line(s)
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className={labelCls}>Steps, in order (minutes are per unit)</span>
          <div className="flex flex-col gap-2">
            {ops.map((o, i) => (
              <div key={i} className="grid grid-cols-[24px_1fr_1fr_96px_auto] items-center gap-2">
                <span className="text-[13px] tabular-nums text-muted">{i + 1}.</span>
                <input className={inputCls} value={o.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Step name" aria-label={`Step ${i + 1} name`} />
                <select className={selectCls} value={o.workCenterId} onChange={(e) => set(i, { workCenterId: e.target.value })} aria-label={`Step ${i + 1} work centre`}>
                  {active.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input className={inputCls} inputMode="numeric" value={o.minutes} onChange={(e) => set(i, { minutes: e.target.value })} placeholder="Minutes" aria-label={`Step ${i + 1} minutes`} />
                <button type="button" className={btnGhostSm} disabled={ops.length === 1} onClick={() => setOps(ops.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button type="button" className={`${btnGhostSm} mt-2`} onClick={() => setOps([...ops, { name: "", workCenterId: active[0]?.id ?? "", minutes: "" }])}>
            <Plus size={12} /> Add step
          </button>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={!valid || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {busy ? "Creating" : "Create routing"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Scrap
// ---------------------------------------------------------------------------

function ScrapView() {
  const { rows, loading, error, reload } = useOpsList<ScrapRow>("scraps");
  const { rows: products } = useOpsList<ProductRow>("products");
  const { rows: locations } = useOpsList<LocationRow>("locations");
  const P = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const L = useMemo(() => new Map(locations.map((l) => [l.id, l.path])), [locations]);
  const [showNew, setShowNew] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Scrap" hint="Stock written off: one scrap move on the ledger and its value posted to scrap loss. Scrapping asks for approval.">
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <PackageX size={14} /> Scrap stock
        </button>
      </ViewHeader>
      {error && <div className={errorBoxCls}>{error}</div>}
      {loading ? (
        <LoadingLine label="Loading scrap" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={PackageX} title="Nothing scrapped" hint="Spoiled units from a manufacturing order land here too." />
      ) : (
        <div className={tableWrapCls}>
          <table className={tableCls}>
            <thead>
              <tr>
                <th className={thCls}>When</th>
                <th className={thCls}>Product</th>
                <th className={`${thCls} text-right`}>Qty</th>
                <th className={thCls}>From</th>
                <th className={thCls}>Reason</th>
                <th className={`${thCls} text-right`}>Value</th>
                <th className={thCls}>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td className={`${tdCls} text-muted`}>{fmtDateTime(s.createdAt)}</td>
                  <td className={tdCls}>{P.get(s.productId)?.name ?? s.productId}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{s.qty}</td>
                  <td className={`${tdCls} text-muted`}>{s.locationId ? L.get(s.locationId) ?? "—" : "Unlocated"}</td>
                  <td className={tdCls}>{s.reason}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(s.totalCostCents)}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{s.moId ? "Manufacturing order" : "Manual"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showNew && <ScrapModal products={products} locations={locations} onClose={() => setShowNew(false)} onDone={reload} />}
    </div>
  );
}

function ScrapModal({ products, locations, onClose, onDone }: { products: ProductRow[]; locations: LocationRow[]; onClose: () => void; onDone: () => void }) {
  const done = useCallback(() => onDone(), [onDone]);
  const gate = useGatedWrite("scraps", "POST", done);
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [loc, setLoc] = useState("");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");
  const cents = cost.trim() ? toCents(cost) : undefined;
  const ok = productId && Number.isInteger(Number(qty)) && Number(qty) >= 1 && reason.trim() && cents !== null;
  const product = products.find((p) => p.id === productId);
  return (
    <OpsModal title="Scrap stock" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {gate.error && <div className={errorBoxCls}>{gate.error}</div>}
        {gate.note && <div className={noteBoxCls}>{gate.note}</div>}
        {gate.pending && (
          <OpsApprovalCard
            pending={gate.pending}
            busy={gate.busy}
            executeLabel="Scrap stock"
            onApprove={() => gate.decide("approved")}
            onDeny={() => gate.decide("denied")}
            onExecute={gate.execute}
          />
        )}
        <label>
          <span className={labelCls}>Product</span>
          <select className={`${selectCls} w-full`} value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">Choose a product</option>
            {products.filter((p) => p.trackInventory).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku}) · {p.stockQty} on hand
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className={labelCls}>Quantity</span>
            <input className={`${inputCls} w-full`} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label>
            <span className={labelCls}>From location</span>
            <select className={`${selectCls} w-full`} value={loc} onChange={(e) => setLoc(e.target.value)}>
              <option value="">Unlocated stock</option>
              {locations.filter((l) => l.active).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span className={labelCls}>Reason</span>
          <input className={`${inputCls} w-full`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged in storage" />
        </label>
        <label>
          <span className={labelCls}>Value per unit ($, optional — default the last manufactured unit cost)</span>
          <input className={`${inputCls} w-full`} inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className={btnPrimary}
            disabled={!ok || gate.busy || Boolean(gate.pending)}
            onClick={() =>
              gate.request(
                { productId, qty: Number(qty), reason: reason.trim(), ...(loc ? { locationId: loc } : {}), ...(cents !== undefined ? { unitCostCents: cents } : {}) },
                `scrap ${qty} × ${product?.name ?? productId} (${reason.trim()}).`,
              )
            }
          >
            <PackageX size={14} /> Request scrap
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
