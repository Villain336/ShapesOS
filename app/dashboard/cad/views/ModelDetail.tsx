"use client";

// Marketr — CAD + Hardware slice 1: per-model detail — viewer, version
// history, visual diffs, share links.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Loader2,
  Info,
  Download,
  History,
  GitCompareArrows,
  Link2,
  Eye,
  StickyNote,
  Sparkles,
  FlaskConical,
  AlertTriangle,
  Package,
} from "lucide-react";
import { CadViewer } from "./CadViewer";
import { UploadForm } from "./CadApp";
import { CompareTab } from "./CompareTab";
import { ShareLinksTab } from "./ShareLinksTab";
import { AnnotationsTab } from "./AnnotationsTab";
import { ProposalsTab } from "./ProposalsTab";
import { ManufacturingTab } from "./ManufacturingTab";
import { PrototypeTab } from "./PrototypeTab";
import { STEP_PREVIEW_MESSAGE } from "@/lib/cad/types";

interface Version {
  id: string;
  versionNumber: number;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  checksum: string;
  format: "stl" | "obj" | "step";
  triangleCount: number | null;
  bboxMin: [number, number, number] | null;
  bboxMax: [number, number, number] | null;
  volumeEstimate: number | null;
  previewAvailable: boolean;
  notes: string | null;
  uploadedBy: string;
  uploadedAt: string;
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

interface ShareLink {
  id: string;
  label: string | null;
  pinnedVersionId: string | null;
  expiresAt: string;
  revoked: boolean;
  revokedAt: string | null;
  createdAt: string;
}

interface Detail {
  model: {
    id: string;
    name: string;
    description: string | null;
    projectId: string;
    currentVersionId: string | null;
    changeRequested: boolean;
    changeRequestedAt: string | null;
    changeRequestedBy: string | null;
    changeRequestedProposalId: string | null;
  };
  versions: Version[];
  diffs: Diff[];
  shareLinks: ShareLink[];
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const TABS = [
  { key: "viewer", label: "Viewer", icon: Eye },
  { key: "notes", label: "Notes", icon: StickyNote },
  { key: "changes", label: "Changes", icon: Sparkles },
  { key: "manufacturing", label: "Manufacturing", icon: FlaskConical },
  { key: "prototype", label: "Prototype", icon: Package },
  { key: "versions", label: "Versions", icon: History },
  { key: "compare", label: "Compare", icon: GitCompareArrows },
  { key: "links", label: "Share links", icon: Link2 },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

export function isModelTab(v: string | null | undefined): v is TabKey {
  return TABS.some((t) => t.key === v);
}

export function ModelDetail({
  modelId,
  onBack,
  onChanged,
  initialTab,
}: {
  modelId: string;
  onBack: () => void;
  onChanged: () => void;
  /** Deep link (e.g. record search → ?tab=prototype). */
  initialTab?: TabKey;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>(initialTab ?? "viewer");
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api<Detail>(`/api/cad/models/${modelId}`);
      setDetail(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the model.");
    } finally {
      setLoading(false);
    }
  }, [modelId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Loading model…
      </div>
    );
  }
  if (error || !detail) {
    return (
      <div className="p-8">
        <p className="mb-4 text-sm text-failed-text">{error ?? "Model not found."}</p>
        <BackButton onBack={onBack} />
      </div>
    );
  }

  const current = detail.versions.find((v) => v.id === detail.model.currentVersionId) ?? detail.versions[0];

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <BackButton onBack={onBack} />
          <div>
            <h2 className="text-lg font-semibold text-ink" style={{ fontStretch: "115%" }}>
              {detail.model.name}
            </h2>
            {detail.model.description && (
              <p className="mt-0.5 text-sm text-muted">{detail.model.description}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowUpload((s) => !s)}
          className="flex h-10 shrink-0 items-center rounded-full bg-ink px-4 text-sm font-semibold text-paper"
        >
          Publish new version
        </button>
      </div>

      {showUpload && (
        <div className="mb-4">
          <UploadForm
            projectId={detail.model.projectId}
            modelId={modelId}
            onDone={() => {
              setShowUpload(false);
              load();
              onChanged();
            }}
          />
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-line" role="tablist" aria-label="Model sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-semibold transition-colors ${
                active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </div>

      {detail.model.changeRequested && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-line bg-paper p-4 shadow-hairline">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-ink" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-ink">Change requested</p>
            <p className="text-sm text-muted">
              An approved design proposal asks for a change on this model
              {detail.model.changeRequestedBy &&
                ` (approved by ${detail.model.changeRequestedBy}`}
              {detail.model.changeRequestedAt &&
                ` · ${new Date(detail.model.changeRequestedAt).toLocaleString()})`}
              . Make the edit in your CAD tool and publish a new version —
              publishing clears this flag. The geometry has not been touched.
            </p>
          </div>
        </div>
      )}

      {tab === "viewer" && current && (
        <div>
          {current.previewAvailable ? (
            <CadViewer
              fileUrl={`/api/cad/models/${modelId}/versions/${current.id}/file`}
              format={current.format}
              fileName={current.fileName}
            />
          ) : (
            <StepNotice version={current} downloadUrl={`/api/cad/models/${modelId}/versions/${current.id}/file?dl=1`} />
          )}
          <VersionStats version={current} />
        </div>
      )}

      {tab === "notes" && (
        <AnnotationsTab
          modelId={modelId}
          versions={detail.versions}
          currentVersionId={detail.model.currentVersionId}
        />
      )}

      {tab === "changes" && (
        <ProposalsTab
          modelId={modelId}
          versions={detail.versions.map((v) => ({ id: v.id, versionNumber: v.versionNumber, fileName: v.fileName }))}
          currentVersionId={detail.model.currentVersionId}
          onChanged={load}
        />
      )}

      {tab === "manufacturing" && (
        <ManufacturingTab
          modelId={modelId}
          versions={detail.versions}
          currentVersionId={detail.model.currentVersionId}
        />
      )}

      {tab === "prototype" && (
        <PrototypeTab
          modelId={modelId}
          versions={detail.versions}
          currentVersionId={detail.model.currentVersionId}
        />
      )}

      {tab === "versions" && (
        <VersionHistory versions={detail.versions} modelId={modelId} />
      )}

      {tab === "compare" && (
        <CompareTab modelId={modelId} versions={detail.versions} diffs={detail.diffs} onComputed={load} />
      )}

      {tab === "links" && (
        <ShareLinksTab
          modelId={modelId}
          modelName={detail.model.name}
          versions={detail.versions}
          links={detail.shareLinks}
          onChanged={load}
        />
      )}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
      aria-label="Back to models"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** The honest STEP panel: no fake render, conversion is pending. */
function StepNotice({ version, downloadUrl }: { version: Version; downloadUrl: string }) {
  return (
    <div className="rounded-lg border border-line bg-paper p-6 shadow-hairline">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-ink" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-ink">
            {version.fileName} — {version.format.toUpperCase()}
          </h3>
          <p className="mt-1 max-w-xl text-sm text-muted">{STEP_PREVIEW_MESSAGE}</p>
          <p className="mt-2 max-w-xl text-sm text-muted">
            The original file is stored and versioned like any other model —
            only the browser preview is missing. Share it with a collaborator
            or download it for your CAD tool.
          </p>
          <a
            href={downloadUrl}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
          >
            <Download className="h-4 w-4" aria-hidden />
            Download original
          </a>
        </div>
      </div>
    </div>
  );
}

function VersionStats({ version }: { version: Version }) {
  const stats: [string, string][] = [
    ["Version", `v${version.versionNumber}`],
    ["Format", version.format.toUpperCase()],
    ["File", version.fileName],
    ["Size", `${(version.sizeBytes / 1024).toFixed(1)} KB`],
    ["Checksum", `${version.checksum.slice(0, 12)}…`],
    ["Triangles", version.triangleCount === null ? "Not parsed" : version.triangleCount.toLocaleString()],
    [
      "Bounding box",
      version.bboxMin && version.bboxMax
        ? `[${version.bboxMin.map(fmt).join(", ")}] → [${version.bboxMax.map(fmt).join(", ")}]`
        : "Not parsed",
    ],
    [
      "Mesh volume (est.)",
      version.volumeEstimate === null ? "Not parsed" : fmt(version.volumeEstimate),
    ],
    ["Uploaded by", version.uploadedBy],
    ["Uploaded", new Date(version.uploadedAt).toLocaleString()],
  ];
  return (
    <dl className="mt-4 grid gap-x-8 gap-y-2 rounded-lg border border-line bg-canvas p-4 sm:grid-cols-2">
      {stats.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-sm">
          <dt className="w-32 shrink-0 text-muted">{k}</dt>
          <dd className="font-mono text-xs text-ink">{v}</dd>
        </div>
      ))}
      {version.notes && (
        <div className="flex gap-2 text-sm sm:col-span-2">
          <dt className="w-32 shrink-0 text-muted">Notes</dt>
          <dd className="text-ink">{version.notes}</dd>
        </div>
      )}
    </dl>
  );
}

function fmt(n: number): string {
  return Math.abs(n) < 1e-9 ? "0" : n.toFixed(3).replace(/\.?0+$/, "");
}

function VersionHistory({ versions, modelId }: { versions: Version[]; modelId: string }) {
  if (versions.length === 0) {
    return <p className="p-4 text-sm text-muted">No versions yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
            <th className="px-3 py-2.5">Version</th>
            <th className="px-3 py-2.5">File</th>
            <th className="px-3 py-2.5">Format</th>
            <th className="px-3 py-2.5">Triangles</th>
            <th className="px-3 py-2.5">Uploaded</th>
            <th className="px-3 py-2.5">Notes</th>
            <th className="px-3 py-2.5"><span className="sr-only">Download</span></th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v, i) => (
            <tr key={v.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-3 py-2.5">
                <span className="font-mono text-xs font-semibold text-ink">v{v.versionNumber}</span>
                {i === 0 && (
                  <span className="ml-2 rounded-full bg-ink px-2 py-0.5 text-xs font-semibold text-paper">
                    Current
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-ink">{v.fileName}</td>
              <td className="px-3 py-2.5">
                <span className="rounded-full bg-canvas px-2.5 py-1 font-mono text-xs font-semibold text-ink">
                  {v.format.toUpperCase()}
                </span>
              </td>
              <td className="px-3 py-2.5 font-mono text-xs text-muted">
                {v.triangleCount === null ? "—" : v.triangleCount.toLocaleString()}
              </td>
              <td className="px-3 py-2.5 text-xs text-muted">
                {new Date(v.uploadedAt).toLocaleString()}
              </td>
              <td className="px-3 py-2.5 text-xs text-muted">{v.notes ?? "—"}</td>
              <td className="px-3 py-2.5">
                <a
                  href={`/api/cad/models/${modelId}/versions/${v.id}/file?dl=1`}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-ink hover:bg-hover"
                  aria-label={`Download ${v.fileName}`}
                  title="Download original"
                >
                  <Download className="h-4 w-4" aria-hidden />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
