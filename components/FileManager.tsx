"use client";

// Marketr — file manager (Phase B, W3, track B1).
// Browse the four roots, upload, rename, move, trash/restore, quota meter,
// trash bin with 30-day retention notice.
// Phase 18.2 (WS=content): Agentic OS + en/es; a file opens its detail
// (preview, versions, share links, access — components/files/FileDetail.tsx,
// also from ?file=<id>); uploading over an existing file offers "Replace"
// (a new version — the old bytes are kept) instead of failing; admins set how
// many versions each file keeps.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RotateCcw,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  History,
  Image as ImageIcon,
  Pencil,
  Trash,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { FileDetail, fmtBytes } from "@/components/files/FileDetail";
import type { MessageKey } from "@/lib/i18n";

interface FsFile {
  id: string;
  logicalPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  trashedAt: string | null;
  version?: number;
}

interface Listing {
  prefix: string;
  dirs: string[];
  files: FsFile[];
  quota?: { limitBytes: number; usedBytes: number };
}

const ROOTS = [
  { path: "/skills", key: "skills" },
  { path: "/memory", key: "memory" },
  { path: "/artifacts", key: "artifacts" },
  { path: "/files", key: "files" },
] as const;

function kindIcon(mime: string) {
  if (mime.startsWith("image/")) return ImageIcon;
  if (mime === "application/pdf" || mime.startsWith("text/")) return FileText;
  return FileIcon;
}

