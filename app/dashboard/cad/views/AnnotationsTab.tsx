"use client";

// Marketr — CAD + Hardware slice 2: natural-language annotations on a model
// version. Click-to-place in the three.js viewer (or a whole-model note),
// stored tenant-scoped with author + timestamp.

import { useCallback, useEffect, useState } from "react";
import { Loader2, MapPin, StickyNote, Trash2, X } from "lucide-react";
import { CadViewer } from "./CadViewer";

interface VersionLite {
  id: string;
  versionNumber: number;
  fileName: string;
  format: "stl" | "obj" | "step";
  previewAvailable: boolean;
}

interface Annotation {
  id: string;
  author: string;
  body: string;
  point: [number, number, number] | null;
  region: { min: [number, number, number]; max: [number, number, number] } | null;
  versionId: string;
  createdAt: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export function AnnotationsTab({
  modelId,
  versions,
  currentVersionId,
}: {
  modelId: string;
  versions: VersionLite[];
  currentVersionId: string | null;
}) {
  const [versionId, setVersionId] = useState<string>(
    currentVersionId ?? versions[0]?.id ?? "",
  );
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [point, setPoint] = useState<[number, number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const version = versions.find((v) => v.id === versionId) ?? versions[0];

  const load = useCallback(async () => {
    if (!versionId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ annotations: Annotation[] }>(
        `/api/cad/models/${modelId}/annotations?versionId=${versionId}`,
      );
      setAnnotations(res.annotations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load annotations.");
    } finally {
      setLoading(false);
    }
  }, [modelId, versionId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!body.trim() || !versionId) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/cad/models/${modelId}/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          versionId,
          body: body.trim(),
          anchor: point ? "point" : "whole",
          point,
        }),
      });
      setBody("");
      setPoint(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the annotation.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this annotation?")) return;
    try {
      await api(`/api/cad/annotations/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the annotation.");
    }
  }

  const markers = annotations
    .filter((a) => a.point)
    .map((a) => ({ id: a.id, point: a.point as [number, number, number] }));

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div>
        <div className="mb-3 flex items-center gap-2">
          <label htmlFor="note-version" className="text-sm font-semibold text-ink">
            Version
          </label>
          <select
            id="note-version"
            value={versionId}
            onChange={(e) => {
              setVersionId(e.target.value);
              setPoint(null);
            }}
            className="h-10 rounded-full border border-line bg-paper px-3 text-sm text-ink"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.fileName}
              </option>
            ))}
          </select>
        </div>
        {version && version.previewAvailable ? (
          <CadViewer
            fileUrl={`/api/cad/models/${modelId}/versions/${version.id}/file`}
            format={version.format}
            fileName={version.fileName}
            onPointPicked={(p) => setPoint(p)}
            markers={markers}
          />
        ) : (
          <div className="rounded-lg border border-line bg-paper p-6 text-sm text-muted shadow-hairline">
            Annotations are stored against this version, but it has no browser
            preview (STEP). Attach a whole-model note instead.
          </div>
        )}
        <div className="mt-3 rounded-lg border border-line bg-paper p-4 shadow-hairline">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <StickyNote className="h-4 w-4" aria-hidden />
            New note
          </h3>
          {point ? (
            <div className="mt-2 flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4 shrink-0 text-ink" aria-hidden />
              <span className="font-mono text-xs text-muted">
                [{point[0]}, {point[1]}, {point[2]}]
              </span>
              <button
                type="button"
                onClick={() => setPoint(null)}
                className="flex h-7 items-center gap-1 rounded-full bg-paper px-2 text-xs font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
              >
                <X className="h-3 w-3" aria-hidden />
                Whole model instead
              </button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Whole-model note — or press “Place note” on the viewer and click a
              point on the part to anchor it.
            </p>
          )}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="e.g. This rib cracked in the drop test — thicken before the next print."
            className="mt-2 w-full rounded-lg border border-line bg-canvas p-3 text-sm text-ink"
          />
          {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
          <button
            type="button"
            onClick={save}
            disabled={saving || !body.trim()}
            className="mt-2 flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Save note
          </button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-ink">
          Notes on this version ({annotations.length})
        </h3>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading…
          </div>
        ) : annotations.length === 0 ? (
          <p className="rounded-lg border border-line bg-paper p-4 text-sm text-muted shadow-hairline">
            No notes yet. Click “Place note” on the viewer and click the part,
            or write a whole-model note.
          </p>
        ) : (
          <ul className="space-y-2">
            {annotations.map((a) => (
              <li
                key={a.id}
                className="rounded-lg border border-line bg-paper p-3 shadow-hairline"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{a.body}</p>
                    <p className="mt-1 text-xs text-muted">
                      {a.author} · {new Date(a.createdAt).toLocaleString()}
                    </p>
                    {a.point && (
                      <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-muted">
                        <MapPin className="h-3 w-3" aria-hidden />
                        [{a.point[0]}, {a.point[1]}, {a.point[2]}]
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    title="Delete note"
                    aria-label="Delete note"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper text-muted shadow-[inset_0_0_0_1.5px_var(--aos-ink)] hover:text-ink"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
