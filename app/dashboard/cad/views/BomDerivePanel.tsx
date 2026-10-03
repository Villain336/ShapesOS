"use client";

// ShapesOS — CAD derived BOM UI (Phase 4b): derive a BOM from the version's
// geometry, show what the derivation measured and assumed, and roll BOMs up
// across revisions. Agentic OS design system: tokens only, pill buttons,
// Lucide icons, sentence case.

import { useCallback, useEffect, useState } from "react";
import { Boxes, GitCompare, Info, Loader2, Wand2, X } from "lucide-react";
import { BOM_MATERIALS } from "@/lib/cad/bom-materials";
import { toast } from "@/lib/ui/feedback";

const inputCls =
  "h-10 rounded-lg border border-line bg-paper px-3 text-sm text-ink placeholder:text-muted/60 focus:outline-none focus:ring-1 focus:ring-ink";
const btnPrimary =
  "flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40";
const btnGhost =
  "flex h-10 items-center gap-2 rounded-full border border-line bg-paper px-4 text-sm font-semibold text-ink hover:bg-canvas disabled:opacity-40";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(body?.error ?? `Request failed (${res.status})`).replace(/^\[[A-Z_]+\]\s*/, ""));
  return body as T;
}

export function fmtMass(g: number | null | undefined): string {
  if (g == null) return "—";
  return g >= 1000 ? `${(g / 1000).toFixed(3)} kg` : `${g.toFixed(2)} g`;
}

export function fmtVolumeCm3(mm3: number | null | undefined): string {
  if (mm3 == null) return "—";
  return `${(mm3 / 1000).toFixed(2)} cm³`;
}

