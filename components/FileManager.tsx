"use client";

// Marketr — file manager (Phase B, W3, track B1).
// Warm Operator styling; no emoji. Browse the four roots, upload, rename,
// move, trash/restore, quota meter, trash bin with 30-day retention notice.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RotateCcw,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  Pencil,
  Trash,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FsFile {
  id: string;
  logicalPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  trashedAt: string | null;
}

interface Listing {
  prefix: string;
  dirs: string[];
  files: FsFile[];
  quota?: { limitBytes: number; usedBytes: number };
}

const ROOTS = [
  { path: "/skills", label: "Skills", hint: "Installed skill packs" },
  { path: "/memory", label: "Memory", hint: "Agent memory" },
  { path: "/artifacts", label: "Artifacts", hint: "Reports, builds, run outputs" },
  { path: "/files", label: "Files", hint: "Uploads and attachments" },
];

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function kindIcon(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime === "application/pdf" || mime.startsWith("text/")) return FileText;
  return FileIcon;
}

export function FileManager({
  workspaceId,
  canEdit,
  canPurge,
}: {
  workspaceId: string;
  canEdit: boolean;
  canPurge: boolean;
}) {
  const [prefix, setPrefix] = useState("/files");
  const [listing, setListing] = useState<Listing | null>(null);
  const [trash, setTrash] = useState<FsFile[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<
    | { type: "rename"; file: FsFile; value: string }
    | { type: "move"; file: FsFile; value: string }
    | null
  >(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(
      `/api/files?workspaceId=${encodeURIComponent(workspaceId)}&prefix=${encodeURIComponent(prefix)}`,
    );
    if (!res.ok) {
      setError("Could not load this folder.");
      return;
    }
    setListing(await res.json());
  }, [workspaceId, prefix]);

  const loadTrash = useCallback(async () => {
    const res = await fetch(
      `/api/files?workspaceId=${encodeURIComponent(workspaceId)}&trashed=1`,
    );
    if (res.ok) setTrash((await res.json()).files ?? []);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (trashOpen) void loadTrash();
  }, [trashOpen, loadTrash]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.append("workspaceId", workspaceId);
        form.append("path", prefix);
        form.append("file", f);
        const res = await fetch("/api/files", { method: "POST", body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Upload failed.");
        }
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function mutate(fileId: string, action: string, extra: Record<string, string> = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/${fileId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, action, ...extra }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Action failed.");
      }
      setDialog(null);
      await load();
      if (trashOpen) await loadTrash();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(fileId: string, purge: boolean) {
    if (purge && !window.confirm("Permanently delete this file? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/files/${fileId}?workspaceId=${encodeURIComponent(workspaceId)}${purge ? "&purge=1" : ""}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Delete failed.");
      }
      await load();
      if (trashOpen) await loadTrash();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  const crumbs = prefix === "/" ? [] : prefix.slice(1).split("/");
  const quota = listing?.quota;
  const quotaPct = quota && quota.limitBytes > 0 ? Math.min(100, (quota.usedBytes / quota.limitBytes) * 100) : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Root tabs */}
      <div className="flex flex-wrap gap-1 border-b border-line">
        {ROOTS.map((r) => (
          <button
            key={r.path}
            type="button"
            onClick={() => {
              setPrefix(r.path);
              setTrashOpen(false);
            }}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors",
              !trashOpen && (prefix === r.path || prefix.startsWith(`${r.path}/`))
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            <Folder size={15} />
            <span>{r.label}</span>
            <span className="hidden text-xs text-subtle sm:inline">{r.hint}</span>
          </button>
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={() => setTrashOpen((v) => !v)}
            className={cn(
              "ml-auto flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors",
              trashOpen
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            <Trash size={15} />
            <span>Trash</span>
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {trashOpen ? (
        <div className="rounded-xl border border-line bg-paper">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-semibold">Trash</h2>
            <p className="text-xs text-muted">Files are kept for 30 days, then permanently deleted.</p>
          </div>
          {trash.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Trash is empty.</p>
          ) : (
            <ul className="divide-y divide-line">
              {trash.map((f) => (
                <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Trash size={16} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.filename}</p>
                    <p className="truncate text-xs text-muted">
                      {f.logicalPath} · {fmtBytes(f.sizeBytes)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void mutate(f.id, "restore")}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover-paper"
                  >
                    <RotateCcw size={14} /> Restore
                  </button>
                  {canPurge && (
                    <button
                      type="button"
                      onClick={() => void remove(f.id, true)}
                      disabled={busy}
                      className="rounded-md px-2 py-1 text-xs text-failed-text shadow-[inset_0_0_0_1px_var(--aos-failed)] hover:bg-failed-tint"
                    >
                      Delete forever
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div
          className={cn(
            "rounded-xl border bg-paper",
            dragOver ? "border-ink" : "border-line",
          )}
          onDragOver={(e) => {
            if (canEdit) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!canEdit) return;
            e.preventDefault();
            setDragOver(false);
            void upload(e.dataTransfer.files);
          }}
        >
          {/* Breadcrumb + upload */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <button
              type="button"
              onClick={() => setPrefix("/files")}
              className="text-sm text-muted hover:text-ink"
            >
              Files
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-2 text-sm">
                <span className="text-muted">/</span>
                {i === crumbs.length - 1 ? (
                  <span className="font-medium text-ink">{c}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setPrefix(`/${crumbs.slice(0, i + 1).join("/")}`)}
                    className="text-muted hover:text-ink"
                  >
                    {c}
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <div className="ml-auto flex items-center gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white aos-press hover:bg-night-hover disabled:opacity-50"
                >
                  <Upload size={16} />
                  {busy ? "Uploading…" : "Upload"}
                </button>
              </div>
            )}
          </div>

          {/* Listing */}
          {!listing ? (
            <p className="px-4 py-8 text-center text-sm text-muted">Loading…</p>
          ) : listing.dirs.length === 0 && listing.files.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">
              {canEdit
                ? "This folder is empty. Drag files here or use Upload."
                : "This folder is empty."}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {listing.dirs.map((d) => (
                <li key={d}>
                  <button
                    type="button"
                    onClick={() => setPrefix(d)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover-paper"
                  >
                    <Folder size={18} className="shrink-0 text-muted" />
                    <span className="text-sm font-medium">{d.split("/").pop()}</span>
                  </button>
                </li>
              ))}
              {listing.files.map((f) => {
                const Icon = kindIcon(f.mimeType);
                return (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Icon size={18} className="shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{f.filename}</p>
                      <p className="truncate text-xs text-muted">
                        {fmtBytes(f.sizeBytes)} · {f.mimeType}
                      </p>
                    </div>
                    <a
                      href={`/api/files/${f.id}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`}
                      className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover-paper"
                    >
                      <Download size={14} /> Download
                    </a>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => setDialog({ type: "rename", file: f, value: f.filename })}
                          className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover-paper"
                        >
                          <Pencil size={14} /> Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => setDialog({ type: "move", file: f, value: f.logicalPath })}
                          className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover-paper"
                        >
                          Move
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(f.id, false)}
                          disabled={busy}
                          className="rounded-md px-2 py-1 text-xs text-failed-text shadow-[inset_0_0_0_1px_var(--aos-failed)] hover:bg-failed-tint"
                        >
                          Trash
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Quota meter */}
      {quota && (
        <div className="rounded-xl border border-line bg-paper px-4 py-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Storage</h2>
            <p className="text-xs text-muted">
              {fmtBytes(quota.usedBytes)} of {fmtBytes(quota.limitBytes)} used
            </p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas">
            <div
              className={cn("h-full rounded-full", quotaPct > 90 ? "bg-failed" : "bg-ink")}
              style={{ width: `${quotaPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Rename / move dialog */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
          <div className="w-full max-w-sm rounded-xl border border-line bg-paper p-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {dialog.type === "rename" ? "Rename file" : "Move file"}
              </h3>
              <button type="button" onClick={() => setDialog(null)} aria-label="Close">
                <X size={16} className="text-muted" />
              </button>
            </div>
            <p className="mt-1 truncate text-xs text-muted">{dialog.file.logicalPath}</p>
            <input
              autoFocus
              value={dialog.value}
              onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
              placeholder={dialog.type === "rename" ? "New filename" : "/files/new-folder/name.ext"}
              className="mt-3 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm"
            />
            {dialog.type === "move" && (
              <p className="mt-1 text-xs text-muted">
                Full path under the same root, e.g. /files/reports/q3.pdf
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:bg-hover-paper"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !dialog.value.trim()}
                onClick={() =>
                  dialog.type === "rename"
                    ? void mutate(dialog.file.id, "rename", { filename: dialog.value.trim() })
                    : void mutate(dialog.file.id, "move", { newPath: dialog.value.trim() })
                }
                className="inline-flex items-center rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-white aos-press hover:bg-night-hover disabled:opacity-50"
              >
                {dialog.type === "rename" ? "Rename" : "Move"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