export function FileManager({
  workspaceId,
  canEdit,
  canPurge,
  canAdmin = false,
  initialFileId = null,
}: {
  workspaceId: string;
  canEdit: boolean;
  canPurge: boolean;
  canAdmin?: boolean;
  initialFileId?: string | null;
}) {
  const { t } = useI18n();
  const [prefix, setPrefix] = useState("/files");
  const [listing, setListing] = useState<Listing | null>(null);
  const [trash, setTrash] = useState<FsFile[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(initialFileId);
  const [dialog, setDialog] = useState<
    | { type: "rename"; file: FsFile; value: string }
    | { type: "move"; file: FsFile; value: string }
    | null
  >(null);
  const [dragOver, setDragOver] = useState(false);
  const [retention, setRetention] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/files?workspaceId=${encodeURIComponent(workspaceId)}&prefix=${encodeURIComponent(prefix)}`).catch(() => null);
    if (!res?.ok) {
      setError(t("filesApp.loadFailed"));
      return;
    }
    setListing(await res.json());
  }, [workspaceId, prefix, t]);

  const loadTrash = useCallback(async () => {
    const res = await fetch(`/api/files?workspaceId=${encodeURIComponent(workspaceId)}&trashed=1`).catch(() => null);
    if (res?.ok) setTrash((await res.json()).files ?? []);
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (trashOpen) void loadTrash();
  }, [trashOpen, loadTrash]);
  useEffect(() => {
    if (!canAdmin) return;
    void fetch(`/api/files/settings?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { versionRetention?: number } | null) => b?.versionRetention && setRetention(b.versionRetention))
      .catch(() => undefined);
  }, [canAdmin, workspaceId]);

  const setFileParam = useCallback((id: string | null) => {
    setOpenFile(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("file", id);
    else url.searchParams.delete("file");
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  async function postUpload(f: File, replace: boolean): Promise<Response | null> {
    const form = new FormData();
    form.append("workspaceId", workspaceId);
    form.append("path", prefix);
    form.append("file", f);
    if (replace) form.append("replace", "1");
    return fetch("/api/files", { method: "POST", body: form }).catch(() => null);
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0 || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) {
        let res = await postUpload(f, false);
        if (res?.status === 409) {
          const body = (await res.json().catch(() => null)) as { canReplace?: boolean } | null;
          if (body?.canReplace) {
            const ok = await confirmAction({
              title: t("filesApp.replace.title", { name: f.name }),
              description: t("filesApp.replace.body"),
              confirmLabel: t("filesApp.replace.confirm"),
              cancelLabel: t("filesApp.replace.keep"),
            });
            if (!ok) continue;
            res = await postUpload(f, true);
            if (res?.ok) {
              const b = (await res.json().catch(() => null)) as { version?: number } | null;
              toast({ title: t("filesApp.replace.done", { name: f.name, n: b?.version ?? 0 }) });
              continue;
            }
          }
        }
        if (!res?.ok) {
          const body = (await res?.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? t("filesApp.uploadFailed"));
        }
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("filesApp.uploadFailed"));
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
        throw new Error(body?.error ?? t("filesApp.actionFailed"));
      }
      setDialog(null);
      await load();
      if (trashOpen) await loadTrash();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("filesApp.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(fileId: string, purge: boolean) {
    if (purge && !(await confirmAction({ title: t("filesApp.purgeConfirm"), confirmLabel: t("filesApp.deleteForever"), cancelLabel: t("common.cancel"), destructive: true }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/files/${fileId}?workspaceId=${encodeURIComponent(workspaceId)}${purge ? "&purge=1" : ""}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? t("filesApp.deleteFailed"));
      }
      await load();
      if (trashOpen) await loadTrash();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("filesApp.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveRetention(n: number) {
    const res = await fetch("/api/files/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, versionRetention: n }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { versionRetention?: number; purged?: number; error?: string } | null;
    if (!res?.ok || !body?.versionRetention) {
      toastError(t("filesApp.retention.failed"), body?.error);
      return;
    }
    setRetention(body.versionRetention);
    toast({ title: t("filesApp.retention.saved", { n: body.versionRetention }), ...(body.purged ? { description: t("filesApp.retention.purged", { count: body.purged }) } : {}) });
    void load();
  }

  const crumbs = prefix === "/" ? [] : prefix.slice(1).split("/");
  const quota = listing?.quota;
  const quotaPct = quota && quota.limitBytes > 0 ? Math.min(100, (quota.usedBytes / quota.limitBytes) * 100) : 0;
  const tabCls = (on: boolean) =>
    cn("flex min-h-11 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold transition-colors", on ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label={t("filesApp.rootsLabel")}>
        {ROOTS.map((r) => {
          const on = !trashOpen && (prefix === r.path || prefix.startsWith(`${r.path}/`));
          return (
            <button
              key={r.path}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => {
                setPrefix(r.path);
                setTrashOpen(false);
              }}
              className={tabCls(on)}
            >
              <Folder className="size-4" aria-hidden />
              <span>{t(`filesApp.roots.${r.key}` as MessageKey)}</span>
              <span className="hidden text-xs font-normal text-muted sm:inline">{t(`filesApp.rootHints.${r.key}` as MessageKey)}</span>
            </button>
          );
        })}
        {canEdit && (
          <button type="button" role="tab" aria-selected={trashOpen} onClick={() => setTrashOpen((v) => !v)} className={cn(tabCls(trashOpen), "ml-auto")}>
            <Trash className="size-4" aria-hidden />
            <span>{t("filesApp.trash")}</span>
          </button>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-failed-tint px-3 py-2 text-sm font-semibold text-failed-text">
          <span className="mt-1 size-2 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {trashOpen ? (
        <section className="rounded-lg bg-paper shadow-hairline" aria-labelledby="files-trash-title">
          <div className="border-b border-line px-4 py-3">
            <h2 id="files-trash-title" className="text-md font-semibold text-ink">{t("filesApp.trash")}</h2>
            <p className="text-sm text-muted">{t("filesApp.trashHint")}</p>
          </div>
          {trash.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">{t("filesApp.trashEmpty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {trash.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                  <Trash className="size-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-md font-semibold text-ink">{f.filename}</p>
                    <p className="truncate font-mono text-xs text-muted">
                      {f.logicalPath} · {fmtBytes(f.sizeBytes)}
                    </p>
                  </div>
                  <button type="button" onClick={() => void mutate(f.id, "restore")} disabled={busy} className={aosButton({ variant: "secondary", size: "xs" })}>
                    <RotateCcw className="size-3.5" aria-hidden /> {t("filesApp.restore")}
                  </button>
                  {canPurge && (
                    <button type="button" onClick={() => void remove(f.id, true)} disabled={busy} className={aosButton({ variant: "deny", size: "xs" })}>
                      {t("filesApp.deleteForever")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section
          aria-label={t("filesApp.folderLabel")}
          className={cn("rounded-lg bg-paper", dragOver ? "shadow-outline" : "shadow-hairline")}
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
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <nav aria-label={t("filesApp.breadcrumbs")} className="flex flex-wrap items-center gap-2 text-sm">
              <button type="button" onClick={() => setPrefix("/files")} className="text-muted hover:text-ink">
                {t("filesApp.roots.files")}
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-2">
                  <span className="text-subtle" aria-hidden>
                    /
                  </span>
                  {i === crumbs.length - 1 ? (
                    <span className="font-semibold text-ink" aria-current="location">
                      {c}
                    </span>
                  ) : (
                    <button type="button" onClick={() => setPrefix(`/${crumbs.slice(0, i + 1).join("/")}`)} className="text-muted hover:text-ink">
                      {c}
                    </button>
                  )}
                </span>
              ))}
            </nav>
            {canEdit && (
              <div className="ml-auto flex items-center gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(e) => {
                    void upload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={aosButton({ size: "sm" })}>
                  <Upload className="size-4" aria-hidden />
                  {busy ? t("filesApp.uploading") : t("filesApp.upload")}
                </button>
              </div>
            )}
          </div>

          {!listing ? (
            <p className="px-4 py-8 text-center text-sm text-muted">{t("common.loading")}</p>
          ) : listing.dirs.length === 0 && listing.files.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">{canEdit ? t("filesApp.emptyEditable") : t("filesApp.empty")}</p>
          ) : (
            <ul className="divide-y divide-line">
              {listing.dirs.map((d) => (
                <li key={d}>
                  <button type="button" onClick={() => setPrefix(d)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-hover-paper">
                    <Folder className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="text-md font-semibold text-ink">{d.split("/").pop()}</span>
                  </button>
                </li>
              ))}
              {listing.files.map((f) => {
                const Icon = kindIcon(f.mimeType);
                return (
                  <li key={f.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-hover-paper">
                    <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                    <button type="button" onClick={() => setFileParam(f.id)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-md font-semibold text-ink hover:underline">{f.filename}</span>
                      <span className="block truncate text-xs text-muted">
                        {fmtBytes(f.sizeBytes)} · {f.mimeType}
                        {f.version && f.version > 1 ? ` · ${t("filesApp.versions.versionN", { n: f.version })}` : ""}
                      </span>
                    </button>
                    <button type="button" onClick={() => setFileParam(f.id)} className={aosButton({ variant: "quiet", size: "xs" })}>
                      <History className="size-3.5" aria-hidden /> {t("filesApp.open")}
                    </button>
                    <a href={`/api/files/${f.id}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`} className={aosButton({ variant: "quiet", size: "xs" })}>
                      <Download className="size-3.5" aria-hidden /> {t("filesApp.download")}
                    </a>
                    {canEdit && (
                      <>
                        <button type="button" onClick={() => setDialog({ type: "rename", file: f, value: f.filename })} className={aosButton({ variant: "quiet", size: "xs" })}>
                          <Pencil className="size-3.5" aria-hidden /> {t("filesApp.rename")}
                        </button>
                        <button type="button" onClick={() => setDialog({ type: "move", file: f, value: f.logicalPath })} className={aosButton({ variant: "quiet", size: "xs" })}>
                          {t("filesApp.move")}
                        </button>
                        <button type="button" onClick={() => void remove(f.id, false)} disabled={busy} className={aosButton({ variant: "deny", size: "xs" })}>
                          {t("filesApp.trashAction")}
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {quota && (
        <section className="rounded-lg bg-paper px-4 py-3 shadow-hairline" aria-labelledby="files-storage-title">
          <div className="flex items-baseline justify-between">
            <h2 id="files-storage-title" className="text-md font-semibold text-ink">{t("filesApp.storage")}</h2>
            <p className="text-sm text-muted">{t("filesApp.storageUsed", { used: fmtBytes(quota.usedBytes), limit: fmtBytes(quota.limitBytes) })}</p>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(quotaPct)} aria-label={t("filesApp.storage")}>
            <div className="h-full rounded-full bg-ink" style={{ width: `${quotaPct}%` }} />
          </div>
          {canAdmin && retention ? (
            <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
              {t("filesApp.retention.label")}
              <select value={retention} onChange={(e) => void saveRetention(Number(e.target.value))} className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink">
                {[...new Set([1, 5, 10, 20, 50, 100, 200, retention])].sort((a, b) => a - b).map((n) => (
                  <option key={n} value={n}>
                    {t("filesApp.retention.option", { n })}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </section>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="files-dialog-title" className="w-full max-w-sm rounded-lg bg-paper p-4 shadow-overlay">
            <div className="flex items-center justify-between">
              <h3 id="files-dialog-title" className="text-md font-semibold text-ink">{dialog.type === "rename" ? t("filesApp.renameTitle") : t("filesApp.moveTitle")}</h3>
              <button type="button" onClick={() => setDialog(null)} aria-label={t("common.close")} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })}>
                <X className="size-4" aria-hidden />
              </button>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted">{dialog.file.logicalPath}</p>
            <label className="mt-3 block">
              <span className="sr-only">{dialog.type === "rename" ? t("filesApp.newName") : t("filesApp.newPath")}</span>
              <input
                autoFocus
                value={dialog.value}
                onChange={(e) => setDialog({ ...dialog, value: e.target.value })}
                placeholder={dialog.type === "rename" ? t("filesApp.newName") : "/files/new-folder/name.ext"}
                className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink outline-none focus:border-focus"
              />
            </label>
            {dialog.type === "move" && <p className="mt-1 text-sm text-muted">{t("filesApp.moveHint")}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setDialog(null)} className={aosButton({ variant: "quiet", size: "sm" })}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={busy || !dialog.value.trim()}
                onClick={() => (dialog.type === "rename" ? void mutate(dialog.file.id, "rename", { filename: dialog.value.trim() }) : void mutate(dialog.file.id, "move", { newPath: dialog.value.trim() }))}
                className={aosButton({ size: "sm" })}
              >
                {dialog.type === "rename" ? t("filesApp.rename") : t("filesApp.move")}
              </button>
            </div>
          </div>
        </div>
      )}

      {openFile ? <FileDetail workspaceId={workspaceId} fileId={openFile} onClose={() => setFileParam(null)} onChanged={() => void load()} /> : null}
    </div>
  );
}
