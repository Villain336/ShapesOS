"use client";

// Marketr — CAD + Hardware slice 1: visual diff between two revisions.
// Side-by-side three.js viewers + a metadata table computed from the REAL
// geometry of both versions. When a side cannot be parsed (STEP), the diff
// row says "unavailable" — numbers are never invented.

import { useState } from "react";
import { Loader2, GitCompareArrows } from "lucide-react";
import { CadViewer } from "./CadViewer";

interface Version {
  id: string;
  versionNumber: number;
  fileName: string;
  format: "stl" | "obj" | "step";
  triangleCount: number | null;
  previewAvailable: boolean;
}

interface Diff {
  id: string;
  fromVersionId: string;
  toVersionId: string;
  availability: "computed" | "unavailable";
  triangleDelta: number | null;
  sizeDelta: [number, number, number] | null;
  centerDelta: number | null;
  volumeFrom: number | null;
  volumeTo: number | null;
  volumeDelta: number | null;
  computedAt: string;
}

function fmt(n: number): string {
  return Math.abs(n) < 1e-9 ? "0" : n.toFixed(3).replace(/\.?0+$/, "");
}

function signed(n: number): string {
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

export function CompareTab({
  modelId,
  versions,
  diffs,
  onComputed,
}: {
  modelId: string;
  versions: Version[];
  diffs: Diff[];
  onComputed: () => void;
}) {
  const [fromId, setFromId] = useState(versions[1]?.id ?? versions[0]?.id ?? "");
  const [toId, setToId] = useState(versions[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = versions.find((v) => v.id === fromId) ?? null;
  const to = versions.find((v) => v.id === toId) ?? null;
  const recorded = diffs.find(
    (d) => d.fromVersionId === fromId && d.toVersionId === toId,
  ) ?? null;

  const compare = async () => {
    if (!fromId || !toId || fromId === toId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/models/${modelId}/diffs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromVersionId: fromId, toVersionId: toId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not compute the diff.");
      onComputed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not compute the diff.");
    } finally {
      setBusy(false);
    }
  };

  if (versions.length < 2) {
    return (
      <p className="rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
        Publish a second version to compare revisions.
      </p>
    );
  }

  const bothPreviewable = from?.previewAvailable && to?.previewAvailable;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-canvas p-4">
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-diff-from">
            From
          </label>
          <select
            id="cad-diff-from"
            value={fromId}
            onChange={(e) => setFromId(e.target.value)}
            className="h-10 rounded-md border border-control bg-paper px-3 text-sm text-ink"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.fileName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-diff-to">
            To
          </label>
          <select
            id="cad-diff-to"
            value={toId}
            onChange={(e) => setToId(e.target.value)}
            className="h-10 rounded-md border border-control bg-paper px-3 text-sm text-ink"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.fileName}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={compare}
          disabled={busy || !fromId || !toId || fromId === toId}
          className="flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <GitCompareArrows className="h-4 w-4" aria-hidden />}
          Compare
        </button>
        {error && <p className="w-full text-sm text-failed-text">{error}</p>}
      </div>

      {recorded && (
        <div className="mb-4 rounded-lg border border-line bg-paper p-4 shadow-hairline">
          <h3 className="mb-2 text-sm font-semibold text-ink">
            v{from?.versionNumber} → v{to?.versionNumber}
            <span className="ml-2 rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-muted">
              {recorded.availability === "computed" ? "Computed from geometry" : "Not computable"}
            </span>
          </h3>
          {recorded.availability === "computed" ? (
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="w-40 shrink-0 text-muted">Triangle delta</dt>
                <dd className="font-mono text-xs text-ink">
                  {recorded.triangleDelta === null ? "—" : signed(recorded.triangleDelta)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-40 shrink-0 text-muted">Size delta (x, y, z)</dt>
                <dd className="font-mono text-xs text-ink">
                  {recorded.sizeDelta ? `[${recorded.sizeDelta.map(signed).join(", ")}]` : "—"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-40 shrink-0 text-muted">Center shift</dt>
                <dd className="font-mono text-xs text-ink">
                  {recorded.centerDelta === null ? "—" : fmt(recorded.centerDelta)}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-40 shrink-0 text-muted">Mesh volume (est.)</dt>
                <dd className="font-mono text-xs text-ink">
                  {recorded.volumeFrom === null || recorded.volumeTo === null
                    ? "—"
                    : `${fmt(recorded.volumeFrom)} → ${fmt(recorded.volumeTo)} (${signed(recorded.volumeDelta ?? 0)})`}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted">
              One of these versions has no parsed geometry (for example a STEP
              file) — there is nothing honest to compare. The side-by-side
              viewers below still work for the renderable side.
            </p>
          )}
        </div>
      )}

      {bothPreviewable && from && to ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 font-mono text-xs font-semibold text-muted">
              v{from.versionNumber} — {from.fileName}
            </p>
            <CadViewer
              fileUrl={`/api/cad/models/${modelId}/versions/${from.id}/file`}
              format={from.format}
              fileName={from.fileName}
              compact
            />
          </div>
          <div>
            <p className="mb-1 font-mono text-xs font-semibold text-muted">
              v{to.versionNumber} — {to.fileName}
            </p>
            <CadViewer
              fileUrl={`/api/cad/models/${modelId}/versions/${to.id}/file`}
              format={to.format}
              fileName={to.fileName}
              compact
            />
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
          Side-by-side rendering needs both versions to be STL or OBJ. STEP
          versions show their honest preview-unavailable panel in the Viewer tab.
        </p>
      )}

      {diffs.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-semibold text-ink">Recorded diffs</h3>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
                  <th className="px-3 py-2.5">Pair</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Triangle Δ</th>
                  <th className="px-3 py-2.5">Computed</th>
                </tr>
              </thead>
              <tbody>
                {diffs.map((d) => {
                  const fv = versions.find((v) => v.id === d.fromVersionId);
                  const tv = versions.find((v) => v.id === d.toVersionId);
                  return (
                    <tr key={d.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2.5 font-mono text-xs text-ink">
                        v{fv?.versionNumber ?? "?"} → v{tv?.versionNumber ?? "?"}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="rounded-full bg-canvas px-2.5 py-1 text-xs font-semibold text-muted">
                          {d.availability === "computed" ? "Computed" : "Not computable"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-ink">
                        {d.triangleDelta === null ? "—" : signed(d.triangleDelta)}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted">
                        {new Date(d.computedAt).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
