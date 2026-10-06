"use client";

// ShapesOS — Phase 18.2 (WS=content): one file — preview, versions, share
// links and who can do what. Opened from the Files list (or ?file=<id> from
// Spotlight and record links). Every action goes through the Files API,
// which checks the workspace role AND the member's role on this file
// (lib/files/acl.ts); the buttons here only mirror that.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Copy, Download, Eye, History, Link2, RotateCcw, Upload, Users, X } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { defaultFileRole, fileCan, type FileRole } from "@/lib/files/acl";
import type { MessageKey } from "@/lib/i18n";
import { FilePreview } from "./FilePreview";
import { fmtBytes } from "./format";

export { fmtBytes };
import type { NewPdfAnnotation, PdfAnnotation } from "./PdfViewer";

interface FileMeta {
  id: string;
  filename: string;
  logicalPath: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
}

interface VersionRow {
  id: string | null;
  version: number;
  current: boolean;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
}

interface ShareRow {
  id: string;
  tokenHint: string;
  access: "view" | "download";
  hasPassword: boolean;
  expiresAt: string | null;
  createdBy: string;
  openCount: number;
  state: "live" | "revoked" | "expired";
}

interface AccessRow {
  userId: string;
  name: string | null;
  email: string | null;
  workspaceRole: "viewer" | "editor" | "admin" | "owner";
  isCreator: boolean;
  override: FileRole | null;
  effective: FileRole;
}

type Tab = "preview" | "versions" | "sharing" | "access";


async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data: body } : { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: "network" };
  }
}

