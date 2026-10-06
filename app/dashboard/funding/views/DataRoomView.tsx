// Marketr — Funding/VC slice 3: data room view (client).
// Versioned pitch deck / financials / metrics: upload, immutable version
// history, shareable expiring links (per-doc or whole-room), and per-viewer
// analytics ("who opened what, when"). Agentic OS design system: tokens
// only, black primary actions, Lucide icons only, sentence case.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Copy,
  FileText,
  History,
  Link2,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";
import { activateOnKey } from "@/lib/ui/keyboard";

const KIND_LABELS: Record<string, string> = {
  pitch_deck: "Pitch deck",
  financials: "Financials",
  metrics: "Metrics",
  other: "Other",
};

const KIND_OPTIONS = ["pitch_deck", "financials", "metrics", "other"];

interface DocVersion {
  id: string;
  versionNumber: number;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
  isCurrent: boolean;
  supersedesVersionId: string | null;
  viewCount: number;
}

interface ShareLink {
  id: string;
  docId: string | null;
  docTitle: string | null;
  docVersionId: string | null;
  pinnedVersionNumber: number | null;
  urlPath: string;
  expiresAt: string | null;
  expired: boolean;
  viewerEmails: string[];
  revoked: boolean;
  viewCount: number;
  createdAt: string;
}

interface DocViewRow {
  id: string;
  linkId: string;
  docId: string | null;
  docTitle: string | null;
  docVersionNumber: number | null;
  viewerIdentity: string;
  userAgent: string | null;
  durationMs: number | null;
  openedAt: string;
}

interface DataRoomDoc {
  id: string;
  title: string;
  kind: string;
  notes: string | null;
  currentVersion: DocVersion | null;
  versionCount: number;
  shareLinkCount: number;
  viewCount: number;
  createdAt: string;
}

interface DocDetail extends DataRoomDoc {
  versions: DocVersion[];
  shareLinks: ShareLink[];
  views: DocViewRow[];
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function defaultExpiryLocal(): string {
  const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error ?? "Something went wrong. Try again.");
  }
  return json;
}

function ErrorNote({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-paper p-3 text-[0.8125rem] text-ink shadow-hairline">
      <ShieldAlert size={15} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="aos-press text-muted">
        <X size={14} />
      </button>
    </div>
  );
}

