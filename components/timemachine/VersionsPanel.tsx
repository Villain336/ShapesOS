"use client";

// ShapesOS — Phase 18.3 (WS=flow): the one "Versions" panel for notes, Office
// docs and files. Notes and docs open 18.2's VersionHistory (UniverDocVersion:
// list, preview, name, restore via /api/notes|office/docs/[id]/versions);
// files list WorkspaceFileVersion and restore through /api/files/[id]/versions/[n]
// (restoreFileVersion — the current bytes become a version first). No new
// version tables; each app's own route checks who may restore.

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download, History, RotateCcw, X } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { VersionHistory } from "@/components/notes/VersionHistory";

export interface VersionsTarget {
  kind: "note" | "doc" | "file";
  id: string;
  title: string;
  apiBase: string;
}

export function VersionsPanel({ target, workspaceId, canEdit, open, onOpenChange }: { target: VersionsTarget; workspaceId: string; canEdit: boolean; open: boolean; onOpenChange: (o: boolean) => void }) {
  if (target.kind !== "file") {
    return <VersionHistory apiBase={target.apiBase} canEdit={canEdit} open={open} onOpenChange={onOpenChange} onRestored={() => toast({ title: target.title, status: "done" })} />;
  }
  return <FileVersions target={target} workspaceId={workspaceId} open={open} onOpenChange={onOpenChange} />;
}

interface FileVersionRow {
  version: number;
  current: boolean;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
}

function FileVersions({ target, workspaceId, open, onOpenChange }: { target: VersionsTarget; workspaceId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t, format } = useI18n();
  const [rows, setRows] = useState<FileVersionRow[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const ws = encodeURIComponent(workspaceId);

  const load = useCallback(async () => {
    const res = await fetch(`${target.apiBase}/versions?workspaceId=${ws}`, { cache: "no-store" }).catch(() => null);
    const j = (await res?.json().catch(() => null)) as { versions?: FileVersionRow[]; error?: string } | null;
    if (!res?.ok || !j?.versions) {
      toastError(t("flow.versions.loadFailed"), j?.error);
      setRows([]);
      return;
    }
    setRows(j.versions);
  }, [target.apiBase, ws, t]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function restore(v: number) {
    const ok = await confirmAction({ title: t("flow.versions.restoreTitle", { n: v }), description: t("flow.versions.restoreBody"), confirmLabel: t("flow.versions.restore"), cancelLabel: t("common.cancel") });
    if (!ok) return;
    setBusy(v);
    const res = await fetch(`${target.apiBase}/versions/${v}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }).catch(() => null);
    setBusy(null);
    const j = (await res?.json().catch(() => null)) as { version?: number; error?: string } | null;
    if (!res?.ok) {
      toastError(t("flow.versions.restoreFailed"), j?.error);
      return;
    }
    toast({ title: t("flow.versions.restored", { from: v, n: j?.version ?? v }), status: "done" });
    await load();
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/30" />
        <Dialog.Popup className="fixed top-[10%] left-1/2 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-y-auto rounded-lg bg-paper p-5 shadow-overlay">
          <div className="flex items-start gap-2">
            <History className="mt-1 size-5 shrink-0" aria-hidden />
            <Dialog.Title className="min-w-0 flex-1 break-words aos-subheading">{t("flow.versions.fileTitle", { title: target.title })}</Dialog.Title>
            <Dialog.Close className={aosButton({ variant: "quiet", size: "xs" })} aria-label={t("common.close")}>
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          {rows === null ? <p className="mt-4 text-sm text-muted">{t("common.loading")}</p> : null}
          {rows?.length === 0 ? <p className="mt-4 text-sm text-muted">{t("flow.versions.none")}</p> : null}
          <ul className="mt-3 flex flex-col divide-y divide-line">
            {rows?.map((r) => (
              <li key={r.version} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <span className="font-semibold text-ink">{t("flow.versions.versionN", { n: r.version })}</span>
                {r.current ? <NeutralBadge size="sm" label={t("flow.versions.current")} /> : null}
                <span suppressHydrationWarning className="min-w-0 flex-1 text-xs text-muted">
                  {format.date(r.createdAt, "dateTime")}
                </span>
                <a href={`${target.apiBase}/versions/${r.version}?workspaceId=${ws}&download=1`} className={aosButton({ variant: "quiet", size: "xs" })} aria-label={t("flow.versions.downloadN", { n: r.version })}>
                  <Download className="size-3.5" aria-hidden />
                </a>
                {!r.current ? (
                  <button type="button" disabled={busy !== null} onClick={() => void restore(r.version)} className={aosButton({ variant: "secondary", size: "xs" })}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    {t("flow.versions.restore")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default VersionsPanel;