export function FileDetail({ workspaceId, fileId, onClose, onChanged }: { workspaceId: string; fileId: string; onClose: () => void; onChanged: () => void }) {
  const { t, format } = useI18n();
  const ws = encodeURIComponent(workspaceId);
  const base = `/api/files/${encodeURIComponent(fileId)}`;
  const [file, setFile] = useState<FileMeta | null>(null);
  const [role, setRole] = useState<FileRole>("viewer");
  const [tab, setTab] = useState<Tab>("preview");
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [shares, setShares] = useState<{ links: ShareRow[]; canShare: boolean } | null>(null);
  const [access, setAccess] = useState<{ entries: AccessRow[]; canManage: boolean } | null>(null);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [shareForm, setShareForm] = useState<{ access: "view" | "download"; days: number; password: string }>({ access: "view", days: 7, password: "" });
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const loadFile = useCallback(async () => {
    const res = await call<{ file: FileMeta; role: FileRole }>(`${base}?workspaceId=${ws}`);
    if (!res.ok) {
      setMissing(true);
      return;
    }
    setFile(res.data.file);
    setRole(res.data.role);
  }, [base, ws]);

  const loadVersions = useCallback(async () => {
    const res = await call<{ versions: VersionRow[]; retention: number }>(`${base}/versions?workspaceId=${ws}`);
    if (res.ok) {
      setVersions(res.data.versions);
      setRetention(res.data.retention);
    }
  }, [base, ws]);

  const loadAccess = useCallback(async () => {
    const res = await call<{ entries: AccessRow[]; canManage: boolean }>(`${base}/access?workspaceId=${ws}`);
    if (res.ok) setAccess(res.data);
  }, [base, ws]);

  const loadShares = useCallback(async () => {
    const res = await call<{ links: ShareRow[]; canShare: boolean }>(`${base}/shares?workspaceId=${ws}`);
    if (res.ok) setShares(res.data);
  }, [base, ws]);

  useEffect(() => {
    void loadFile();
    void loadVersions();
    void loadAccess();
  }, [loadFile, loadVersions, loadAccess]);

  useEffect(() => {
    if (tab === "sharing") void loadShares();
  }, [tab, loadShares]);

  const shownVersion = previewVersion ?? file?.version ?? 1;
  const loadAnnotations = useCallback(async () => {
    if (!file || file.mimeType !== "application/pdf") return;
    const res = await call<{ annotations: PdfAnnotation[] }>(`${base}/annotations?workspaceId=${ws}&version=${shownVersion}`);
    if (res.ok) setAnnotations(res.data.annotations);
  }, [base, ws, file, shownVersion]);
  useEffect(() => {
    void loadAnnotations();
  }, [loadAnnotations]);

  const nameOf = useMemo(() => {
    const m = new Map((access?.entries ?? []).map((e) => [e.userId, e.name || e.email || t("filesApp.member")]));
    return (id: string) => m.get(id) ?? t("filesApp.member");
  }, [access, t]);

  async function uploadVersion(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    setBusy(true);
    const form = new FormData();
    form.append("workspaceId", workspaceId);
    form.append("file", f);
    const res = await call<{ version: number }>(`${base}/versions`, { method: "POST", body: form });
    setBusy(false);
    if (!res.ok) {
      toastError(t("filesApp.versions.uploadFailed"), res.error);
      return;
    }
    toast({ title: t("filesApp.versions.uploaded", { n: res.data.version }) });
    setPreviewVersion(null);
    await Promise.all([loadFile(), loadVersions()]);
    onChanged();
  }

  async function restore(v: number) {
    const ok = await confirmAction({
      title: t("filesApp.versions.restoreConfirmTitle", { n: v }),
      description: t("filesApp.versions.restoreConfirmBody"),
      confirmLabel: t("filesApp.versions.restore"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setBusy(true);
    const res = await call<{ version: number }>(`${base}/versions/${v}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
    setBusy(false);
    if (!res.ok) {
      toastError(t("filesApp.versions.restoreFailed"), res.error);
      return;
    }
    toast({ title: t("filesApp.versions.restored", { from: v, n: res.data.version }) });
    setPreviewVersion(null);
    await Promise.all([loadFile(), loadVersions()]);
    onChanged();
  }

  async function createShare() {
    setBusy(true);
    const res = await call<{ path: string }>(`${base}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, access: shareForm.access, expiresInDays: shareForm.days, password: shareForm.password || null }),
    });
    setBusy(false);
    if (!res.ok) {
      toastError(t("filesApp.sharing.createFailed"), res.error);
      return;
    }
    setNewLink(`${window.location.origin}${res.data.path}`);
    setShareForm((f) => ({ ...f, password: "" }));
    void loadShares();
  }

  async function revoke(id: string) {
    const ok = await confirmAction({ title: t("filesApp.sharing.revokeConfirm"), confirmLabel: t("filesApp.sharing.revoke"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    const res = await call(`${base}/shares/${encodeURIComponent(id)}?workspaceId=${ws}`, { method: "DELETE" });
    if (!res.ok) toastError(t("filesApp.sharing.revokeFailed"), res.error);
    else toast({ title: t("filesApp.sharing.revoked") });
    void loadShares();
  }

  async function setOverride(userId: string, value: string) {
    const res = await call<{ entries: AccessRow[] }>(`${base}/access`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, userId, role: value === "default" ? null : value }),
    });
    if (!res.ok) toastError(t("filesApp.access.saveFailed"), res.error);
    else setAccess((a) => (a ? { ...a, entries: res.data.entries } : a));
  }

  async function createAnnotation(a: NewPdfAnnotation) {
    const res = await call(`${base}/annotations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, version: shownVersion, ...a }),
    });
    if (!res.ok) toastError(t("filesApp.preview.annotateFailed"), res.error);
    await loadAnnotations();
  }

  async function removeAnnotation(id: string) {
    const res = await call(`${base}/annotations/${encodeURIComponent(id)}?workspaceId=${ws}`, { method: "DELETE" });
    if (!res.ok) toastError(t("filesApp.preview.annotateFailed"), res.error);
    await loadAnnotations();
  }

  const roleLabel = (r: string) => t(`filesApp.roles.${r}` as MessageKey);
  const tabs: Array<{ value: Tab; label: string }> = [
    { value: "preview", label: t("filesApp.tabs.preview") },
    { value: "versions", label: t("filesApp.tabs.versions") },
    { value: "sharing", label: t("filesApp.tabs.sharing") },
    { value: "access", label: t("filesApp.tabs.access") },
  ];
  const bytesUrl = `${base}/versions/${shownVersion}?workspaceId=${ws}`;

  return (
    <Dialog.Root open onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/30" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-full max-w-3xl flex-col overflow-hidden bg-paper shadow-overlay">
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate aos-subheading">{file?.filename ?? (missing ? t("filesApp.notFound") : t("common.loading"))}</Dialog.Title>
              {file ? (
                <Dialog.Description className="truncate font-mono text-xs text-muted">
                  {file.logicalPath} · {fmtBytes(file.sizeBytes)} · {t("filesApp.versions.versionN", { n: file.version })} · {t("filesApp.yourAccess", { role: roleLabel(role) })}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{t("filesApp.detailLabel")}</Dialog.Description>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {file ? (
                <a href={`${base}/versions/${file.version}?workspaceId=${ws}&download=1`} className={aosButton({ variant: "secondary", size: "xs" })}>
                  <Download className="size-3.5" aria-hidden />
                  {t("filesApp.download")}
                </a>
              ) : null}
              <Dialog.Close className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })} aria-label={t("common.close")}>
                <X className="size-4" aria-hidden />
              </Dialog.Close>
            </div>
          </div>
          {file ? (
            <>
              <div className="px-5 pt-3">
                <Segmented label={t("filesApp.tabs.label")} value={tab} onChange={setTab} options={tabs} />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {tab === "preview" ? (
                  <div className="flex flex-col gap-3">
                    {previewVersion && previewVersion !== file.version ? (
                      <p className="flex flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2 text-sm text-muted">
                        {t("filesApp.preview.olderVersion", { n: previewVersion })}
                        <button type="button" onClick={() => setPreviewVersion(null)} className="font-semibold text-ink underline underline-offset-4">
                          {t("filesApp.preview.backToCurrent")}
                        </button>
                      </p>
                    ) : null}
                    <FilePreview
                      key={bytesUrl}
                      src={bytesUrl}
                      mimeType={file.mimeType}
                      filename={file.filename}
                      officeUrl={`${base}/preview?workspaceId=${ws}&version=${shownVersion}`}
                      pdf={{ annotations, canAnnotate: fileCan(role, "annotate"), onCreate: createAnnotation, onRemove: removeAnnotation }}
                    />
                    {file.mimeType === "application/pdf" ? (
                      <a href={`${base}/annotations?workspaceId=${ws}&export=1`} className="self-start text-sm font-semibold text-ink underline underline-offset-4">
                        {t("filesApp.preview.exportAnnotations")}
                      </a>
                    ) : null}
                  </div>
                ) : null}

                {tab === "versions" ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-muted">{retention ? t("filesApp.versions.retention", { n: retention }) : null}</p>
                      {fileCan(role, "version") ? (
                        <label className={aosButton({ size: "xs", className: busy ? "pointer-events-none opacity-60" : "cursor-pointer" })}>
                          <Upload className="size-3.5" aria-hidden />
                          {t("filesApp.versions.uploadNew")}
                          <input type="file" className="sr-only" onChange={(e) => void uploadVersion(e.target.files)} />
                        </label>
                      ) : null}
                    </div>
                    <ul className="flex flex-col rounded-lg border border-line">
                      {(versions ?? []).map((v) => (
                        <li key={v.version} className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-0">
                          <History className="size-4 shrink-0 text-muted" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 text-md font-semibold text-ink">
                              {t("filesApp.versions.versionN", { n: v.version })}
                              {v.current ? <NeutralBadge size="sm" label={t("filesApp.versions.current")} /> : null}
                            </span>
                            <span className="block text-xs text-muted">
                              {format.date(v.createdAt, "dateTime")} · {nameOf(v.createdBy)} · {fmtBytes(v.sizeBytes)}
                            </span>
                          </span>
                          <button type="button" onClick={() => { setPreviewVersion(v.version); setTab("preview"); }} className={aosButton({ variant: "quiet", size: "xs" })}>
                            <Eye className="size-3.5" aria-hidden />
                            {t("filesApp.versions.preview")}
                          </button>
                          <a href={`${base}/versions/${v.version}?workspaceId=${ws}&download=1`} className={aosButton({ variant: "quiet", size: "xs" })}>
                            <Download className="size-3.5" aria-hidden />
                            {t("filesApp.download")}
                          </a>
                          {!v.current && fileCan(role, "version") ? (
                            <button type="button" disabled={busy} onClick={() => void restore(v.version)} className={aosButton({ variant: "secondary", size: "xs" })}>
                              <RotateCcw className="size-3.5" aria-hidden />
                              {t("filesApp.versions.restore")}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {tab === "sharing" ? (
                  <div className="flex flex-col gap-4">
                    {shares && !shares.canShare ? <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">{t("filesApp.sharing.cantShare")}</p> : null}
                    {shares?.canShare ? (
                      <form
                        className="flex flex-col gap-3 rounded-lg border border-line p-4"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void createShare();
                        }}
                      >
                        <h3 className="text-md font-semibold text-ink">{t("filesApp.sharing.newLink")}</h3>
                        <div className="flex flex-wrap items-center gap-3">
                          <Segmented
                            label={t("filesApp.sharing.accessLabel")}
                            value={shareForm.access}
                            onChange={(v) => setShareForm((f) => ({ ...f, access: v }))}
                            options={[
                              { value: "view", label: t("filesApp.sharing.viewOnly") },
                              { value: "download", label: t("filesApp.sharing.viewAndDownload") },
                            ]}
                          />
                          <label className="flex items-center gap-2 text-sm text-muted">
                            {t("filesApp.sharing.expires")}
                            <select
                              value={shareForm.days}
                              onChange={(e) => setShareForm((f) => ({ ...f, days: Number(e.target.value) }))}
                              className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink"
                            >
                              {[1, 7, 30, 90].map((d) => (
                                <option key={d} value={d}>
                                  {t("filesApp.sharing.days", { count: d })}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <label className="flex flex-col gap-1.5 text-sm text-muted">
                          {t("filesApp.sharing.passwordLabel")}
                          <input
                            type="password"
                            autoComplete="new-password"
                            value={shareForm.password}
                            minLength={6}
                            maxLength={128}
                            onChange={(e) => setShareForm((f) => ({ ...f, password: e.target.value }))}
                            placeholder={t("filesApp.sharing.passwordPlaceholder")}
                            className="h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink outline-none focus:border-focus"
                          />
                        </label>
                        <button type="submit" disabled={busy} className={aosButton({ size: "sm", className: "self-start" })}>
                          <Link2 className="size-4" aria-hidden />
                          {t("filesApp.sharing.create")}
                        </button>
                        {newLink ? (
                          <div className="flex flex-col gap-1.5 rounded-md bg-canvas p-3" role="status">
                            <p className="text-sm font-semibold text-ink">{t("filesApp.sharing.createdOnce")}</p>
                            <div className="flex items-center gap-2">
                              <input readOnly value={newLink} aria-label={t("filesApp.sharing.linkLabel")} className="h-control-sm min-w-0 flex-1 rounded-md border border-line bg-paper px-2 font-mono text-xs text-ink" onFocus={(e) => e.target.select()} />
                              <button
                                type="button"
                                onClick={() => void navigator.clipboard?.writeText(newLink).then(() => toast({ title: t("filesApp.sharing.copied") }))}
                                className={aosButton({ variant: "secondary", size: "xs" })}
                              >
                                <Copy className="size-3.5" aria-hidden />
                                {t("filesApp.sharing.copy")}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </form>
                    ) : null}
                    {shares?.links.length ? (
                      <ul className="flex flex-col rounded-lg border border-line" aria-label={t("filesApp.sharing.listLabel")}>
                        {shares.links.map((l) => (
                          <li key={l.id} className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-0">
                            <Link2 className="size-4 shrink-0 text-muted" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block font-mono text-sm text-ink">…{l.tokenHint}</span>
                              <span className="block text-xs text-muted">
                                {l.access === "download" ? t("filesApp.sharing.viewAndDownload") : t("filesApp.sharing.viewOnly")}
                                {l.hasPassword ? ` · ${t("filesApp.sharing.withPassword")}` : ""}
                                {l.expiresAt ? ` · ${t("filesApp.sharing.until", { date: format.date(l.expiresAt, "date") })}` : ""}
                                {` · ${t("filesApp.sharing.opens", { count: l.openCount })}`}
                                {` · ${nameOf(l.createdBy)}`}
                              </span>
                            </span>
                            {l.state === "live" ? (
                              <button type="button" onClick={() => void revoke(l.id)} className={aosButton({ variant: "deny", size: "xs" })}>
                                {t("filesApp.sharing.revoke")}
                              </button>
                            ) : (
                              <NeutralBadge size="sm" label={l.state === "revoked" ? t("filesApp.sharing.stateRevoked") : t("filesApp.sharing.stateExpired")} />
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : shares?.canShare ? (
                      <p className="text-sm text-muted">{t("filesApp.sharing.none")}</p>
                    ) : null}
                  </div>
                ) : null}

                {tab === "access" ? (
                  <div className="flex flex-col gap-3">
                    <p className="text-sm text-muted">{t("filesApp.access.intro")}</p>
                    <ul className="flex flex-col rounded-lg border border-line" aria-label={t("filesApp.access.listLabel")}>
                      {(access?.entries ?? []).map((e) => {
                        const isAdmin = e.workspaceRole === "admin" || e.workspaceRole === "owner";
                        const options = e.workspaceRole === "viewer" ? ["viewer"] : ["viewer", "editor", "owner"];
                        return (
                          <li key={e.userId} className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2.5 last:border-0">
                            <Users className="size-4 shrink-0 text-muted" aria-hidden />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-md font-semibold text-ink">{e.name || e.email || t("filesApp.member")}</span>
                              <span className="block text-xs text-muted">
                                {t("filesApp.access.workspaceRole", { role: t(`filesApp.workspaceRoles.${e.workspaceRole}` as MessageKey) })}
                                {e.isCreator ? ` · ${t("filesApp.access.madeIt")}` : ""}
                              </span>
                            </span>
                            {access?.canManage && !isAdmin ? (
                              <label className="flex items-center gap-2 text-sm text-muted">
                                <span className="sr-only">{t("filesApp.access.selectLabel", { name: e.name || e.email || t("filesApp.member") })}</span>
                                <select
                                  value={e.override ?? "default"}
                                  onChange={(ev) => void setOverride(e.userId, ev.target.value)}
                                  className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink"
                                >
                                  <option value="default">{t("filesApp.access.default", { role: roleLabel(defaultFileRole(e.workspaceRole, e.isCreator)) })}</option>
                                  {options.map((o) => (
                                    <option key={o} value={o}>
                                      {roleLabel(o)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            ) : (
                              <NeutralBadge size="sm" label={roleLabel(e.effective)} />
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </div>
            </>
          ) : missing ? (
            <p className="px-5 py-10 text-md text-muted">{t("filesApp.notFoundBody")}</p>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default FileDetail;
