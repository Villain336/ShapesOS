// ShapesOS Phase 10 (ops-core) — inventory views for /dashboard/ops/inventory
// and /dashboard/ops/purchasing: stock by location, warehouses + location
// tree, variants, transfers, reorder rules. All reads/writes go through the
// generic /api/ops/{entity} route (rules in lib/ops/stock.ts); stock by
// location is derived from the ledger (/api/ops/inventory/stock).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRightLeft,
  Boxes,
  CheckCircle2,
  Layers,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Repeat,
  Warehouse as WarehouseIcon,
  XCircle,
} from "lucide-react";
import {
  btnGhost,
  btnGhostSm,
  btnPrimary,
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
} from "@/components/crm/ui";
import { InventoryTab } from "@/components/crm/InventoryTab";
import { PurchaseOrdersTab } from "@/components/crm/PurchaseOrdersTab";
import { EmptyBlock, LoadingLine, OpsModal, ViewHeader, fmtCents, fmtDate, opsJson, sentence, shortId, toCents, useOpsList } from "./shared";
import { SubTabs } from "./SubTabs";

interface WarehouseRow {
  id: string;
  name: string;
  code: string;
  address: string | null;
  active: boolean;
}
interface LocationRow {
  id: string;
  warehouseId: string;
  parentId: string | null;
  kind: string;
  code: string;
  name: string | null;
  path: string;
  active: boolean;
}
interface ProductRow {
  id: string;
  name: string;
  sku: string;
  trackInventory: boolean;
  stockQty: number;
}
interface VariantRow {
  id: string;
  productId: string;
  sku: string;
  name: string;
  attributes: Record<string, string>;
  priceCents: number | null;
  isDefault: boolean;
  active: boolean;
}
interface StockRow {
  productId: string;
  productName: string;
  sku: string;
  variantId: string | null;
  variantName: string | null;
  variantSku: string | null;
  locationId: string | null;
  locationPath: string | null;
  qty: number;
}
interface TransferRow {
  id: string;
  fromLocationId: string;
  toLocationId: string;
  lines: Array<{ productId: string; variantId?: string; qty: number }>;
  status: string;
  note: string | null;
  doneAt: string | null;
  createdAt: string;
}
interface ReorderRow {
  id: string;
  productId: string;
  variantId: string | null;
  warehouseId: string;
  receiveLocationId: string | null;
  minQty: number;
  maxQty: number;
  supplierName: string | null;
  unitCostCents: number | null;
  active: boolean;
  openPurchaseOrderId: string | null;
  lastTriggeredAt: string | null;
}

const KINDS = ["zone", "aisle", "rack", "shelf", "bin", "dock"] as const;

// ---------------------------------------------------------------------------
// Page wrappers
// ---------------------------------------------------------------------------

export function InventoryWorkspace() {
  const tabs = useMemo(
    () => [
      { id: "products", label: "Products", icon: Boxes, render: () => <InventoryTab /> },
      { id: "stock", label: "Stock by location", icon: MapPin, render: () => <StockByLocationView /> },
      { id: "variants", label: "Variants", icon: Layers, render: () => <VariantsView /> },
      { id: "warehouses", label: "Warehouses", icon: WarehouseIcon, render: () => <WarehousesView /> },
      { id: "transfers", label: "Transfers", icon: ArrowRightLeft, render: () => <TransfersView /> },
    ],
    [],
  );
  return <SubTabs tabs={tabs} ariaLabel="Inventory views" />;
}

export function PurchasingWorkspace() {
  const tabs = useMemo(
    () => [
      { id: "orders", label: "Purchase orders", icon: Boxes, render: () => <PurchaseOrdersTab /> },
      { id: "reorder", label: "Reorder rules", icon: Repeat, render: () => <ReorderRulesView /> },
    ],
    [],
  );
  return <SubTabs tabs={tabs} ariaLabel="Purchasing views" />;
}

// ---------------------------------------------------------------------------
// Stock by location
// ---------------------------------------------------------------------------

