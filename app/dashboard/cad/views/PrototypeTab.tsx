"use client";

// Marketr — CAD + Hardware slice 3: prototype pipeline.
// BOMs pinned to model versions, labeled cost estimates, and the vendor
// export / quote-request flow.
//
// THE v1 BOUNDARY, stated in the UI as well as the code: nothing here calls
// a vendor API or places an order. A quote request is a draft the tenant
// reviews and confirms; confirming writes the vendor-ready export package
// (model file + manifest with checksum + process parameters +
// contact/shipping). "Sending" records the tenant's own transmission as an
// auditable event (who, when, to whom, via which connected account).

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Package,
  Plus,
  Trash2,
  Pencil,
  Download,
  Send,
  Calculator,
  Factory,
  FileText,
  AlertTriangle,
  X,
  CheckCircle2,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

interface VersionLite {
  id: string;
  versionNumber: number;
  fileName: string;
  format: "stl" | "obj" | "step";
}

interface RateCard {
  id: string;
  name: string;
  process: "3d_print" | "pcb" | "cnc";
  currency: string;
  rates: { setupUsd?: number; perUnitUsd?: number; perCm3Usd?: number; notes?: string };
  isDefault: boolean;
  source: string | null;
}

interface BomVersion {
  id: string;
  bomNumber: number;
  modelVersionId: string;
  notes: string | null;
  createdAt: string;
  modelVersion: { id: string; versionNumber: number; format: string };
  _count: { lines: number };
}

interface BomRollupLine {
  lineId: string;
  partName: string;
  qty: number;
  unitName: string;
  materialSpec?: string;
  supplier?: string;
  unitCostUsd: number | null;
  lineTotalUsd: number;
  missingCost: boolean;
  source: string;
}

interface BomRollup {
  lineCount: number;
  totalUsd: number;
  linesMissingCost: number;
  lines: BomRollupLine[];
}

interface CostBasis {
  isEstimate: true;
  currency: string;
  quantity: number;
  bomTotalUsd: number;
  bomExtendedUsd: number;
  process: {
    setupUsd: number | null;
    volumeComponentUsd: number | null;
    perUnitComponentUsd: number | null;
    totalUsd: number;
    volumeCm3: number | null;
  };
  grandTotalUsd: number;
  perUnitUsd: number | null;
  rateCard: { id: string; name: string };
  warnings: string[];
}

interface CostEstimate {
  id: string;
  quantity: number;
  currency: string;
  bomTotalUsd: number;
  processCostUsd: number;
  grandTotalUsd: number;
  perUnitUsd: number | null;
  basis: CostBasis;
  createdAt: string;
  rateCard: { id: string; name: string; process: string };
  bomVersion: { id: string; bomNumber: number };
}

interface ExportRequest {
  id: string;
  modelVersionId: string;
  process: "3d_print" | "pcb" | "cnc";
  quantity: number;
  processOptions: Record<string, string>;
  contact: { name: string; email: string; addressLines: string[] };
  status: "draft" | "confirmed" | "sent";
  manifestPath: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  sentBy: string | null;
  sentAt: string | null;
  recipient: string | null;
  sentViaAccount: string | null;
  createdAt: string;
  modelVersion: { id: string; versionNumber: number; format: string };
}

const PROCESS_LABEL: Record<string, string> = { "3d_print": "3D print", pcb: "PCB", cnc: "CNC" };

