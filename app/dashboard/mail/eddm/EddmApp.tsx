// Marketr — EDDM concierge client app: order list + 6-step concierge wizard.
// Agentic OS design system. Copy rule: no API send path exists for
// EDDM — the mailhouse executes; Marketr prepares the handoff.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Calculator,
  CalendarDays,
  Check,
  ChevronRight,
  Download,
  FileText,
  Info,
  Link2,
  MapPin,
  Palette,
  Pencil,
  Plus,
  QrCode,
  Trash2,
  Truck,
  X,
} from "lucide-react";
import { activateOnKey, closeOnEscape } from "@/lib/ui/keyboard";

// ---------------------------------------------------------------------------
// Types + tiny API helper
// ---------------------------------------------------------------------------

interface RouteRow {
  zip: string;
  routeId: string;
  households: number;
  selected: boolean;
}

interface Creative {
  id: string;
  name: string;
  formatTrack: string;
  size: string;
  source: string;
  creativeHash: string | null;
  version: number;
  status: string;
  pdfUrl: string | null;
  updatedAt: string;
}

interface Estimate {
  pieceCount: number;
  selectedRoutes: number;
  postageTier: "retail" | "bmeu";
  postageCentsPerPiece: number;
  printCentsPerPiece: number;
  perPieceCents: number;
  postageCents: number;
  printCents: number;
  totalCents: number;
  usedDefaults: boolean;
}

interface Order {
  id: string;
  name: string;
  zips: string[];
  routes: RouteRow[];
  pieceCount: number;
  creative: Creative | null;
  creativeId: string | null;
  mailhouse: string | null;
  briefPdfUrl: string | null;
  status: string;
  costCents: number;
  postageCents: number;
  printCents: number;
  dropDate: string | null;
  inHomeStart: string | null;
  inHomeEnd: string | null;
  qrSlug: string | null;
  createdAt: string;
  updatedAt: string;
  liveEstimate: Estimate;
}

type Step = "routes" | "creative" | "estimate" | "schedule" | "brief" | "timeline";

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
const dateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

// ---------------------------------------------------------------------------
// Agentic OS atoms
// ---------------------------------------------------------------------------
// Visual migration only: same layout, same behavior. Order, route, and
// creative statuses are workflow states, so every chip renders neutral —
// never a status color. The `tone` prop stays for call-site compatibility.

type Tone = "violet" | "green" | "amber" | "red" | "blue" | "stone" | "zinc";

function Chip({ tone, children, title }: { tone?: Tone; children: React.ReactNode; title?: string }) {
  void tone;
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-px text-[0.6875rem] font-medium leading-4 text-muted shadow-control"
    >
      {children}
    </span>
  );
}

const inputCls =
  "w-full h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-50";
const btnPrimary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnSecondary =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";
const btnDanger =
  "inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40";

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      {children}
      {hint ? <span className="mt-0.5 block text-[0.6875rem] text-subtle">{hint}</span> : null}
    </label>
  );
}