export function StockByLocationView() {
  const { rows: warehouses } = useOpsList<WarehouseRow>("warehouses");
  const [warehouseId, setWarehouseId] = useState("");
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = warehouseId ? `?warehouseId=${encodeURIComponent(warehouseId)}` : "";
      const { data } = await opsJson(`/api/ops/inventory/stock${q}`, "GET");
      setRows((data.rows ?? []) as StockRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stock.");
    } finally {
      setLoading(false);
    }
  }, [warehouseId]);
  useEffect(() => {
    load();
  }, [load]);

  const total = rows.reduce((s, r) => s + r.qty, 0);
  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Stock by location" hint="Quantities per bin, rack or dock, worked out from the stock ledger. Unlocated stock is stock moved before locations existed or without one.">
        <span>
          Units in view <span className="font-bold tabular-nums text-ink">{total}</span>
        </span>
      </ViewHeader>
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectCls} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="Warehouse">
          <option value="">All warehouses and unlocated</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </select>
        <button type="button" className={btnGhost} onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      {error && <div className={errorBoxCls}>{error}</div>}
      {loading ? (
        <LoadingLine label="Loading stock…" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={MapPin} title="No stock here" hint="Receive a purchase order into a location, or move stock with a transfer." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[720px]`}>
            <thead>
              <tr>
                <th className={thCls}>Location</th>
                <th className={thCls}>Product</th>
                <th className={thCls}>Variant</th>
                <th className={`${thCls} text-right`}>On hand</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.locationId}|${r.variantId}|${r.productId}`}>
                  <td className={`${tdCls} font-mono text-[12px]`}>{r.locationPath ?? <span className="text-muted">Unlocated</span>}</td>
                  <td className={tdCls}>
                    {r.productName} <span className="font-mono text-[12px] text-muted">{r.sku}</span>
                  </td>
                  <td className={`${tdCls} text-muted`}>{r.variantName && r.variantSku !== r.sku ? `${r.variantName} (${r.variantSku})` : "Default"}</td>
                  <td className={`${tdCls} text-right font-semibold tabular-nums`}>{r.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Warehouses + location tree
// ---------------------------------------------------------------------------

export function WarehousesView() {
  const wh = useOpsList<WarehouseRow>("warehouses");
  const locs = useOpsList<LocationRow>("locations");
  const [modal, setModal] = useState<null | { kind: "warehouse" } | { kind: "location"; warehouseId: string; parentId?: string }>(null);

  const childrenOf = useMemo(() => {
    const m = new Map<string, LocationRow[]>();
    for (const l of locs.rows) {
      const k = l.parentId ?? `wh:${l.warehouseId}`;
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    for (const list of m.values()) list.sort((a, b) => a.code.localeCompare(b.code));
    return m;
  }, [locs.rows]);

  const reload = () => {
    wh.reload();
    locs.reload();
  };

  const renderTree = (key: string, depth: number): React.ReactNode =>
    (childrenOf.get(key) ?? []).map((l) => (
      <div key={l.id}>
        <div className="flex items-center justify-between gap-2 border-b border-line py-1.5" style={{ paddingLeft: 12 + depth * 18 }}>
          <span className="flex items-center gap-2 text-[13px] text-ink">
            <span className={chipCls}>{sentence(l.kind)}</span>
            <span className="font-mono">{l.code}</span>
            {l.name && <span className="text-muted">{l.name}</span>}
          </span>
          {l.kind !== "bin" && l.kind !== "dock" && (
            <button type="button" className={btnGhostSm} onClick={() => setModal({ kind: "location", warehouseId: l.warehouseId, parentId: l.id })}>
              <Plus size={12} /> Add inside
            </button>
          )}
        </div>
        {renderTree(l.id, depth + 1)}
      </div>
    ));

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Warehouses" hint="Each warehouse holds zones, aisles, racks, shelves and bins (docks sit under the warehouse or a zone). Codes are permanent." />
      <div>
        <button type="button" className={btnPrimary} onClick={() => setModal({ kind: "warehouse" })}>
          <Plus size={15} /> New warehouse
        </button>
      </div>
      {(wh.error || locs.error) && <div className={errorBoxCls}>{wh.error ?? locs.error}</div>}
      {wh.loading ? (
        <LoadingLine label="Loading warehouses…" />
      ) : wh.rows.length === 0 ? (
        <EmptyBlock icon={WarehouseIcon} title="No warehouses yet" hint="Add a warehouse, then its zones and bins." />
      ) : (
        wh.rows.map((w) => (
          <section key={w.id} className="rounded-lg border border-line bg-paper">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
              <div>
                <p className="text-[14px] font-bold text-ink">
                  <span className="font-mono">{w.code}</span> · {w.name}
                </p>
                {w.address && <p className="text-[12px] text-muted">{w.address}</p>}
              </div>
              <button type="button" className={btnGhostSm} onClick={() => setModal({ kind: "location", warehouseId: w.id })}>
                <Plus size={12} /> Add location
              </button>
            </div>
            <div className="pb-1">
              {(childrenOf.get(`wh:${w.id}`) ?? []).length === 0 ? (
                <p className="px-3 py-3 text-[13px] text-muted">No locations yet.</p>
              ) : (
                renderTree(`wh:${w.id}`, 0)
              )}
            </div>
          </section>
        ))
      )}
      {modal?.kind === "warehouse" && <NewWarehouseModal onClose={() => setModal(null)} onCreated={reload} />}
      {modal?.kind === "location" && (
        <NewLocationModal
          warehouseId={modal.warehouseId}
          parent={modal.parentId ? locs.rows.find((l) => l.id === modal.parentId) ?? null : null}
          onClose={() => setModal(null)}
          onCreated={reload}
        />
      )}
    </div>
  );
}

function NewWarehouseModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/warehouses", "POST", { name: name.trim(), code: code.trim(), ...(address.trim() ? { address: address.trim() } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the warehouse.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New warehouse" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Name</span>
          <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className={labelCls}>Code (permanent)</span>
          <input className={`${inputCls} w-full font-mono`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="WH-01" />
        </label>
        <label className="block">
          <span className={labelCls}>Address (optional)</span>
          <input className={`${inputCls} w-full`} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !name.trim() || !code.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create warehouse
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

/** Kinds allowed under a parent — mirrors assertLocationParent (server is authoritative). */
function allowedKinds(parentKind: string | null): string[] {
  const rank: Record<string, number> = { zone: 1, dock: 1, aisle: 2, rack: 3, shelf: 4, bin: 5 };
  if (!parentKind) return [...KINDS];
  if (parentKind === "bin" || parentKind === "dock") return [];
  return KINDS.filter((k) => (k === "dock" ? parentKind === "zone" : rank[k]! > rank[parentKind]!));
}

function NewLocationModal({
  warehouseId,
  parent,
  onClose,
  onCreated,
}: {
  warehouseId: string;
  parent: LocationRow | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const kinds = allowedKinds(parent?.kind ?? null);
  const [kind, setKind] = useState(kinds[0] ?? "zone");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/locations", "POST", {
        warehouseId,
        ...(parent ? { parentId: parent.id } : {}),
        kind,
        code: code.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the location.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title={parent ? `New location in ${parent.path}` : "New location"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Kind</span>
          <select className={`${selectCls} w-full`} value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {sentence(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Code (permanent, unique in the warehouse)</span>
          <input className={`${inputCls} w-full font-mono`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="A-03-2-B" />
        </label>
        <label className="block">
          <span className={labelCls}>Name (optional)</span>
          <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !code.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create location
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export function VariantsView() {
  const products = useOpsList<ProductRow>("products");
  const variants = useOpsList<VariantRow>("product-variants");
  const [show, setShow] = useState(false);
  const P = new Map(products.rows.map((p) => [p.id, p]));
  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Variants" hint="Sizes, colours and other versions of a product, each with its own SKU. Products without variants keep a single default one." />
      <div>
        <button type="button" className={btnPrimary} onClick={() => setShow(true)} disabled={products.rows.length === 0}>
          <Plus size={15} /> New variant
        </button>
      </div>
      {variants.error && <div className={errorBoxCls}>{variants.error}</div>}
      {variants.loading ? (
        <LoadingLine label="Loading variants…" />
      ) : variants.rows.length === 0 ? (
        <EmptyBlock icon={Layers} title="No variants yet" hint="Every product starts as a single default variant." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[720px]`}>
            <thead>
              <tr>
                <th className={thCls}>Variant SKU</th>
                <th className={thCls}>Name</th>
                <th className={thCls}>Product</th>
                <th className={thCls}>Attributes</th>
                <th className={`${thCls} text-right`}>Price</th>
              </tr>
            </thead>
            <tbody>
              {variants.rows.map((v) => (
                <tr key={v.id}>
                  <td className={`${tdCls} font-mono text-[12px]`}>{v.sku}</td>
                  <td className={tdCls}>
                    {v.name} {v.isDefault && <span className={chipCls}>Default</span>}
                  </td>
                  <td className={`${tdCls} text-muted`}>{P.get(v.productId)?.name ?? shortId(v.productId)}</td>
                  <td className={`${tdCls} text-muted`}>
                    {Object.entries(v.attributes ?? {})
                      .map(([k, val]) => `${k}: ${val}`)
                      .join(" · ") || "—"}
                  </td>
                  <td className={`${tdCls} text-right tabular-nums`}>{v.priceCents == null ? "Product price" : fmtCents(v.priceCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <NewVariantModal products={products.rows} onClose={() => setShow(false)} onCreated={variants.reload} />}
    </div>
  );
}

function NewVariantModal({ products, onClose, onCreated }: { products: ProductRow[]; onClose: () => void; onCreated: () => void }) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [attrs, setAttrs] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    const attributes: Record<string, string> = {};
    for (const pair of attrs.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [k, ...rest] = pair.split(":");
      if (!k || rest.length === 0) return setError('Attributes look like "color: red, size: L".');
      attributes[k.trim()] = rest.join(":").trim();
    }
    const priceCents = price.trim() ? toCents(price) : undefined;
    if (priceCents === null) return setError("Price must be a dollar amount.");
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/product-variants", "POST", { productId, sku: sku.trim(), name: name.trim(), attributes, ...(priceCents !== undefined ? { priceCents } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the variant.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New variant" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Product</span>
          <select className={`${selectCls} w-full`} value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Variant SKU</span>
            <input className={`${inputCls} w-full font-mono`} value={sku} onChange={(e) => setSku(e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Name</span>
            <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Red / L" />
          </label>
        </div>
        <label className="block">
          <span className={labelCls}>Attributes (optional)</span>
          <input className={`${inputCls} w-full`} value={attrs} onChange={(e) => setAttrs(e.target.value)} placeholder="color: red, size: L" />
        </label>
        <label className="block">
          <span className={labelCls}>Price override ($, optional)</span>
          <input className={`${inputCls} w-full`} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !productId || !sku.trim() || !name.trim()} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create variant
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export function TransfersView() {
  const transfers = useOpsList<TransferRow>("transfers");
  const locs = useOpsList<LocationRow>("locations");
  const products = useOpsList<ProductRow>("products");
  const [show, setShow] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const L = new Map(locs.rows.map((l) => [l.id, l]));
  const P = new Map(products.rows.map((p) => [p.id, p]));

  async function move(t: TransferRow, status: "done" | "cancelled") {
    setBusyId(t.id);
    setError(null);
    setNote(null);
    try {
      await opsJson("/api/ops/transfers", "PATCH", { id: t.id, status });
      setNote(status === "done" ? "Transfer booked — stock moved." : "Transfer cancelled.");
      transfers.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Transfers" hint="Move stock between locations. A draft moves nothing; marking it done books both sides of the move in the ledger at once." />
      <div>
        <button type="button" className={btnPrimary} onClick={() => setShow(true)} disabled={locs.rows.length < 2}>
          <Plus size={15} /> New transfer
        </button>
      </div>
      {(error || transfers.error) && <div className={errorBoxCls}>{error ?? transfers.error}</div>}
      {note && <div className={noteBoxCls}>{note}</div>}
      {transfers.loading ? (
        <LoadingLine label="Loading transfers…" />
      ) : transfers.rows.length === 0 ? (
        <EmptyBlock icon={ArrowRightLeft} title="No transfers yet" hint={locs.rows.length < 2 ? "Add at least two locations first." : "Create a draft transfer between two locations."} />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[820px]`}>
            <thead>
              <tr>
                <th className={thCls}>Transfer</th>
                <th className={thCls}>From</th>
                <th className={thCls}>To</th>
                <th className={thCls}>Lines</th>
                <th className={thCls}>Status</th>
                <th className={thCls}>Created</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {transfers.rows.map((t) => (
                <tr key={t.id}>
                  <td className={`${tdCls} font-semibold`}>TR-{shortId(t.id)}</td>
                  <td className={`${tdCls} font-mono text-[12px]`}>{L.get(t.fromLocationId)?.path ?? shortId(t.fromLocationId)}</td>
                  <td className={`${tdCls} font-mono text-[12px]`}>{L.get(t.toLocationId)?.path ?? shortId(t.toLocationId)}</td>
                  <td className={`${tdCls} text-muted`}>{t.lines.map((l) => `${l.qty} × ${P.get(l.productId)?.sku ?? shortId(l.productId)}`).join(", ")}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{sentence(t.status)}</span>
                  </td>
                  <td className={`${tdCls} text-muted`}>{fmtDate(t.createdAt)}</td>
                  <td className={`${tdCls} text-right`}>
                    {t.status === "draft" && (
                      <span className="inline-flex gap-1.5">
                        <button type="button" className={btnGhostSm} disabled={busyId === t.id} onClick={() => move(t, "done")}>
                          <CheckCircle2 size={13} /> Mark done
                        </button>
                        <button type="button" className={btnGhostSm} disabled={busyId === t.id} onClick={() => move(t, "cancelled")}>
                          <XCircle size={13} /> Cancel
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && <NewTransferModal locations={locs.rows} products={products.rows.filter((p) => p.trackInventory)} onClose={() => setShow(false)} onCreated={transfers.reload} />}
    </div>
  );
}

function NewTransferModal({
  locations,
  products,
  onClose,
  onCreated,
}: {
  locations: LocationRow[];
  products: ProductRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const sorted = [...locations].sort((a, b) => a.path.localeCompare(b.path));
  const [from, setFrom] = useState(sorted[0]?.id ?? "");
  const [to, setTo] = useState(sorted[1]?.id ?? "");
  const [lines, setLines] = useState<Array<{ productId: string; qty: string }>>([{ productId: products[0]?.id ?? "", qty: "1" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (lines.some((l) => !l.productId || !Number.isInteger(Number(l.qty)) || Number(l.qty) < 1)) return setError("Each line needs a product and a whole quantity.");
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/transfers", "POST", { fromLocationId: from, toLocationId: to, lines: lines.map((l) => ({ productId: l.productId, qty: Number(l.qty) })) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the transfer.");
    } finally {
      setBusy(false);
    }
  }
  const locSelect = (value: string, set: (v: string) => void, label: string) => (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <select className={`${selectCls} w-full font-mono`} value={value} onChange={(e) => set(e.target.value)}>
        {sorted.map((l) => (
          <option key={l.id} value={l.id}>
            {l.path}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <OpsModal title="New transfer" onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {locSelect(from, setFrom, "From")}
          {locSelect(to, setTo, "To")}
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_96px] gap-2">
            <select className={selectCls} value={l.productId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))} aria-label={`Product ${i + 1}`}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </select>
            <input className={inputCls} value={l.qty} inputMode="numeric" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} aria-label={`Quantity ${i + 1}`} />
          </div>
        ))}
        <div>
          <button type="button" className={btnGhostSm} onClick={() => setLines([...lines, { productId: products[0]?.id ?? "", qty: "1" }])}>
            <Plus size={12} /> Add line
          </button>
        </div>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !from || !to || from === to} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create draft transfer
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// Reorder rules
// ---------------------------------------------------------------------------

export function ReorderRulesView() {
  const rules = useOpsList<ReorderRow>("reorder-rules");
  const products = useOpsList<ProductRow>("products");
  const warehouses = useOpsList<WarehouseRow>("warehouses");
  const locs = useOpsList<LocationRow>("locations");
  const [show, setShow] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const P = new Map(products.rows.map((p) => [p.id, p]));
  const W = new Map(warehouses.rows.map((w) => [w.id, w]));

  async function runNow() {
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      const { data } = await opsJson("/api/cron/ops-reorder", "POST");
      const n = Number(data.drafted ?? 0);
      setNote(n === 0 ? "Checked — nothing is at or below its minimum (or a draft is already open)." : `Drafted ${n} purchase order${n === 1 ? "" : "s"}. Review and send them under Purchase orders.`);
      rules.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reorder check failed.");
    } finally {
      setRunning(false);
    }
  }

  async function toggle(r: ReorderRow) {
    try {
      await opsJson("/api/ops/reorder-rules", "PATCH", { id: r.id, active: !r.active });
      rules.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Reorder rules" hint="When a warehouse's stock of a product falls to its minimum, a draft purchase order for enough to reach the maximum is created hourly. Drafts are never sent without your approval." />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnPrimary} onClick={() => setShow(true)} disabled={warehouses.rows.length === 0}>
          <Plus size={15} /> New reorder rule
        </button>
        <button type="button" className={btnGhost} onClick={runNow} disabled={running}>
          {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Run check now
        </button>
      </div>
      {(error || rules.error) && <div className={errorBoxCls}>{error ?? rules.error}</div>}
      {note && <div className={noteBoxCls}>{note}</div>}
      {rules.loading ? (
        <LoadingLine label="Loading reorder rules…" />
      ) : rules.rows.length === 0 ? (
        <EmptyBlock icon={Repeat} title="No reorder rules yet" hint={warehouses.rows.length === 0 ? "Add a warehouse first (Products & inventory → Warehouses)." : "Set a min/max for a product in a warehouse."} />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[820px]`}>
            <thead>
              <tr>
                <th className={thCls}>Product</th>
                <th className={thCls}>Warehouse</th>
                <th className={`${thCls} text-right`}>Min</th>
                <th className={`${thCls} text-right`}>Max</th>
                <th className={thCls}>Supplier</th>
                <th className={thCls}>Open draft</th>
                <th className={thCls}>Status</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {rules.rows.map((r) => (
                <tr key={r.id}>
                  <td className={tdCls}>
                    {P.get(r.productId)?.name ?? shortId(r.productId)} <span className="font-mono text-[12px] text-muted">{P.get(r.productId)?.sku}</span>
                  </td>
                  <td className={`${tdCls} font-mono text-[12px]`}>{W.get(r.warehouseId)?.code ?? shortId(r.warehouseId)}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{r.minQty}</td>
                  <td className={`${tdCls} text-right tabular-nums`}>{r.maxQty}</td>
                  <td className={`${tdCls} text-muted`}>
                    {r.supplierName ?? "—"}
                    {r.unitCostCents != null ? ` · ${fmtCents(r.unitCostCents)}/unit` : ""}
                  </td>
                  <td className={`${tdCls} text-muted`}>{r.openPurchaseOrderId ? `PO-${shortId(r.openPurchaseOrderId)}` : "—"}</td>
                  <td className={tdCls}>
                    <span className={chipCls}>{r.active ? "Active" : "Paused"}</span>
                  </td>
                  <td className={`${tdCls} text-right`}>
                    <button type="button" className={btnGhostSm} onClick={() => toggle(r)}>
                      {r.active ? "Pause" : "Resume"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {show && (
        <NewReorderRuleModal
          products={products.rows.filter((p) => p.trackInventory)}
          warehouses={warehouses.rows}
          locations={locs.rows}
          onClose={() => setShow(false)}
          onCreated={rules.reload}
        />
      )}
    </div>
  );
}

function NewReorderRuleModal({
  products,
  warehouses,
  locations,
  onClose,
  onCreated,
}: {
  products: ProductRow[];
  warehouses: WarehouseRow[];
  locations: LocationRow[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [receive, setReceive] = useState("");
  const [min, setMin] = useState("5");
  const [max, setMax] = useState("20");
  const [supplier, setSupplier] = useState("");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inWarehouse = locations.filter((l) => l.warehouseId === warehouseId).sort((a, b) => a.path.localeCompare(b.path));
  async function submit() {
    const unitCostCents = cost.trim() ? toCents(cost) : undefined;
    if (unitCostCents === null) return setError("Unit cost must be a dollar amount.");
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/reorder-rules", "POST", {
        productId,
        warehouseId,
        ...(receive ? { receiveLocationId: receive } : {}),
        minQty: Number(min),
        maxQty: Number(max),
        ...(supplier.trim() ? { supplierName: supplier.trim() } : {}),
        ...(unitCostCents !== undefined ? { unitCostCents } : {}),
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the rule.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OpsModal title="New reorder rule" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Product</span>
          <select className={`${selectCls} w-full`} value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Warehouse</span>
            <select className={`${selectCls} w-full`} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Receive into</span>
            <select className={`${selectCls} w-full font-mono`} value={receive} onChange={(e) => setReceive(e.target.value)}>
              <option value="">Unlocated</option>
              {inWarehouse.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Minimum</span>
            <input className={`${inputCls} w-full`} value={min} onChange={(e) => setMin(e.target.value)} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelCls}>Maximum</span>
            <input className={`${inputCls} w-full`} value={max} onChange={(e) => setMax(e.target.value)} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelCls}>Supplier (optional)</span>
            <input className={`${inputCls} w-full`} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Unit cost ($, optional)</span>
            <input className={`${inputCls} w-full`} value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy || !productId || !warehouseId} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" />} Create rule
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