const PROCESS_OPTIONS: Record<string, { key: string; label: string; placeholder: string }[]> = {
  "3d_print": [
    { key: "material", label: "Material", placeholder: "e.g. PETG, ASA, Nylon" },
    { key: "infillPercent", label: "Infill %", placeholder: "e.g. 20" },
    { key: "layerHeightMm", label: "Layer height (mm)", placeholder: "e.g. 0.2" },
  ],
  pcb: [
    { key: "layers", label: "Layers", placeholder: "e.g. 4" },
    { key: "thicknessMm", label: "Board thickness (mm)", placeholder: "e.g. 1.6" },
    { key: "finish", label: "Surface finish", placeholder: "e.g. ENIG, HASL" },
    { key: "solderMask", label: "Solder mask color", placeholder: "e.g. green" },
  ],
  cnc: [
    { key: "material", label: "Material", placeholder: "e.g. 6061 aluminum" },
    { key: "toleranceMm", label: "Tolerance (mm)", placeholder: "e.g. ±0.1" },
    { key: "finish", label: "Finish", placeholder: "e.g. bead blast, anodized" },
  ],
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

function money(n: number | null | undefined, currency = "USD"): string {
  if (n == null) return "—";
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${n.toFixed(2)}`;
}

const inputCls =
  "h-10 rounded-lg border border-line bg-paper px-3 text-sm text-ink placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-ink";
const btnPrimary =
  "flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40";
const btnGhost =
  "flex h-10 items-center gap-2 rounded-full border border-line bg-paper px-4 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-40";

export function PrototypeTab({
  modelId,
  versions,
  currentVersionId,
}: {
  modelId: string;
  versions: VersionLite[];
  currentVersionId: string | null;
}) {
  const [versionId, setVersionId] = useState(currentVersionId ?? versions[0]?.id ?? "");
  const version = versions.find((v) => v.id === versionId);

  const [rateCards, setRateCards] = useState<RateCard[]>([]);
  const [boms, setBoms] = useState<BomVersion[]>([]);
  const [estimates, setEstimates] = useState<CostEstimate[]>([]);
  const [requests, setRequests] = useState<ExportRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!versionId) return;
    setLoading(true);
    setError(null);
    try {
      const [rc, bm, es, rq] = await Promise.all([
        api<{ rateCards: RateCard[] }>("/api/cad/rate-cards"),
        api<{ boms: BomVersion[] }>(`/api/cad/models/${modelId}/bom`),
        api<{ estimates: CostEstimate[] }>(`/api/cad/models/${modelId}/versions/${versionId}/cost-estimates`),
        api<{ requests: ExportRequest[] }>(`/api/cad/models/${modelId}/versions/${versionId}/export-requests`),
      ]);
      setRateCards(rc.rateCards);
      setBoms(bm.boms);
      setEstimates(es.estimates);
      setRequests(rq.requests);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load prototype data.");
    } finally {
      setLoading(false);
    }
  }, [modelId, versionId]);

  useEffect(() => {
    load();
  }, [load]);

  const bomsForVersion = boms.filter((b) => b.modelVersionId === versionId);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-paper p-4 shadow-hairline">
        <label htmlFor="proto-version" className="text-sm font-semibold text-ink">
          Model version
        </label>
        <select
          id="proto-version"
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
          className="h-10 rounded-full border border-line bg-paper px-3 text-sm text-ink"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.versionNumber} — {v.fileName}
            </option>
          ))}
        </select>
        <p className="w-full text-xs text-muted">
          BOMs pin to one version and never move when newer versions publish. Estimates and
          export requests belong to the selected version.
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-line bg-paper p-4 text-sm text-ink shadow-hairline">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading prototype pipeline…
        </div>
      ) : (
        <>
          <BomSection
            modelId={modelId}
            version={version}
            boms={bomsForVersion}
            onChanged={load}
          />
          <CostSection
            modelId={modelId}
            versionId={versionId}
            boms={bomsForVersion}
            rateCards={rateCards}
            estimates={estimates}
            onChanged={load}
          />
          <ExportSection
            modelId={modelId}
            versionId={versionId}
            requests={requests}
            onChanged={load}
          />
          <RateCardSection rateCards={rateCards} onChanged={load} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------------

function BomSection({
  modelId,
  version,
  boms,
  onChanged,
}: {
  modelId: string;
  version: VersionLite | undefined;
  boms: BomVersion[];
  onChanged: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ bom: BomVersion; rollup: BomRollup } | null>(null);
  const [creating, setCreating] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Line form state
  const [partName, setPartName] = useState("");
  const [qty, setQty] = useState("1");
  const [unitName, setUnitName] = useState("pcs");
  const [materialSpec, setMaterialSpec] = useState("");
  const [supplier, setSupplier] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const selected = boms.find((b) => b.id === (selectedId ?? boms[0]?.id)) ?? null;

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api<{ bom: BomVersion; rollup: BomRollup }>(`/api/cad/bom/${id}`);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load BOM.");
    }
  }, []);

  useEffect(() => {
    if (selected) {
      setSelectedId(selected.id);
      loadDetail(selected.id);
    } else {
      setDetail(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function createBom() {
    if (!version) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/cad/models/${modelId}/bom`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelVersionId: version.id, notes: notes || undefined }),
      });
      setNotes("");
      setCreating(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create BOM.");
    } finally {
      setBusy(false);
    }
  }

  async function saveLine() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const payload = {
        partName,
        qty: Number(qty),
        unitName: unitName || "pcs",
        materialSpec: materialSpec || undefined,
        supplier: supplier || undefined,
        unitCostUsd: unitCost === "" ? null : Number(unitCost),
      };
      if (editingId) {
        await api(`/api/cad/bom-lines/${editingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        await api(`/api/cad/bom/${selected.id}/lines`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      setPartName("");
      setQty("1");
      setUnitName("pcs");
      setMaterialSpec("");
      setSupplier("");
      setUnitCost("");
      setEditingId(null);
      await loadDetail(selected.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save line.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteLine(lineId: string) {
    if (!selected) return;
    const ok = await confirmAction({
      title: "Delete this BOM line?",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/api/cad/bom-lines/${lineId}`, { method: "DELETE" });
      await loadDetail(selected.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete line.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Bill of materials" className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <FileText className="h-4 w-4" aria-hidden /> Bill of materials
        </h3>
        <button type="button" className={btnGhost} onClick={() => setCreating((c) => !c)}>
          <Plus className="h-4 w-4" aria-hidden /> New BOM for this version
        </button>
      </div>

      {creating && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-canvas p-3">
          <div className="min-w-56 flex-1">
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="bom-notes">
              Notes (optional)
            </label>
            <input
              id="bom-notes"
              className={inputCls + " w-full"}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. airframe rev B part list"
            />
          </div>
          <button type="button" className={btnPrimary} disabled={busy} onClick={createBom}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Create BOM
          </button>
        </div>
      )}

      {boms.length === 0 ? (
        <p className="text-sm text-muted">
          No BOM yet for v{version?.versionNumber}. Create one to start the part list — every
          line is tenant-entered; v1 derives nothing automatically.
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {boms.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedId(b.id)}
                className={`flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${
                  selected?.id === b.id ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink"
                }`}
              >
                BOM #{b.bomNumber}
                <span className="text-xs font-normal opacity-70">{b._count.lines} lines</span>
              </button>
            ))}
          </div>

          {detail && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-muted">
                      <th className="py-2 pr-3">Part</th>
                      <th className="py-2 pr-3">Qty</th>
                      <th className="py-2 pr-3">Material / spec</th>
                      <th className="py-2 pr-3">Supplier</th>
                      <th className="py-2 pr-3 text-right">Unit cost</th>
                      <th className="py-2 pr-3 text-right">Line total</th>
                      <th className="py-2 pr-3">Source</th>
                      <th className="py-2" aria-label="Actions" />
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rollup.lines.map((l) => (
                      <tr key={l.lineId} className="border-b border-line/60 hover:bg-canvas/60">
                        <td className="py-2 pr-3 font-medium text-ink">{l.partName}</td>
                        <td className="py-2 pr-3 text-muted">
                          {l.qty} {l.unitName}
                        </td>
                        <td className="py-2 pr-3 text-muted">{l.materialSpec ?? "—"}</td>
                        <td className="py-2 pr-3 text-muted">{l.supplier ?? "—"}</td>
                        <td className="py-2 pr-3 text-right text-muted">
                          {l.unitCostUsd == null ? <span className="italic">unknown</span> : money(l.unitCostUsd)}
                        </td>
                        <td className="py-2 pr-3 text-right font-semibold text-ink">{money(l.lineTotalUsd)}</td>
                        <td className="py-2 pr-3">
                          <span className="inline-flex h-6 items-center rounded-full border border-line px-2 text-xs font-semibold text-muted">
                            {l.source}
                          </span>
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            aria-label={`Edit ${l.partName}`}
                            className="mr-1 rounded-full p-2 text-muted hover:text-ink"
                            onClick={() => {
                              setEditingId(l.lineId);
                              setPartName(l.partName);
                              setQty(String(l.qty));
                              setUnitName(l.unitName);
                              setUnitCost(l.unitCostUsd == null ? "" : String(l.unitCostUsd));
                            }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${l.partName}`}
                            className="rounded-full p-2 text-muted hover:text-ink"
                            onClick={() => deleteLine(l.lineId)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-muted">
                  {detail.rollup.lineCount} lines
                  {detail.rollup.linesMissingCost > 0 && (
                    <span className="ml-2 italic">
                      · {detail.rollup.linesMissingCost} without a unit cost (counted as $0 — total is a lower bound)
                    </span>
                  )}
                </span>
                <span className="font-semibold text-ink">BOM total: {money(detail.rollup.totalUsd)}</span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-6">
                <input className={inputCls} value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="Part name *" aria-label="Part name" />
                <input className={inputCls} value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty *" inputMode="decimal" aria-label="Quantity" />
                <input className={inputCls} value={unitName} onChange={(e) => setUnitName(e.target.value)} placeholder="Unit (pcs)" aria-label="Unit" />
                <input className={inputCls} value={materialSpec} onChange={(e) => setMaterialSpec(e.target.value)} placeholder="Material / spec" aria-label="Material or spec" />
                <input className={inputCls} value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Supplier" aria-label="Supplier" />
                <input className={inputCls} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="Unit cost (USD)" inputMode="decimal" aria-label="Unit cost in USD" />
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" className={btnPrimary} disabled={busy || !partName.trim()} onClick={saveLine}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
                  {editingId ? "Save line" : "Add line"}
                </button>
                {editingId && (
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => {
                      setEditingId(null);
                      setPartName("");
                      setQty("1");
                      setUnitName("pcs");
                      setMaterialSpec("");
                      setSupplier("");
                      setUnitCost("");
                    }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {error && <p className="mt-2 text-sm text-ink">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cost estimates
// ---------------------------------------------------------------------------

function CostSection({
  modelId,
  versionId,
  boms,
  rateCards,
  estimates,
  onChanged,
}: {
  modelId: string;
  versionId: string;
  boms: BomVersion[];
  rateCards: RateCard[];
  estimates: CostEstimate[];
  onChanged: () => void;
}) {
  const [bomId, setBomId] = useState("");
  const [cardId, setCardId] = useState("");
  const [qty, setQty] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [delta, setDelta] = useState<{
    from: CostEstimate;
    to: CostEstimate;
    delta: { bomTotalDeltaUsd: number; processCostDeltaUsd: number; grandTotalDeltaUsd: number; perUnitDeltaUsd: number | null };
  } | null>(null);

  async function compute() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/cad/models/${modelId}/versions/${versionId}/cost-estimates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bomVersionId: bomId, rateCardId: cardId, quantity: Number(qty) }),
      });
      setDelta(null);
      setCompareIds([]);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to compute estimate.");
    } finally {
      setBusy(false);
    }
  }

  async function runCompare() {
    if (compareIds.length !== 2) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api<{
        from: CostEstimate;
        to: CostEstimate;
        delta: { bomTotalDeltaUsd: number; processCostDeltaUsd: number; grandTotalDeltaUsd: number; perUnitDeltaUsd: number | null };
      }>("/api/cad/cost-estimates/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromEstimateId: compareIds[0], toEstimateId: compareIds[1] }),
      });
      setDelta(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to compare.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Cost estimates" className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <Calculator className="h-4 w-4" aria-hidden /> Cost estimates
      </h3>

      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-canvas p-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="est-bom">BOM</label>
          <select id="est-bom" className={inputCls} value={bomId} onChange={(e) => setBomId(e.target.value)}>
            <option value="">Select BOM…</option>
            {boms.map((b) => (
              <option key={b.id} value={b.id}>
                BOM #{b.bomNumber} ({b._count.lines} lines)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="est-card">Rate card</label>
          <select id="est-card" className={inputCls} value={cardId} onChange={(e) => setCardId(e.target.value)}>
            <option value="">Select rate card…</option>
            {rateCards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({PROCESS_LABEL[c.process]})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="est-qty">Quantity</label>
          <input id="est-qty" className={inputCls + " w-28"} value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" />
        </div>
        <button type="button" className={btnPrimary} disabled={busy || !bomId || !cardId} onClick={compute}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Compute estimate
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Estimates only — BOM total × quantity plus the rate card&apos;s process cost. Every
        number is labeled; uncomputable components are marked, never invented. Nothing here
        is a vendor quote.
      </p>

      {estimates.length > 0 && (
        <div className="space-y-2">
          {estimates.map((e) => (
            <div key={e.id} className="rounded-lg border border-line p-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={compareIds.includes(e.id)}
                    onChange={() =>
                      setCompareIds((ids) =>
                        ids.includes(e.id) ? ids.filter((x) => x !== e.id) : [...ids, e.id].slice(-2),
                      )
                    }
                    aria-label={`Select estimate ${e.id} for comparison`}
                  />
                  <span className="font-semibold text-ink">{money(e.grandTotalUsd, e.currency)}</span>
                  <span className="text-muted">
                    total · {money(e.perUnitUsd, e.currency)} / unit · qty {e.quantity}
                  </span>
                </label>
                <span className="ml-auto text-xs text-muted">
                  BOM #{e.bomVersion.bomNumber} · {e.rateCard.name} · {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted md:grid-cols-4">
                <span>BOM total: <strong className="text-ink">{money(e.basis.bomTotalUsd)}</strong></span>
                <span>BOM × qty: <strong className="text-ink">{money(e.basis.bomExtendedUsd)}</strong></span>
                <span>Process: <strong className="text-ink">{money(e.basis.process.totalUsd)}</strong></span>
                <span>
                  Setup: {money(e.basis.process.setupUsd)}
                  {e.basis.process.volumeComponentUsd != null && (
                    <> · volume: {money(e.basis.process.volumeComponentUsd)} ({e.basis.process.volumeCm3} cm³)</>
                  )}
                  {e.basis.process.perUnitComponentUsd != null && (
                    <> · per-unit: {money(e.basis.process.perUnitComponentUsd)}</>
                  )}
                </span>
              </div>
              {e.basis.warnings.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {e.basis.warnings.map((w, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-muted">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button type="button" className={btnGhost} disabled={busy || compareIds.length !== 2} onClick={runCompare}>
              Compare selected ({compareIds.length}/2)
            </button>
            {delta && (
              <div className="text-sm text-ink">
                Δ total <strong>{delta.delta.grandTotalDeltaUsd >= 0 ? "+" : ""}{money(delta.delta.grandTotalDeltaUsd)}</strong>
                {" · "}Δ BOM {delta.delta.bomTotalDeltaUsd >= 0 ? "+" : ""}{money(delta.delta.bomTotalDeltaUsd)}
                {" · "}Δ process {delta.delta.processCostDeltaUsd >= 0 ? "+" : ""}{money(delta.delta.processCostDeltaUsd)}
                {delta.delta.perUnitDeltaUsd != null && (
                  <>{" · "}Δ / unit {delta.delta.perUnitDeltaUsd >= 0 ? "+" : ""}{money(delta.delta.perUnitDeltaUsd)}</>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-ink">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Export / quote requests
// ---------------------------------------------------------------------------

function ExportSection({
  modelId,
  versionId,
  requests,
  onChanged,
}: {
  modelId: string;
  versionId: string;
  requests: ExportRequest[];
  onChanged: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [process, setProcess] = useState<"3d_print" | "pcb" | "cnc">("3d_print");
  const [quantity, setQuantity] = useState("10");
  const [options, setOptions] = useState<Record<string, string>>({});
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [sendFormId, setSendFormId] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [sentViaAccount, setSentViaAccount] = useState("");

  async function createDraft() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/cad/models/${modelId}/versions/${versionId}/export-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          process,
          quantity: Number(quantity),
          processOptions: options,
          contact: {
            name: contactName || undefined,
            email: contactEmail || undefined,
            addressLines: address.split("\n").map((l) => l.trim()).filter(Boolean),
          },
        }),
      });
      setShowForm(false);
      setOptions({});
      setContactName("");
      setContactEmail("");
      setAddress("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create draft.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/cad/export-requests/${id}/confirm`, { method: "POST" });
      setConfirmingId(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to confirm.");
    } finally {
      setBusy(false);
    }
  }

  async function recordSend(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/cad/export-requests/${id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient, sentViaAccount }),
      });
      setSendFormId(null);
      setRecipient("");
      setSentViaAccount("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to record send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Export to vendor" className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Factory className="h-4 w-4" aria-hidden /> Export to prototype vendor
        </h3>
        <button type="button" className={btnGhost} onClick={() => setShowForm((s) => !s)}>
          <Plus className="h-4 w-4" aria-hidden /> New quote request
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        v1 does not connect to vendor APIs and does not place orders. Confirming a request
        writes the vendor-ready export package (model file, version manifest with checksum,
        process parameters, contact/shipping). Recording a send only logs who sent it, when,
        to whom, and via which connected account.
      </p>

      {showForm && (
        <div className="mb-4 space-y-3 rounded-lg border border-line bg-canvas p-3">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PROCESS_LABEL) as ("3d_print" | "pcb" | "cnc")[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProcess(p)}
                className={`flex h-9 items-center rounded-full border px-3 text-sm font-semibold ${
                  process === p ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink"
                }`}
              >
                {PROCESS_LABEL[p]}
              </button>
            ))}
            <input
              className={inputCls + " w-28"}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              inputMode="numeric"
              aria-label="Target quantity"
              placeholder="Qty"
            />
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {PROCESS_OPTIONS[process].map((f) => (
              <input
                key={f.key}
                className={inputCls}
                value={options[f.key] ?? ""}
                onChange={(e) => setOptions((o) => ({ ...o, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                aria-label={f.label}
              />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input className={inputCls} value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Contact name *" aria-label="Contact name" />
            <input className={inputCls} value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Contact email *" inputMode="email" aria-label="Contact email" />
          </div>
          <textarea
            className={inputCls + " min-h-20 w-full py-2"}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={"Shipping address *\nOne line per row"}
            aria-label="Shipping address"
          />
          <button type="button" className={btnPrimary} disabled={busy} onClick={createDraft}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Create draft
          </button>
        </div>
      )}

      <div className="space-y-2">
        {requests.length === 0 && !showForm && (
          <p className="text-sm text-muted">No quote requests for this version yet.</p>
        )}
        {requests.map((r) => (
          <div key={r.id} className="rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Package className="h-4 w-4" aria-hidden />
                {PROCESS_LABEL[r.process]} × {r.quantity} — v{r.modelVersion.versionNumber}
              </span>
              <StatusPill status={r.status} />
              <span className="ml-auto text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            <div className="mt-1 text-xs text-muted">
              {r.contact.name} · {r.contact.email} · {r.contact.addressLines.join(", ")}
              {Object.keys(r.processOptions).length > 0 && (
                <> · {Object.entries(r.processOptions).map(([k, v]) => `${k}: ${v}`).join(", ")}</>
              )}
            </div>

            {r.status === "draft" && confirmingId !== r.id && (
              <div className="mt-2">
                <button type="button" className={btnPrimary} onClick={() => setConfirmingId(r.id)}>
                  Review &amp; confirm
                </button>
              </div>
            )}
            {r.status === "draft" && confirmingId === r.id && (
              <div className="mt-2 rounded-lg border border-line bg-canvas p-3 text-sm">
                <p className="font-semibold text-ink">Confirm this quote request?</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
                  <li>The export package will be written: model file, manifest with the version checksum, process parameters, contact/shipping details.</li>
                  <li>This does not contact any vendor and does not place an order.</li>
                  <li>You will submit the package to your vendor yourself; recording the send afterwards logs the lineage.</li>
                </ul>
                <div className="mt-2 flex gap-2">
                  <button type="button" className={btnPrimary} disabled={busy} onClick={() => confirm(r.id)}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
                    Confirm quote request
                  </button>
                  <button type="button" className={btnGhost} onClick={() => setConfirmingId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {r.status === "confirmed" && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <a
                  className={btnGhost}
                  href={`/api/cad/export-requests/${r.id}/package`}
                  download
                >
                  <Download className="h-4 w-4" aria-hidden /> Manifest
                </a>
                <a
                  className={btnGhost}
                  href={`/api/cad/models/${modelId}/versions/${r.modelVersionId}/file?dl=1`}
                >
                  <Download className="h-4 w-4" aria-hidden /> Model file
                </a>
                {sendFormId !== r.id ? (
                  <button type="button" className={btnPrimary} onClick={() => setSendFormId(r.id)}>
                    <Send className="h-4 w-4" aria-hidden /> Record send
                  </button>
                ) : (
                  <div className="flex w-full flex-wrap items-end gap-2 rounded-lg border border-line bg-canvas p-3">
                    <div className="min-w-48 flex-1">
                      <label className="mb-1 block text-xs font-semibold text-muted">Recipient *</label>
                      <input className={inputCls + " w-full"} value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="e.g. quotes@vendor.example" />
                    </div>
                    <div className="min-w-48 flex-1">
                      <label className="mb-1 block text-xs font-semibold text-muted">Sent via account *</label>
                      <input className={inputCls + " w-full"} value={sentViaAccount} onChange={(e) => setSentViaAccount(e.target.value)} placeholder="Your connected account name" />
                    </div>
                    <p className="w-full text-xs text-muted">
                      This only records that you sent the package yourself through your own
                      account — v1 transmits nothing and places no order.
                    </p>
                    <button type="button" className={btnPrimary} disabled={busy || !recipient.trim() || !sentViaAccount.trim()} onClick={() => recordSend(r.id)}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Record send
                    </button>
                    <button type="button" className={btnGhost} onClick={() => setSendFormId(null)}>
                      Cancel
                    </button>
                  </div>
                )}
                <span className="w-full text-xs text-muted">
                  Confirmed by {r.confirmedBy} · {r.confirmedAt ? new Date(r.confirmedAt).toLocaleString() : ""}
                </span>
              </div>
            )}

            {r.status === "sent" && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                <span>
                  Sent by {r.sentBy} · {r.sentAt ? new Date(r.sentAt).toLocaleString() : ""} · to {r.recipient} · via {r.sentViaAccount}
                </span>
                <a className={btnGhost} href={`/api/cad/export-requests/${r.id}/package`} download>
                  <Download className="h-4 w-4" aria-hidden /> Manifest
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-ink">{error}</p>}
    </section>
  );
}

function StatusPill({ status }: { status: ExportRequest["status"] }) {
  const map = {
    draft: "border-line text-muted",
    confirmed: "border-ink text-ink",
    sent: "border-ink bg-ink text-paper",
  } as const;
  return (
    <span className={`inline-flex h-6 items-center rounded-full border px-2 text-xs font-semibold ${map[status]}`}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Rate cards
// ---------------------------------------------------------------------------

function RateCardSection({ rateCards, onChanged }: { rateCards: RateCard[]; onChanged: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<RateCard | null>(null);
  const [name, setName] = useState("");
  const [process, setProcess] = useState<"3d_print" | "pcb" | "cnc">("3d_print");
  const [setup, setSetup] = useState("");
  const [perUnit, setPerUnit] = useState("");
  const [perCm3, setPerCm3] = useState("");
  const [notes, setNotes] = useState("");
  const [source, setSource] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit(c: RateCard) {
    setEditing(c);
    setName(c.name);
    setProcess(c.process);
    setSetup(c.rates.setupUsd != null ? String(c.rates.setupUsd) : "");
    setPerUnit(c.rates.perUnitUsd != null ? String(c.rates.perUnitUsd) : "");
    setPerCm3(c.rates.perCm3Usd != null ? String(c.rates.perCm3Usd) : "");
    setNotes(c.rates.notes ?? "");
    setSource(c.source ?? "");
    setIsDefault(c.isDefault);
    setShowForm(true);
  }

  function reset() {
    setEditing(null);
    setName("");
    setProcess("3d_print");
    setSetup("");
    setPerUnit("");
    setPerCm3("");
    setNotes("");
    setSource("");
    setIsDefault(false);
    setShowForm(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name,
        process,
        rates: {
          ...(setup !== "" ? { setupUsd: Number(setup) } : {}),
          ...(perUnit !== "" ? { perUnitUsd: Number(perUnit) } : {}),
          ...(perCm3 !== "" ? { perCm3Usd: Number(perCm3) } : {}),
          ...(notes ? { notes } : {}),
        },
        source: source || undefined,
        isDefault,
      };
      if (editing) {
        await api(`/api/cad/rate-cards/${editing.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/cad/rate-cards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      reset();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save rate card.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const ok = await confirmAction({
      title: "Delete this rate card?",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/cad/rate-cards/${id}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete rate card.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Rate cards" className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Factory className="h-4 w-4" aria-hidden /> Rate cards
        </h3>
        <button type="button" className={btnGhost} onClick={() => (showForm ? reset() : setShowForm(true))}>
          {showForm ? <X className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          {showForm ? "Close" : "New rate card"}
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Your process pricing for estimates. Numbers you enter are estimates, not vendor quotes.
        If you copy rates from a vendor page or datasheet, keep the source link — it is stored
        with the card.
      </p>

      {showForm && (
        <div className="mb-3 grid grid-cols-1 gap-2 rounded-lg border border-line bg-canvas p-3 md:grid-cols-3">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Card name *" aria-label="Rate card name" />
          <select className={inputCls} value={process} onChange={(e) => setProcess(e.target.value as typeof process)} aria-label="Process">
            {(Object.keys(PROCESS_LABEL) as ("3d_print" | "pcb" | "cnc")[]).map((p) => (
              <option key={p} value={p}>{PROCESS_LABEL[p]}</option>
            ))}
          </select>
          <input className={inputCls} value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="Setup fee (USD)" inputMode="decimal" aria-label="Setup fee in USD" />
          {process === "3d_print" ? (
            <input className={inputCls} value={perCm3} onChange={(e) => setPerCm3(e.target.value)} placeholder="Per cm³ (USD)" inputMode="decimal" aria-label="Per cubic centimeter rate in USD" />
          ) : (
            <input className={inputCls} value={perUnit} onChange={(e) => setPerUnit(e.target.value)} placeholder="Per unit (USD)" inputMode="decimal" aria-label="Per unit rate in USD" />
          )}
          <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" />
          <input className={inputCls} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source URL + date (if ingested)" aria-label="Source pointer" />
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Default for {PROCESS_LABEL[process]}
          </label>
          <div className="flex gap-2 md:col-span-3">
            <button type="button" className={btnPrimary} disabled={busy || !name.trim()} onClick={save}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {editing ? "Save changes" : "Create rate card"}
            </button>
            <button type="button" className={btnGhost} onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-muted">
              <th className="py-2 pr-3">Name</th>
              <th className="py-2 pr-3">Process</th>
              <th className="py-2 pr-3 text-right">Setup</th>
              <th className="py-2 pr-3 text-right">Per unit</th>
              <th className="py-2 pr-3 text-right">Per cm³</th>
              <th className="py-2 pr-3">Source</th>
              <th className="py-2" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rateCards.map((c) => (
              <tr key={c.id} className="border-b border-line/60 hover:bg-canvas/60">
                <td className="py-2 pr-3 font-medium text-ink">
                  {c.name}
                  {c.isDefault && (
                    <span className="ml-2 inline-flex h-6 items-center rounded-full border border-ink px-2 text-xs font-semibold text-ink">
                      default
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-muted">{PROCESS_LABEL[c.process]}</td>
                <td className="py-2 pr-3 text-right text-muted">{money(c.rates.setupUsd)}</td>
                <td className="py-2 pr-3 text-right text-muted">{money(c.rates.perUnitUsd)}</td>
                <td className="py-2 pr-3 text-right text-muted">{money(c.rates.perCm3Usd)}</td>
                <td className="max-w-48 truncate py-2 pr-3 text-xs text-muted">{c.source ?? "—"}</td>
                <td className="py-2 text-right">
                  <button type="button" aria-label={`Edit ${c.name}`} className="mr-1 rounded-full p-2 text-muted hover:text-ink" onClick={() => startEdit(c)}>
                    <Pencil className="h-4 w-4" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Delete ${c.name}`} className="rounded-full p-2 text-muted hover:text-ink" onClick={() => remove(c.id)}>
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rateCards.length === 0 && <p className="mt-2 text-sm text-muted">No rate cards yet — estimates need one.</p>}
      {error && <p className="mt-2 text-sm text-ink">{error}</p>}
    </section>
  );
}