function Card({ title, icon, children, action }: { title: string; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h3 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-ink">
          {icon}
          {title}
        </h3>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Err({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md bg-failed-tint px-2.5 py-2 text-[0.75rem] text-failed-text">
      <span className="aos-shape aos-shape--failed mt-0.5 shrink-0" role="img" aria-label="Error" />
      <span>{message}</span>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start gap-2 rounded-md bg-canvas px-2.5 py-2 text-[0.75rem] text-muted">
      <Info size={14} className="mt-0.5 shrink-0 text-ink" />
      <span>{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const STEPS: Array<{ key: Step; label: string; icon: React.ReactNode }> = [
  { key: "routes", label: "Routes", icon: <MapPin size={13} /> },
  { key: "creative", label: "Creative", icon: <Palette size={13} /> },
  { key: "estimate", label: "Estimate", icon: <Calculator size={13} /> },
  { key: "schedule", label: "Schedule", icon: <CalendarDays size={13} /> },
  { key: "brief", label: "Handoff brief", icon: <FileText size={13} /> },
  { key: "timeline", label: "Status", icon: <Truck size={13} /> },
];

const NEXT_STATUSES: Record<string, string[]> = {
  draft: ["briefed", "cancelled"],
  briefed: ["at_mailhouse", "cancelled"],
  at_mailhouse: ["dropped", "cancelled"],
  dropped: ["complete"],
  complete: [],
  cancelled: [],
};

export function EddmApp() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Order | null>(null);
  const [step, setStep] = useState<Step>("routes");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const loadOrders = useCallback(async () => {
    const data = await api<{ orders: Order[] }>("/api/eddm/orders");
    setOrders(data.orders);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const data = await api<{ order: Order }>(`/api/eddm/orders/${id}`);
    setDetail(data.order);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ orders: Order[] }>("/api/eddm/orders");
        if (!cancelled) setOrders(data.orders);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load EDDM orders");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openOrder = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setError(null);
      try {
        await loadDetail(id);
        setStep("routes");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load order");
      }
    },
    [loadDetail],
  );

  const refresh = useCallback(async () => {
    await loadOrders();
    if (selectedId) await loadDetail(selectedId);
  }, [loadOrders, loadDetail, selectedId]);

  if (loading) return <p className="text-[0.8125rem] text-muted">Loading EDDM orders…</p>;

  if (!selectedId || !detail) {
    return (
      <div>
        <Err message={error} />
        <div className="mb-3 flex justify-end">
          <button className={btnPrimary} onClick={() => setShowNew(true)}>
            <Plus size={14} /> New EDDM order
          </button>
        </div>
        {orders.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-paper px-4 py-10 text-center">
            <p className="text-[0.8125rem] font-medium text-ink">No EDDM orders yet</p>
            <p className="mt-1 text-[0.75rem] text-subtle">
              Plan a saturation drop: pick carrier routes, bind an EDDM flat creative, estimate
              costs, and generate the mailhouse handoff brief.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
            <table className="w-full text-[0.8125rem]">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                  <th className="px-3 py-2">Order</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Pieces</th>
                  <th className="px-3 py-2 text-right">Est. cost</th>
                  <th className="px-3 py-2">Drop date</th>
                  <th className="px-3 py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper"
                    onClick={() => openOrder(o.id)}
                    tabIndex={0}
                    onKeyDown={activateOnKey(() => openOrder(o.id))}
                  >
                    <td className="px-3 py-2 font-medium text-ink">{o.name}</td>
                    <td className="px-3 py-2">
                      <Chip>{o.status.replace(/_/g, " ")}</Chip>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">
                      {o.pieceCount.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted">{money(o.costCents)}</td>
                    <td className="px-3 py-2 text-muted">{fmtDate(o.dropDate)}</td>
                    <td className="px-3 py-2 text-muted">{fmtDate(o.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showNew && (
          <NewOrderModal
            onClose={() => setShowNew(false)}
            onCreated={async (id) => {
              setShowNew(false);
              await refresh();
              openOrder(id);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Err message={error} />
      <OrderHeader
        order={detail}
        onBack={() => {
          setSelectedId(null);
          setDetail(null);
          refresh();
        }}
        onRenamed={refresh}
        onError={setError}
      />
      <div className="flex flex-wrap gap-1.5">
        {STEPS.map((s) => (
          <button
            key={s.key}
            onClick={() => setStep(s.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[0.8125rem] font-medium ${
              step === s.key
                ? "border-ink bg-ink text-white"
                : "border-line bg-paper text-muted hover:bg-hover-paper"
            }`}
          >
            {s.icon}
            {s.label}
            {stepDone(detail, s.key) && step !== s.key ? <Check size={12} className="text-ink" /> : null}
          </button>
        ))}
      </div>
      {step === "routes" && <RoutesStep order={detail} onSaved={refresh} onError={setError} />}
      {step === "creative" && <CreativeStep order={detail} onSaved={refresh} onError={setError} />}
      {step === "estimate" && <EstimateStep order={detail} onSaved={refresh} onError={setError} />}
      {step === "schedule" && <ScheduleStep order={detail} onSaved={refresh} onError={setError} />}
      {step === "brief" && <BriefStep order={detail} onSaved={refresh} onError={setError} />}
      {step === "timeline" && <TimelineStep order={detail} onSaved={refresh} onError={setError} />}
    </div>
  );
}

function stepDone(order: Order, step: Step): boolean {
  switch (step) {
    case "routes":
      return order.pieceCount > 0;
    case "creative":
      return !!order.creativeId;
    case "estimate":
      return order.costCents > 0;
    case "schedule":
      return !!order.dropDate;
    case "brief":
      return !!order.briefPdfUrl;
    case "timeline":
      return order.status !== "draft";
  }
}

// ---------------------------------------------------------------------------
// Order header (name + mailhouse inline edit)
// ---------------------------------------------------------------------------

function OrderHeader({
  order,
  onBack,
  onRenamed,
  onError,
}: {
  order: Order;
  onBack: () => void;
  onRenamed: () => Promise<void>;
  onError: (m: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(order.name);
  const [mailhouse, setMailhouse] = useState(order.mailhouse ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    onError(null);
    try {
      await api(`/api/eddm/orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, mailhouse: mailhouse || null }),
      });
      setEditing(false);
      await onRenamed();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const editable = order.status === "draft" || order.status === "briefed";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-paper px-4 py-3 shadow-hairline">
      <button onClick={onBack} className="rounded-full p-1 text-muted hover:bg-hover-paper hover:text-ink" aria-label="Back to orders">
        <ArrowLeft size={16} />
      </button>
      {editing ? (
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <input className={inputCls} style={{ maxWidth: 260 }} value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className={inputCls}
            style={{ maxWidth: 220 }}
            placeholder="Mailhouse (optional)"
            value={mailhouse}
            onChange={(e) => setMailhouse(e.target.value)}
          />
          <button className={btnPrimary} disabled={saving} onClick={save}>
            <Check size={14} /> Save
          </button>
          <button className={btnSecondary} onClick={() => setEditing(false)} aria-label="Cancel editing">
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : (
        <>
          <h2 className="text-[0.9375rem] font-semibold text-ink">{order.name}</h2>
          <Chip>{order.status.replace(/_/g, " ")}</Chip>
          {order.mailhouse ? <Chip>{order.mailhouse}</Chip> : null}
          {editable ? (
            <button
              className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink"
              onClick={() => {
                setName(order.name);
                setMailhouse(order.mailhouse ?? "");
                setEditing(true);
              }}
              aria-label="Edit order"
            >
              <Pencil size={14} />
            </button>
          ) : null}
        </>
      )}
      <div className="ml-auto flex items-center gap-3 text-[0.75rem] text-muted">
        <span>
          <strong className="text-ink">{order.pieceCount.toLocaleString()}</strong> pieces
        </span>
        <span>
          <strong className="text-ink">{money(order.costCents)}</strong> est.
        </span>
      </div>
    </div>
  );
}

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [mailhouse, setMailhouse] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await api<{ order: Order }>("/api/eddm/orders", {
        method: "POST",
        body: JSON.stringify({ name, mailhouse: mailhouse || null }),
      });
      onCreated(data.order.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-night/30 p-4 pt-[8vh]" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div className="w-full max-w-xl rounded-lg border border-line bg-paper shadow-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[0.875rem] font-semibold text-ink">New EDDM order</h3>
          <button onClick={onClose} className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <Err message={error} />
          <Field label="Order name">
            <input className={inputCls} placeholder="e.g. Fall 2026 — 27408 saturation" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Mailhouse (optional)" hint="The mailhouse that will print, prep, and drop this mailing.">
            <input className={inputCls} placeholder="e.g. Triad Direct Mail" value={mailhouse} onChange={(e) => setMailhouse(e.target.value)} />
          </Field>
          <Note>
            There is no USPS EDDM API — your mailhouse executes the drop. ShapesOS plans it and
            produces the handoff brief they work from.
          </Note>
          <div className="flex justify-end gap-2">
            <button className={btnSecondary} onClick={onClose}>Cancel</button>
            <button className={btnPrimary} disabled={saving || !name.trim()} onClick={create}>
              <Plus size={14} /> Create order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — carrier routes (manual entry v1)
// ---------------------------------------------------------------------------

function RoutesStep({ order, onSaved, onError }: { order: Order; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const editable = order.status === "draft";
  const [rows, setRows] = useState<RouteRow[]>(
    order.routes.length ? order.routes : [{ zip: "", routeId: "", households: 0, selected: true }],
  );
  const [tier, setTier] = useState<"retail" | "bmeu">("retail");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<RouteRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const addRow = () => setRows((rs) => [...rs, { zip: "", routeId: "", households: 0, selected: true }]);
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i));

  const selectedPieces = useMemo(
    () => rows.filter((r) => r.selected).reduce((s, r) => s + (Number.isFinite(r.households) ? r.households : 0), 0),
    [rows],
  );

  const save = async () => {
    setSaving(true);
    setLocalError(null);
    onError(null);
    try {
      await api(`/api/eddm/orders/${order.id}/routes`, {
        method: "PUT",
        body: JSON.stringify({ routes: rows, postageTier: tier }),
      });
      await onSaved();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Carrier routes"
      icon={<MapPin size={14} className="text-ink" />}
      action={
        editable ? (
          <button className={btnPrimary} disabled={saving} onClick={save}>
            <Check size={14} /> Save routes
          </button>
        ) : (
          <Chip>Locked — order is {order.status.replace(/_/g, " ")}</Chip>
        )
      }
    >
      <Err message={localError} />
      <Note>
        Route counts are manual entry in v1 — pull them from the USPS EDDM route tool and{" "}
        <strong>verify with your mailhouse</strong> before print. EDDM Retail requires a minimum
        of 200 pieces per selected route.
      </Note>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-xs font-semibold text-muted">Postage entry:</span>
        {(["retail", "bmeu"] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5 text-[0.8125rem] text-ink">
            <input type="radio" checked={tier === t} onChange={() => setTier(t)} disabled={!editable} />
            {t === "retail" ? "Retail — 26.0¢/pc" : "BMEU — 25.9¢/pc"}
          </label>
        ))}
      </div>
      <div className="overflow-hidden rounded-md border border-line">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold text-muted">
              <th className="px-2 py-1.5">ZIP</th>
              <th className="px-2 py-1.5">Route</th>
              <th className="px-2 py-1.5 text-right">Households</th>
              <th className="px-2 py-1.5 text-center">Selected</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-2 py-1.5">
                  <input
                    className={inputCls}
                    style={{ maxWidth: 110 }}
                    placeholder="27408"
                    value={r.zip}
                    disabled={!editable}
                    onChange={(e) => setRow(i, { zip: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={inputCls}
                    style={{ maxWidth: 110 }}
                    placeholder="C001"
                    value={r.routeId}
                    disabled={!editable}
                    onChange={(e) => setRow(i, { routeId: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={inputCls}
                    style={{ maxWidth: 120, textAlign: "right" }}
                    type="number"
                    min={0}
                    value={r.households || ""}
                    placeholder="0"
                    disabled={!editable}
                    onChange={(e) => setRow(i, { households: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                  />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={r.selected}
                    disabled={!editable}
                    onChange={(e) => setRow(i, { selected: e.target.checked })}
                    className="h-4 w-4 accent-ink"
                  />
                </td>
                <td className="px-2 py-1.5 text-right">
                  {editable && rows.length > 1 ? (
                    <button className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-failed-text" onClick={() => removeRow(i)} aria-label="Remove route">
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between">
        {editable ? (
          <button className={btnSecondary} onClick={addRow}>
            <Plus size={14} /> Add route
          </button>
        ) : (
          <span />
        )}
        <p className="text-[0.8125rem] text-muted">
          <strong className="text-ink">{selectedPieces.toLocaleString()}</strong> pieces across{" "}
          <strong className="text-ink">{rows.filter((r) => r.selected).length}</strong> selected routes
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — creative (EDDM format track only)
// ---------------------------------------------------------------------------

function CreativeStep({ order, onSaved, onError }: { order: Order; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const editable = order.status === "draft" || order.status === "briefed";
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [binding, setBinding] = useState<string | null>(null);

  useEffect(() => {
    api<{ creatives: Creative[] }>("/api/eddm/creatives")
      .then((d) => setCreatives(d.creatives))
      .catch((e) => setLocalError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const bind = async (creativeId: string) => {
    setBinding(creativeId);
    setLocalError(null);
    onError(null);
    try {
      await api(`/api/eddm/orders/${order.id}/creative`, {
        method: "PUT",
        body: JSON.stringify({ creativeId }),
      });
      await onSaved();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Bind failed");
    } finally {
      setBinding(null);
    }
  };

  return (
    <Card
      title="Creative — EDDM flat"
      icon={<Palette size={14} className="text-ink" />}
      action={
        <a href="/dashboard/studio?formatTrack=eddm" className={btnSecondary}>
          Open Studio <ChevronRight size={14} />
        </a>
      }
    >
      <Err message={localError} />
      <Note>
        EDDM requires a <strong>flat of at least 6.125″ × 11.5″</strong> — a 4×6 postcard does not
        qualify for EDDM postage and is rejected here. Design or upload EDDM-track creative in the
        Studio, then bind it below.
      </Note>
      {loading ? (
        <p className="text-[0.8125rem] text-muted">Loading EDDM-track creative…</p>
      ) : creatives.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-8 text-center">
          <p className="text-[0.8125rem] font-medium text-ink">No EDDM-track creative yet</p>
          <p className="mt-1 text-[0.75rem] text-subtle">
            Create one in the Studio on the EDDM flat format track, then return to bind it.
          </p>
        </div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {creatives.map((c) => {
            const bound = order.creativeId === c.id;
            return (
              <div
                key={c.id}
                className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 ${
                  bound ? "border-ink bg-canvas" : "border-line bg-paper"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[0.8125rem] font-medium text-ink">{c.name}</p>
                  <p className="text-[0.6875rem] text-muted">
                    {c.size} · v{c.version} · {c.status}
                    {c.creativeHash ? ` · ${c.creativeHash.slice(0, 10)}…` : ""}
                  </p>
                </div>
                {bound ? (
                  <Chip>
                    <Check size={11} /> Bound
                  </Chip>
                ) : editable ? (
                  <button className={btnSecondary} disabled={binding != null} onClick={() => bind(c.id)}>
                    {binding === c.id ? "Binding…" : "Bind"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — cost estimate
// ---------------------------------------------------------------------------

function EstimateStep({ order, onSaved, onError }: { order: Order; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const editable = order.status === "draft" || order.status === "briefed";
  const [tier, setTier] = useState<"retail" | "bmeu">("retail");
  const [printCents, setPrintCents] = useState("12");
  const [live, setLive] = useState<Estimate | null>(order.liveEstimate);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const data = await api<{ estimate: Estimate }>(
          `/api/eddm/orders/${order.id}/estimate?postageTier=${tier}&printCentsPerPiece=${encodeURIComponent(printCents || "0")}`,
        );
        setLive(data.estimate);
      } catch {
        // ignore transient fetch errors while typing
      }
    }, 300);
    return () => clearTimeout(t);
  }, [order.id, tier, printCents]);

  const save = async () => {
    setSaving(true);
    setLocalError(null);
    onError(null);
    try {
      await api(`/api/eddm/orders/${order.id}/estimate`, {
        method: "POST",
        body: JSON.stringify({ postageTier: tier, printCentsPerPiece: Number(printCents) || 0 }),
      });
      await onSaved();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const est = live;

  return (
    <Card
      title="Cost estimate"
      icon={<Calculator size={14} className="text-ink" />}
      action={
        editable ? (
          <button className={btnPrimary} disabled={saving || !est || est.pieceCount === 0} onClick={save}>
            <Check size={14} /> Save estimate
          </button>
        ) : null
      }
    >
      <Err message={localError} />
      <Note>
        Estimates only — postage is paid at acceptance (EDDM Retail) or via permit imprint (BMEU).
        No spend is authorized in ShapesOS.
      </Note>
      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <Field label="Postage entry">
          <div className="flex gap-3 pt-1.5">
            {(["retail", "bmeu"] as const).map((t) => (
              <label key={t} className="flex items-center gap-1.5 text-[0.8125rem] text-ink">
                <input type="radio" checked={tier === t} onChange={() => setTier(t)} disabled={!editable} />
                {t === "retail" ? "Retail — 26.0¢/pc (2026)" : "BMEU — 25.9¢/pc (2026)"}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Print + prep (¢/pc)" hint="Editable assumption — confirm the real per-piece print/prep quote with your mailhouse.">
          <input
            className={inputCls}
            type="number"
            min={0}
            step={0.5}
            value={printCents}
            disabled={!editable}
            onChange={(e) => setPrintCents(e.target.value)}
          />
        </Field>
      </div>
      {est && est.pieceCount > 0 ? (
        <div className="overflow-hidden rounded-md border border-line">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2">Line</th>
                <th className="px-3 py-2 text-right">Per piece</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr className="border-b border-line">
                <td className="px-3 py-2 text-muted">Postage — {tier === "retail" ? "EDDM Retail" : "BMEU"}</td>
                <td className="px-3 py-2 text-right">{money(est.postageCentsPerPiece)}</td>
                <td className="px-3 py-2 text-right">{money(est.postageCents)}</td>
              </tr>
              <tr className="border-b border-line">
                <td className="px-3 py-2 text-muted">Print + prep</td>
                <td className="px-3 py-2 text-right">{money(est.printCentsPerPiece)}</td>
                <td className="px-3 py-2 text-right">{money(est.printCents)}</td>
              </tr>
              <tr className="bg-canvas font-semibold">
                <td className="px-3 py-2 text-ink">
                  Estimated total · {est.pieceCount.toLocaleString()} pieces
                </td>
                <td className="px-3 py-2 text-right text-ink">{money(est.perPieceCents)}</td>
                <td className="px-3 py-2 text-right text-ink">{money(est.totalCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[0.8125rem] text-muted">Add carrier routes first — the estimate is piece count × postage + print.</p>
      )}
      {est?.usedDefaults ? (
        <p className="mt-2 text-[0.6875rem] text-muted">Using the default print assumption until you enter a quote.</p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — drop scheduling
// ---------------------------------------------------------------------------

function inHomePreview(dropIso: string): string {
  if (!dropIso) return "—";
  const d = new Date(dropIso + "T12:00:00");
  if (Number.isNaN(d.getTime())) return "—";
  const s = new Date(d);
  s.setDate(s.getDate() + 3);
  const e = new Date(d);
  e.setDate(e.getDate() + 7);
  const f = (x: Date) => x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${f(s)} – ${f(e)}`;
}

function ScheduleStep({ order, onSaved, onError }: { order: Order; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const editable = order.status === "draft" || order.status === "briefed" || order.status === "at_mailhouse";
  const [dropDate, setDropDate] = useState(dateInput(order.dropDate));
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setLocalError(null);
    onError(null);
    try {
      await api(`/api/eddm/orders/${order.id}`, {
        method: "PATCH",
        body: JSON.stringify({ dropDate: dropDate || null }),
      });
      await onSaved();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Drop scheduling"
      icon={<CalendarDays size={14} className="text-ink" />}
      action={
        editable ? (
          <button className={btnPrimary} disabled={saving} onClick={save}>
            <Check size={14} /> Save schedule
          </button>
        ) : null
      }
    >
      <Err message={localError} />
      <Note>
        Physical mail has days of latency — timing is date-based. The in-home window is drop date +
        3–7 days (USPS transit estimate, not a guarantee). Your mailhouse executes the drop.
      </Note>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Drop date" hint="The date the mailhouse drops the mailing.">
          <input type="date" className={inputCls} value={dropDate} disabled={!editable} onChange={(e) => setDropDate(e.target.value)} />
        </Field>
        <Field label="In-home target window">
          <div className="rounded-md border border-line bg-canvas px-2 py-1.5 text-[0.8125rem] font-medium text-ink">
            {dropDate ? inHomePreview(dropDate) : order.inHomeStart ? `${fmtDate(order.inHomeStart)} – ${fmtDate(order.inHomeEnd)}` : "—"}
          </div>
        </Field>
        <Field label="Pieces">
          <div className="rounded-md border border-line bg-canvas px-2 py-1.5 text-[0.8125rem] font-medium text-ink">
            {order.pieceCount.toLocaleString()}
          </div>
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — handoff brief PDF
// ---------------------------------------------------------------------------

function BriefStep({ order, onSaved, onError }: { order: Order; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const canGenerate = order.status === "draft" || order.status === "briefed";
  const [tier, setTier] = useState<"retail" | "bmeu">("retail");
  const [printCents, setPrintCents] = useState("12");
  const [localError, setLocalError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [dropUrl, setDropUrl] = useState<string | null>(null);

  const ready = order.pieceCount > 0 && !!order.creativeId;

  const generate = async () => {
    setGenerating(true);
    setLocalError(null);
    onError(null);
    try {
      const data = await api<{ briefPdfUrl: string; dropUrl: string; qrSlug: string }>(
        `/api/eddm/orders/${order.id}/brief`,
        {
          method: "POST",
          body: JSON.stringify({ postageTier: tier, printCentsPerPiece: Number(printCents) || 0 }),
        },
      );
      setDropUrl(data.dropUrl);
      await onSaved();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Brief generation failed");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Card
      title="Mailhouse handoff brief"
      icon={<FileText size={14} className="text-ink" />}
      action={
        order.briefPdfUrl ? (
          <a href={order.briefPdfUrl} className={btnSecondary} download>
            <Download size={14} /> Download PDF
          </a>
        ) : undefined
      }
    >
      <Err message={localError} />
      <Note>
        The brief packages everything your mailhouse needs: carrier routes and counts, the creative
        spec, the in-home target window, facing-slip prep notes, the drop QR/pURL, and the cost
        summary. Generating it advances the order to <strong>briefed</strong>.
      </Note>
      {!ready ? (
        <p className="text-[0.8125rem] text-muted">
          Bind an EDDM creative and add carrier routes first — the brief needs both.
        </p>
      ) : (
        <>
          <div className="mb-4 grid gap-3 md:grid-cols-2">
            <Field label="Postage entry (for the brief's cost summary)">
              <div className="flex gap-3 pt-1.5">
                {(["retail", "bmeu"] as const).map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-[0.8125rem] text-ink">
                    <input type="radio" checked={tier === t} onChange={() => setTier(t)} disabled={!canGenerate} />
                    {t === "retail" ? "Retail — 26.0¢/pc" : "BMEU — 25.9¢/pc"}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Print + prep (¢/pc)">
              <input
                className={inputCls}
                type="number"
                min={0}
                step={0.5}
                value={printCents}
                disabled={!canGenerate}
                onChange={(e) => setPrintCents(e.target.value)}
              />
            </Field>
          </div>
          {canGenerate ? (
            <button className={btnPrimary} disabled={generating} onClick={generate}>
              <FileText size={14} /> {generating ? "Generating…" : order.briefPdfUrl ? "Regenerate brief PDF" : "Generate handoff brief PDF"}
            </button>
          ) : (
            <Chip>Order is {order.status.replace(/_/g, " ")} — brief is locked</Chip>
          )}
        </>
      )}
      {order.briefPdfUrl ? (
        <div className="mt-4 rounded-md border border-line bg-canvas p-3 text-[0.75rem] text-muted">
          <p className="font-medium text-ink">Brief ready</p>
          <p className="mt-1 flex items-center gap-1.5">
            <QrCode size={13} className="text-ink" /> Drop QR slug:{" "}
            <code className="rounded bg-paper px-1 py-px aos-mono text-[0.6875rem]">{order.qrSlug ?? "—"}</code>
          </p>
          {dropUrl ? (
            <p className="mt-1 flex items-center gap-1.5">
              <Link2 size={13} className="text-ink" /> pURL:{" "}
              <code className="break-all rounded bg-paper px-1 py-px aos-mono text-[0.6875rem]">{dropUrl}</code>
            </p>
          ) : null}
          <p className="mt-1 text-[0.6875rem] text-subtle">
            Confirm the scan target resolves before print — the drop pURL is reserved for this drop&apos;s attribution.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 6 — status timeline
// ---------------------------------------------------------------------------

const TIMELINE: string[] = ["draft", "briefed", "at_mailhouse", "dropped", "complete"];

function TimelineStep({ order, onSaved, onError }: { order: Order; onSaved: () => Promise<void>; onError: (m: string | null) => void }) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const transition = async (to: string) => {
    setBusy(to);
    setLocalError(null);
    onError(null);
    try {
      await api(`/api/eddm/orders/${order.id}/status`, {
        method: "POST",
        body: JSON.stringify({ to, dropDate: to === "dropped" && order.dropDate ? order.dropDate : undefined }),
      });
      setConfirmCancel(false);
      await onSaved();
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Transition failed");
    } finally {
      setBusy(null);
    }
  };

  const next = NEXT_STATUSES[order.status] ?? [];
  const currentIdx = order.status === "cancelled" ? -1 : TIMELINE.indexOf(order.status);

  return (
    <Card title="Status tracking" icon={<Truck size={14} className="text-ink" />}>
      <Err message={localError} />
      {order.status === "cancelled" ? (
        <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
          <Chip>cancelled</Chip> This order was cancelled. No spend occurred — estimates only.
        </div>
      ) : (
        <>
          <ol className="mb-4 flex flex-col gap-0">
            {TIMELINE.map((s, i) => {
              const done = i < currentIdx;
              const current = i === currentIdx;
              return (
                <li key={s} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={`flex h-6 w-6 items-center justify-center rounded-full border-[1.5px] text-[0.6875rem] font-semibold ${
                        done
                          ? "border-ink bg-ink text-white"
                          : current
                            ? "border-ink bg-paper text-ink"
                            : "border-line bg-paper text-subtle"
                      }`}
                    >
                      {done ? <Check size={12} /> : i + 1}
                    </span>
                    {i < TIMELINE.length - 1 ? <span className="h-5 w-px bg-line" /> : null}
                  </div>
                  <div className="pb-4">
                    <p className={`text-[0.8125rem] font-medium ${current ? "text-ink" : done ? "text-muted" : "text-subtle"}`}>
                      {s.replace(/_/g, " ")}
                      {current ? <Chip>current</Chip> : null}
                    </p>
                    <p className="text-[0.6875rem] text-subtle">
                      {s === "dropped" && order.inHomeStart
                        ? `In-home target ${fmtDate(order.inHomeStart)} – ${fmtDate(order.inHomeEnd)}`
                        : s === "dropped" && order.dropDate
                          ? `Drop date ${fmtDate(order.dropDate)}`
                          : stepHint(s)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
          {next.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[0.75rem] font-semibold text-muted">Advance:</span>
              {next.map((to) =>
                to === "cancelled" ? (
                  confirmCancel ? (
                    <span key={to} className="inline-flex items-center gap-2">
                      <span className="text-[0.75rem] text-muted">Cancel this order? No spend occurred.</span>
                      <button className={btnDanger} disabled={busy != null} onClick={() => transition("cancelled")}>
                        Confirm cancel
                      </button>
                      <button className={btnSecondary} onClick={() => setConfirmCancel(false)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button key={to} className={btnSecondary} onClick={() => setConfirmCancel(true)}>
                      <X size={14} /> Cancel order
                    </button>
                  )
                ) : (
                  <button key={to} className={btnPrimary} disabled={busy != null} onClick={() => transition(to)}>
                    {busy === to ? "Working…" : `Mark ${to.replace(/_/g, " ")}`}
                  </button>
                ),
              )}
            </div>
          ) : (
            <p className="text-[0.75rem] text-muted">Terminal state — nothing left to do.</p>
          )}
          {next.includes("dropped") && !order.dropDate ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-md bg-needs-tint p-2 text-[0.75rem] text-ink">
              <span className="aos-shape aos-shape--needs aos-shape--edged shrink-0" role="img" aria-label="Warning" /> Set a drop date (Schedule step) before marking the order dropped.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function stepHint(s: string): string {
  switch (s) {
    case "draft":
      return "Planning — routes, creative, estimate.";
    case "briefed":
      return "Handoff brief generated and sent to the mailhouse.";
    case "at_mailhouse":
      return "Mailhouse has the brief — printing and prep in progress.";
    case "dropped":
      return "Mail dropped — in-home window starts (drop + 3–7 days).";
    case "complete":
      return "Drop complete — attribution flows through the drop QR/pURL.";
    default:
      return "";
  }
}