function money(n: number | null | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

function signed(n: number, fmt: (x: number) => string): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${fmt(Math.abs(n))}`;
}

// ---------------------------------------------------------------------------
// Derive form
// ---------------------------------------------------------------------------

export function DeriveBomForm({
  modelId,
  versionId,
  versionNumber,
  format,
  onDerived,
  onClose,
}: {
  modelId: string;
  versionId: string;
  versionNumber: number;
  format: "stl" | "obj" | "step";
  onDerived: (bomId: string) => void;
  onClose: () => void;
}) {
  const [material, setMaterial] = useState("pla");
  const [customLabel, setCustomLabel] = useState("");
  const [customDensity, setCustomDensity] = useState("");
  const [costPerKg, setCostPerKg] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (format === "step") {
    return (
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-line bg-canvas p-3 text-sm text-ink">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>
          STEP files have no mesh geometry we can measure yet, so a BOM can&apos;t be derived from v{versionNumber}.
          Publish an STL or OBJ export of this revision, or add lines by hand.
        </span>
      </div>
    );
  }

  const selected = BOM_MATERIALS.find((m) => m.key === material);

  async function derive() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { modelVersionId: versionId, notes: notes || undefined };
      if (material === "custom") body.customMaterial = { label: customLabel, densityGPerCm3: customDensity };
      else if (material !== "none") body.materialKey = material;
      if (costPerKg.trim() !== "" && material !== "none") body.costPerKgUsd = costPerKg;
      const res = await api<{ bom: { id: string; bomNumber: number }; rollup: { lineCount: number } }>(
        `/api/cad/models/${modelId}/bom/derive`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      toast({ title: `BOM #${res.bom.bomNumber} derived`, description: `${res.rollup.lineCount} part line(s) from v${versionNumber}'s geometry.`, status: "done" });
      onDerived(res.bom.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not derive a BOM.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-line bg-canvas p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Derive a BOM from v{versionNumber}&apos;s geometry</p>
        <button type="button" aria-label="Close" className="rounded-full p-2 text-muted hover:text-ink" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Each body in the mesh becomes a part; identical bodies become one line with a quantity. Volume is measured
        only for closed bodies, and mass needs a material. Mesh units are assumed to be millimetres. Fasteners and
        bought-in parts aren&apos;t in a mesh — add them by hand afterwards.
      </p>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="derive-material">Material</label>
          <select id="derive-material" className={inputCls + " w-full"} value={material} onChange={(e) => setMaterial(e.target.value)}>
            {BOM_MATERIALS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label} ({m.densityGPerCm3} g/cm³)
              </option>
            ))}
            <option value="custom">Custom material…</option>
            <option value="none">No material (volume only)</option>
          </select>
        </div>
        {material === "custom" && (
          <>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="derive-custom-label">Material name</label>
              <input id="derive-custom-label" className={inputCls + " w-full"} value={customLabel} onChange={(e) => setCustomLabel(e.target.value)} placeholder="e.g. Tough resin" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="derive-custom-density">Density (g/cm³)</label>
              <input id="derive-custom-density" className={inputCls + " w-full"} value={customDensity} onChange={(e) => setCustomDensity(e.target.value)} inputMode="decimal" placeholder="from your datasheet" />
            </div>
          </>
        )}
        {material !== "none" && (
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="derive-cost">Material cost (USD/kg, optional)</label>
            <input id="derive-cost" className={inputCls + " w-full"} value={costPerKg} onChange={(e) => setCostPerKg(e.target.value)} inputMode="decimal" placeholder="leave empty if unknown" />
          </div>
        )}
        <div className={material === "custom" ? "md:col-span-4" : "md:col-span-2"}>
          <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="derive-notes">Notes (optional)</label>
          <input id="derive-notes" className={inputCls + " w-full"} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. rev C print run" />
        </div>
      </div>
      {selected && <p className="mt-2 text-xs text-muted">Density source: {selected.source}.</p>}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className={btnPrimary} disabled={busy || (material === "custom" && (!customLabel.trim() || !customDensity.trim()))} onClick={derive}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wand2 className="h-4 w-4" aria-hidden />}
          Derive BOM
        </button>
        {error && <p className="text-sm text-ink">{error}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derivation notes (what was measured, assumed and skipped)
// ---------------------------------------------------------------------------

export interface DerivationView {
  method: string;
  methodVersion: number;
  unitAssumption: string;
  split: string;
  bodyCount: number;
  droppedTriangles: number;
  material: { label: string; densityGPerCm3: number; source: string } | null;
  costPerKgUsd: number | null;
  warnings: string[];
  sourceFileName?: string;
  sourceChecksum?: string;
  sourceVersionNumber?: number;
}

const SPLIT_LABEL: Record<string, string> = {
  named_groups: "named groups in the file",
  connected_components: "separate shells in the mesh",
  single_body: "one body",
};

export function DerivationNotes({ derivation }: { derivation: DerivationView }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas p-3 text-xs text-muted">
      <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Boxes className="h-4 w-4" aria-hidden /> Derived from geometry
      </p>
      <p>
        {derivation.bodyCount} bod{derivation.bodyCount === 1 ? "y" : "ies"} ({SPLIT_LABEL[derivation.split] ?? derivation.split})
        {derivation.sourceVersionNumber != null && <> in v{derivation.sourceVersionNumber}</>}
        {derivation.sourceFileName && <> · <span className="font-mono">{derivation.sourceFileName}</span></>}
        {derivation.sourceChecksum && <> · sha256 <span className="font-mono">{derivation.sourceChecksum.slice(0, 12)}…</span></>}
      </p>
      <p>
        Units: {derivation.unitAssumption}.{" "}
        {derivation.material
          ? <>Material: {derivation.material.label} at {derivation.material.densityGPerCm3} g/cm³ ({derivation.material.source}).</>
          : <>No material — mass not computed.</>}
        {derivation.costPerKgUsd != null && <> Material cost: ${derivation.costPerKgUsd}/kg.</>}
      </p>
      {derivation.warnings.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {derivation.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <p className="mt-1">Method: <span className="font-mono">{derivation.method} v{derivation.methodVersion}</span></p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rollups across revisions
// ---------------------------------------------------------------------------

interface HistoryEntry {
  bomId: string;
  bomNumber: number;
  origin: string;
  versionNumber: number;
  lineCount: number;
  totalUsd: number;
  linesMissingCost: number;
  totalMassG: number | null;
  linesMissingMass: number;
  vsPrevious: {
    totalDeltaUsd: number;
    massDeltaG: number | null;
    added: number;
    removed: number;
    changed: number;
  } | null;
}

interface DiffLine {
  key: string;
  partName: string;
  status: "added" | "removed" | "changed" | "unchanged";
  qtyFrom: number | null;
  qtyTo: number | null;
  massFromG: number | null;
  massToG: number | null;
  lineTotalDeltaUsd: number;
}

export function BomHistoryPanel({ modelId, refreshKey }: { modelId: string; refreshKey: number }) {
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ history: HistoryEntry[] }>(`/api/cad/models/${modelId}/bom/history`);
      setHistory(res.history);
      if (res.history.length >= 2) {
        setFrom((f) => f || res.history[res.history.length - 2]!.bomId);
        setTo((t) => t || res.history[res.history.length - 1]!.bomId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load BOM history.");
    }
  }, [modelId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function compare() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ comparison: { lines: DiffLine[] } }>(
        `/api/cad/bom/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      setDiff(res.comparison.lines.filter((l) => l.status !== "unchanged"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compare failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!history || history.length === 0) return error ? <p className="mt-3 text-sm text-ink">{error}</p> : null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
        <GitCompare className="h-4 w-4" aria-hidden /> Across revisions
      </h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-muted">
              <th className="py-2 pr-3">Model version</th>
              <th className="py-2 pr-3">BOM</th>
              <th className="py-2 pr-3 text-right">Lines</th>
              <th className="py-2 pr-3 text-right">Known cost</th>
              <th className="py-2 pr-3 text-right">Known mass</th>
              <th className="py-2">Change vs previous</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.bomId} className="border-b border-line/60 hover:bg-canvas/60">
                <td className="py-2 pr-3 text-ink">v{h.versionNumber}</td>
                <td className="py-2 pr-3">
                  <span className="text-ink">#{h.bomNumber}</span>{" "}
                  <span className="inline-flex h-6 items-center rounded-full border border-line px-2 text-xs font-semibold text-muted">{h.origin}</span>
                </td>
                <td className="py-2 pr-3 text-right text-muted">{h.lineCount}</td>
                <td className="py-2 pr-3 text-right text-ink">
                  {money(h.totalUsd)}
                  {h.linesMissingCost > 0 && <span className="ml-1 text-xs italic text-muted">≥</span>}
                </td>
                <td className="py-2 pr-3 text-right text-ink">{fmtMass(h.totalMassG)}</td>
                <td className="py-2 text-xs text-muted">
                  {h.vsPrevious
                    ? [
                        h.vsPrevious.added ? `${h.vsPrevious.added} added` : null,
                        h.vsPrevious.removed ? `${h.vsPrevious.removed} removed` : null,
                        h.vsPrevious.changed ? `${h.vsPrevious.changed} changed` : null,
                        `cost ${signed(h.vsPrevious.totalDeltaUsd, (x) => money(x))}`,
                        h.vsPrevious.massDeltaG != null ? `mass ${signed(h.vsPrevious.massDeltaG, (x) => fmtMass(x))}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "first BOM"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {history.length >= 2 && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="bom-cmp-from">From</label>
            <select id="bom-cmp-from" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)}>
              {history.map((h) => (
                <option key={h.bomId} value={h.bomId}>v{h.versionNumber} · BOM #{h.bomNumber}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-muted" htmlFor="bom-cmp-to">To</label>
            <select id="bom-cmp-to" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)}>
              {history.map((h) => (
                <option key={h.bomId} value={h.bomId}>v{h.versionNumber} · BOM #{h.bomNumber}</option>
              ))}
            </select>
          </div>
          <button type="button" className={btnGhost} disabled={busy || !from || !to || from === to} onClick={compare}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <GitCompare className="h-4 w-4" aria-hidden />}
            Compare parts
          </button>
        </div>
      )}

      {diff && (
        diff.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No part changes between these BOMs.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3">Part</th>
                  <th className="py-2 pr-3">Change</th>
                  <th className="py-2 pr-3 text-right">Qty</th>
                  <th className="py-2 pr-3 text-right">Unit mass</th>
                  <th className="py-2 text-right">Cost delta</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((l) => (
                  <tr key={l.key} className="border-b border-line/60">
                    <td className="py-2 pr-3 text-ink">{l.partName}</td>
                    <td className="py-2 pr-3 text-muted">{l.status}</td>
                    <td className="py-2 pr-3 text-right text-muted">{l.qtyFrom ?? "—"} → {l.qtyTo ?? "—"}</td>
                    <td className="py-2 pr-3 text-right text-muted">{fmtMass(l.massFromG)} → {fmtMass(l.massToG)}</td>
                    <td className="py-2 text-right text-ink">{signed(l.lineTotalDeltaUsd, (x) => money(x))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {error && <p className="mt-2 text-sm text-ink">{error}</p>}
    </div>
  );
}