export function DataRoomView() {
  const [docs, setDocs] = useState<DataRoomDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ title: "", kind: "pitch_deck", notes: "" });
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(async () => {
    const json = await api("/api/funding/data-room");
    setDocs(json.documents ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch((e: Error) => {
      setError(e.message);
      setLoading(false);
    });
  }, [refresh]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const json = await api(`/api/funding/data-room/${id}`);
      setDetail(json.document);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the document.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const uploadDoc = async () => {
    if (!uploadFile || !uploadForm.title.trim()) {
      setError("Give the document a title and attach a file.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append("title", uploadForm.title.trim());
      form.append("kind", uploadForm.kind);
      if (uploadForm.notes.trim()) form.append("notes", uploadForm.notes.trim());
      form.append("file", uploadFile);
      await fetch("/api/funding/data-room", { method: "POST", body: form }).then(
        async (res) => {
          if (!res.ok) {
            const json = await res.json().catch(() => null);
            throw new Error(json?.error ?? "Upload failed. Try again.");
          }
        },
      );
      setUploadForm({ title: "", kind: "pitch_deck", notes: "" });
      setUploadFile(null);
      setShowUpload(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const deleteDoc = async (id: string) => {
    if (!await confirmAction("Delete this document and its version history?")) return;
    try {
      await api(`/api/funding/data-room/${id}`, { method: "DELETE" });
      setSelectedId(null);
      setDetail(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the document.");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading your data room
      </div>
    );
  }

  if (selectedId) {
    return (
      <DocDetailPanel
        docId={selectedId}
        detail={detail}
        loading={detailLoading}
        error={error}
        onError={setError}
        onBack={() => {
          setSelectedId(null);
          setDetail(null);
          void refresh();
        }}
        onChanged={async () => {
          await openDetail(selectedId);
          await refresh();
        }}
        onDelete={() => void deleteDoc(selectedId)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote message={error} onDismiss={() => setError(null)} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText size={15} className="text-ink" />
          <h2 className="text-[1.125rem] font-bold text-ink" style={{ fontStretch: "115%" }}>
            Data room
          </h2>
          <span className="rounded-full bg-paper px-2.5 py-1 text-[0.75rem] font-semibold text-muted shadow-control">
            {docs.length} document{docs.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowUpload((v) => !v)}
          className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white"
        >
          <Plus size={15} />
          Upload document
        </button>
      </div>

      {showUpload && (
        <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-[0.8125rem] font-semibold text-ink">
              Title
              <input
                value={uploadForm.title}
                onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
                placeholder="Series A pitch deck"
                className="h-10 rounded-lg border border-line bg-canvas px-3 text-[0.875rem] font-normal text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-[0.8125rem] font-semibold text-ink">
              Document type
              <select
                value={uploadForm.kind}
                onChange={(e) => setUploadForm({ ...uploadForm, kind: e.target.value })}
                className="h-10 rounded-lg border border-line bg-canvas px-3 text-[0.875rem] font-normal text-ink"
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[0.8125rem] font-semibold text-ink">
            Notes (optional)
            <input
              value={uploadForm.notes}
              onChange={(e) => setUploadForm({ ...uploadForm, notes: e.target.value })}
              placeholder="What changed in this version"
              className="h-10 rounded-lg border border-line bg-canvas px-3 text-[0.875rem] font-normal text-ink"
            />
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-line bg-canvas p-4 text-[0.875rem] text-muted">
            <Upload size={16} />
            {uploadFile ? uploadFile.name : "Choose a file (PDF, deck, spreadsheet…)"}
            <input
              type="file"
              className="hidden"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void uploadDoc()}
              disabled={uploading}
              className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white disabled:opacity-50"
            >
              {uploading && <Loader2 size={14} className="animate-spin" />}
              Upload
            </button>
            <button
              type="button"
              onClick={() => setShowUpload(false)}
              className="aos-press h-10 rounded-full bg-paper px-4 text-[0.875rem] font-semibold text-ink shadow-hairline"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {docs.length === 0 ? (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <FileText size={20} className="mx-auto text-muted" />
          <p className="mt-2 text-[0.875rem] font-semibold text-ink">No documents yet</p>
          <p className="mt-1 text-[0.8125rem] text-muted">
            Upload your pitch deck, financials, or metrics. Every upload becomes a new
            immutable version, and you can share expiring links with investors.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-left text-[0.8125rem]">
            <thead>
              <tr className="border-b border-line text-[0.75rem] uppercase tracking-wide text-muted">
                <th className="px-4 py-3 font-semibold">Document</th>
                <th className="px-4 py-3 font-semibold">Type</th>
                <th className="px-4 py-3 font-semibold">Current version</th>
                <th className="px-4 py-3 font-semibold">Versions</th>
                <th className="px-4 py-3 font-semibold">Links</th>
                <th className="px-4 py-3 font-semibold">Views</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr
                  key={d.id}
                  onClick={() => void openDetail(d.id)}
                  tabIndex={0}
                  onKeyDown={activateOnKey(() => void openDetail(d.id))}
                  className="cursor-pointer border-b border-line last:border-0 hover:bg-canvas"
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-ink">{d.title}</div>
                    {d.notes && (
                      <div className="mt-0.5 max-w-[280px] truncate text-[0.75rem] text-muted">
                        {d.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-muted">
                      {KIND_LABELS[d.kind] ?? d.kind}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {d.currentVersion ? (
                      <>
                        <span className="font-semibold text-ink">
                          v{d.currentVersion.versionNumber}
                        </span>{" "}
                        · {d.currentVersion.fileName} · {formatSize(d.currentVersion.sizeBytes)}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">{d.versionCount}</td>
                  <td className="px-4 py-3 text-muted">{d.shareLinkCount}</td>
                  <td className="px-4 py-3 text-muted">{d.viewCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DocDetailPanel(props: {
  docId: string;
  detail: DocDetail | null;
  loading: boolean;
  error: string | null;
  onError: (msg: string | null) => void;
  onBack: () => void;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const { docId, detail, loading, error, onError, onBack, onChanged, onDelete } = props;
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [addingVersion, setAddingVersion] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkForm, setLinkForm] = useState({
    scope: "doc" as "doc" | "room",
    pinVersion: false,
    expiresAt: defaultExpiryLocal(),
    noExpiry: false,
    viewerEmails: "",
  });
  const [creatingLink, setCreatingLink] = useState(false);
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const addVersion = async () => {
    if (!versionFile) {
      onError("Choose a file to upload as the new version.");
      return;
    }
    onError(null);
    setAddingVersion(true);
    try {
      const form = new FormData();
      form.append("documentId", docId);
      form.append("file", versionFile);
      const res = await fetch("/api/funding/data-room", { method: "POST", body: form });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? "Upload failed. Try again.");
      }
      setVersionFile(null);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Upload failed. Try again.");
    } finally {
      setAddingVersion(false);
    }
  };

  const createLink = async () => {
    onError(null);
    setCreatingLink(true);
    try {
      const emails = linkForm.viewerEmails
        .split(/[,;\n]/)
        .map((e) => e.trim())
        .filter(Boolean);
      const json = await api("/api/funding/data-room/share-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          docId: linkForm.scope === "room" ? null : docId,
          docVersionId:
            linkForm.scope === "doc" && linkForm.pinVersion && detail?.currentVersion
              ? detail.currentVersion.id
              : null,
          expiresAt: linkForm.noExpiry
            ? null
            : new Date(linkForm.expiresAt).toISOString(),
          viewerEmails: emails,
        }),
      });
      const origin = window.location.origin;
      setNewLinkUrl(`${origin}${json.link.urlPath}`);
      setShowLinkForm(false);
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not create the link.");
    } finally {
      setCreatingLink(false);
    }
  };

  const revokeLink = async (linkId: string) => {
    try {
      await api(`/api/funding/data-room/share-links/${linkId}/revoke`, {
        method: "POST",
      });
      await onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not revoke the link.");
    }
  };

  const copyLink = async () => {
    if (!newLinkUrl) return;
    try {
      await navigator.clipboard.writeText(newLinkUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onError("Copy failed — select the link text manually.");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote message={error} onDismiss={() => onError(null)} />}
      <button
        type="button"
        onClick={onBack}
        className="aos-press self-start rounded-full bg-paper px-4 py-2 text-[0.8125rem] font-semibold text-ink shadow-hairline"
      >
        ← All documents
      </button>

      {loading || !detail ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Loading document
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[1.25rem] font-bold text-ink" style={{ fontStretch: "115%" }}>
                  {detail.title}
                </h2>
                <span className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-muted">
                  {KIND_LABELS[detail.kind] ?? detail.kind}
                </span>
              </div>
              {detail.notes && (
                <p className="mt-1 max-w-[520px] text-[0.8125rem] text-muted">{detail.notes}</p>
              )}
              <p className="mt-1 text-[0.75rem] text-muted">
                {detail.versionCount} version{detail.versionCount === 1 ? "" : "s"} ·{" "}
                {detail.viewCount} view{detail.viewCount === 1 ? "" : "s"} ·{" "}
                {detail.shareLinkCount} share link{detail.shareLinkCount === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              onClick={onDelete}
              className="aos-press flex h-9 items-center gap-2 rounded-full bg-paper px-4 text-[0.8125rem] font-semibold text-ink shadow-hairline"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>

          {newLinkUrl && (
            <div className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
              <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-ink">
                <Link2 size={14} />
                Share link created — copy it now (the token is shown only here)
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-canvas px-3 py-2 font-mono text-[0.75rem] text-ink">
                  {newLinkUrl}
                </code>
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className="aos-press flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-black px-4 text-[0.8125rem] font-semibold text-white"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {/* Versions */}
          <section className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
            <div className="flex items-center gap-2">
              <History size={15} className="text-ink" />
              <h3 className="text-[0.9375rem] font-bold text-ink">Version history</h3>
              <span className="text-[0.75rem] text-muted">
                Versions are never edited — a new upload supersedes the previous one.
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {detail.versions.map((v) => (
                <div
                  key={v.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-ink">
                      v{v.versionNumber}
                      {v.isCurrent && (
                        <span className="rounded-full bg-black px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-white">
                          Current
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[0.75rem] text-muted">
                      {v.fileName} · {formatSize(v.sizeBytes)} · uploaded by {v.uploadedBy} ·{" "}
                      {formatDate(v.uploadedAt)} · {v.viewCount} view{v.viewCount === 1 ? "" : "s"}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-full bg-canvas px-4 py-2 text-[0.8125rem] font-semibold text-ink">
                <Upload size={14} />
                {versionFile ? versionFile.name : "Choose file for new version"}
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <button
                type="button"
                onClick={() => void addVersion()}
                disabled={addingVersion || !versionFile}
                className="aos-press flex h-9 items-center gap-2 rounded-full bg-black px-4 text-[0.8125rem] font-semibold text-white disabled:opacity-50"
              >
                {addingVersion && <Loader2 size={13} className="animate-spin" />}
                Upload v{detail.versionCount + 1}
              </button>
            </div>
          </section>

          {/* Share links */}
          <section className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Link2 size={15} className="text-ink" />
                <h3 className="text-[0.9375rem] font-bold text-ink">Share links</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowLinkForm((v) => !v)}
                className="aos-press flex h-9 items-center gap-2 rounded-full bg-black px-4 text-[0.8125rem] font-semibold text-white"
              >
                <Plus size={14} />
                New link
              </button>
            </div>

            {showLinkForm && (
              <div className="flex flex-col gap-3 rounded-lg bg-canvas p-4">
                <div className="flex gap-2" role="radiogroup" aria-label="Link scope">
                  {(["doc", "room"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={linkForm.scope === s}
                      onClick={() => setLinkForm({ ...linkForm, scope: s })}
                      className={`aos-press rounded-full px-4 py-2 text-[0.8125rem] font-semibold ${
                        linkForm.scope === s
                          ? "bg-black text-white"
                          : "bg-paper text-muted shadow-hairline"
                      }`}
                    >
                      {s === "doc" ? "This document" : "Whole room"}
                    </button>
                  ))}
                </div>
                {linkForm.scope === "doc" && (
                  <label className="flex items-center gap-2 text-[0.8125rem] text-ink">
                    <input
                      type="checkbox"
                      checked={linkForm.pinVersion}
                      onChange={(e) => setLinkForm({ ...linkForm, pinVersion: e.target.checked })}
                    />
                    Pin to current version (v{detail.currentVersion?.versionNumber ?? "—"}).
                    Unpinned links always serve the newest version.
                  </label>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex flex-col gap-1 text-[0.8125rem] font-semibold text-ink">
                    Expires
                    <input
                      type="datetime-local"
                      value={linkForm.expiresAt}
                      disabled={linkForm.noExpiry}
                      onChange={(e) => setLinkForm({ ...linkForm, expiresAt: e.target.value })}
                      className="h-10 rounded-lg border border-line bg-paper px-3 text-[0.875rem] font-normal text-ink disabled:opacity-50"
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-2.5 text-[0.8125rem] text-ink">
                    <input
                      type="checkbox"
                      checked={linkForm.noExpiry}
                      onChange={(e) => setLinkForm({ ...linkForm, noExpiry: e.target.checked })}
                    />
                    No expiry
                  </label>
                </div>
                <label className="flex flex-col gap-1 text-[0.8125rem] font-semibold text-ink">
                  Viewer emails (optional allowlist — one per line or comma-separated)
                  <textarea
                    value={linkForm.viewerEmails}
                    onChange={(e) => setLinkForm({ ...linkForm, viewerEmails: e.target.value })}
                    rows={2}
                    placeholder="partner@firm.com"
                    className="rounded-lg border border-line bg-paper px-3 py-2 text-[0.875rem] font-normal text-ink"
                  />
                </label>
                <div className="text-[0.75rem] text-muted">
                  Allowlisted links ask the viewer for their email and only open for a match.
                  Open links fingerprint the viewer instead. Every open is logged.
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => void createLink()}
                    disabled={creatingLink}
                    className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white disabled:opacity-50"
                  >
                    {creatingLink && <Loader2 size={14} className="animate-spin" />}
                    Create link
                  </button>
                </div>
              </div>
            )}

            {detail.shareLinks.length === 0 ? (
              <p className="text-[0.8125rem] text-muted">
                No links yet. Create one to share with investors — expiry is enforced when
                the link is opened, and revoked links stop working immediately.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {detail.shareLinks.map((l) => (
                  <div
                    key={l.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-canvas px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[0.8125rem] font-semibold text-ink">
                        {l.revoked ? (
                          <span className="rounded-full bg-paper px-2 py-0.5 text-[0.6875rem] font-semibold text-muted shadow-hairline">
                            Revoked
                          </span>
                        ) : l.expired ? (
                          <span className="rounded-full bg-paper px-2 py-0.5 text-[0.6875rem] font-semibold text-muted shadow-hairline">
                            Expired
                          </span>
                        ) : (
                          <span className="rounded-full bg-black px-2 py-0.5 text-[0.6875rem] font-semibold text-white">
                            Active
                          </span>
                        )}
                        <span className="truncate">
                          {l.docId ? (l.pinnedVersionNumber ? `Pinned to v${l.pinnedVersionNumber}` : "Latest version") : "Whole room"}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[0.75rem] text-muted">
                        {l.expiresAt ? `Expires ${formatDate(l.expiresAt)}` : "No expiry"} ·{" "}
                        {l.viewerEmails.length > 0
                          ? `${l.viewerEmails.length} allowlisted`
                          : "Open link"}{" "}
                        · {l.viewCount} view{l.viewCount === 1 ? "" : "s"} · created{" "}
                        {formatDate(l.createdAt)}
                      </div>
                    </div>
                    {!l.revoked && (
                      <button
                        type="button"
                        onClick={() => void revokeLink(l.id)}
                        className="aos-press rounded-full bg-paper px-3 py-1.5 text-[0.75rem] font-semibold text-ink shadow-hairline"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Analytics */}
          <section className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
            <h3 className="text-[0.9375rem] font-bold text-ink">Who opened what, when</h3>
            {detail.views.length === 0 ? (
              <p className="text-[0.8125rem] text-muted">
                No views yet. Every open of a share link is logged here with the viewer,
                the version they saw, and when.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[0.8125rem]">
                  <thead>
                    <tr className="border-b border-line text-[0.75rem] uppercase tracking-wide text-muted">
                      <th className="px-3 py-2 font-semibold">Viewer</th>
                      <th className="px-3 py-2 font-semibold">Version</th>
                      <th className="px-3 py-2 font-semibold">Opened</th>
                      <th className="px-3 py-2 font-semibold">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.views.map((v) => (
                      <tr key={v.id} className="border-b border-line last:border-0">
                        <td className="px-3 py-2 font-medium text-ink">{v.viewerIdentity}</td>
                        <td className="px-3 py-2 text-muted">
                          {v.docVersionNumber ? `v${v.docVersionNumber}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-muted">{formatDate(v.openedAt)}</td>
                        <td className="px-3 py-2 text-muted">{formatDuration(v.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
