"use client";

// ShapesOS — Phase 18.2 (WS=content): version history for a note or an
// Office doc (lib/univer/versions.ts). Lists the snapshots (automatic on idle,
// named, "before restore"), previews one as text, saves a named version and
// restores one (the current state is kept first, so a restore can itself be
// undone from this list).

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { History, RotateCcw, X } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { Field } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";

interface VersionMeta {
  id: string;
  docVersion: number;
  kind: "auto" | "named" | "restore";
  name: string | null;
  title: string;
  createdAt: string;
}

export function VersionHistory({
  apiBase,
  canEdit,
  open,
  onOpenChange,
  onRestored,
}: {
  /** "/api/notes/<id>" or "/api/office/docs/<id>". */
  apiBase: string;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: (newVersion: number) => void;
}) {
  const { t, format } = useI18n();
  const [versions, setVersions] = useState<VersionMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`${apiBase}/versions`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setError(t("notes.versions.loadFailed"));
      setVersions([]);
      return;
    }
    const body = (await res.json()) as { versions: VersionMeta[] };
    setVersions(body.versions);
  }, [apiBase, t]);

  useEffect(() => {
    if (open) {
      setSelected(null);
      setPreview(null);
      void load();
    }
  }, [open, load]);

  async function pick(id: string) {
    setSelected(id);
    setPreview(null);
    const res = await fetch(`${apiBase}/versions/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setPreview(t("notes.versions.previewFailed"));
      return;
    }
    const body = (await res.json()) as { text: string };
    setPreview(body.text || t("notes.versions.emptyVersion"));
  }

  async function saveNamed() {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    const res = await fetch(`${apiBase}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: clean }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      toastError(t("notes.versions.saveFailed"));
      return;
    }
    setName("");
    toast({ title: t("notes.versions.saved", { name: clean }) });
    void load();
  }

  async function restore(v: VersionMeta) {
    const ok = await confirmAction({
      title: t("notes.versions.restoreConfirmTitle"),
      description: t("notes.versions.restoreConfirmBody", { when: format.date(v.createdAt, "dateTime") }),
      confirmLabel: t("notes.versions.restore"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`${apiBase}/versions/${encodeURIComponent(v.id)}`, { method: "POST" }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      toastError(t("notes.versions.restoreFailed"));
      return;
    }
    const body = (await res.json()) as { version: number };
    toast({ title: t("notes.versions.restored") });
    onRestored(body.version);
    onOpenChange(false);
  }

  const kindLabel = (k: VersionMeta["kind"]) =>
    k === "named" ? t("notes.versions.kindNamed") : k === "restore" ? t("notes.versions.kindRestore") : t("notes.versions.kindAuto");
  const current = versions?.find((v) => v.id === selected) ?? null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/30" />
        <Dialog.Popup className="fixed top-[8%] left-1/2 z-50 flex max-h-[84vh] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 flex-col overflow-hidden rounded-lg bg-paper shadow-overlay">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 aos-subheading">
              <History className="size-5" aria-hidden />
              {t("notes.versions.title")}
            </Dialog.Title>
            <Dialog.Close className={aosButton({ variant: "quiet", size: "sm", className: "w-9 px-0" })} aria-label={t("common.close")}>
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="px-5 pt-3 text-sm text-muted">{t("notes.versions.intro")}</Dialog.Description>
          {canEdit ? (
            <form
              className="flex flex-wrap items-end gap-2 px-5 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void saveNamed();
              }}
            >
              <Field
                label={t("notes.versions.nameLabel")}
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("notes.versions.namePlaceholder")}
                className="min-w-[14rem] flex-1"
              />
              <button type="submit" disabled={busy || !name.trim()} className={aosButton({ variant: "secondary", size: "md" })}>
                {t("notes.versions.saveVersion")}
              </button>
            </form>
          ) : null}
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-hidden pt-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
            <ul className="min-h-0 overflow-y-auto border-line px-3 pb-4 md:border-r" aria-label={t("notes.versions.listLabel")}>
              {versions === null ? <li className="px-2 py-3 text-sm text-muted">{t("common.loading")}</li> : null}
              {versions && versions.length === 0 ? <li className="px-2 py-3 text-sm text-muted">{error ?? t("notes.versions.none")}</li> : null}
              {versions?.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    aria-pressed={selected === v.id}
                    onClick={() => void pick(v.id)}
                    className={`flex w-full flex-col items-start gap-1 rounded-sm px-2.5 py-2 text-left ${selected === v.id ? "bg-ink text-paper" : "hover:bg-hover-paper"}`}
                  >
                    <span className="text-md font-semibold">{v.name ?? format.date(v.createdAt, "dateTime")}</span>
                    <span className={`text-xs ${selected === v.id ? "text-on-ink-muted" : "text-muted"}`}>
                      {kindLabel(v.kind)} · {v.name ? format.date(v.createdAt, "dateTime") : t("notes.versions.versionN", { n: v.docVersion })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex min-h-0 flex-col gap-3 overflow-hidden px-5 pb-5">
              {current ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <NeutralBadge size="sm" label={kindLabel(current.kind)} />
                      <span className="text-sm text-muted">{current.title}</span>
                    </div>
                    {canEdit ? (
                      <button type="button" disabled={busy} onClick={() => void restore(current)} className={aosButton({ size: "sm" })}>
                        <RotateCcw className="size-4" aria-hidden />
                        {t("notes.versions.restore")}
                      </button>
                    ) : null}
                  </div>
                  <pre className="min-h-[12rem] flex-1 overflow-auto rounded-md bg-canvas p-4 font-sans text-sm whitespace-pre-wrap text-ink">
                    {preview ?? t("common.loading")}
                  </pre>
                </>
              ) : (
                <p className="py-6 text-sm text-muted">{t("notes.versions.pick")}</p>
              )}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default VersionHistory;
