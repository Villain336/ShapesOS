"use client";

// ShapesOS — Phase 18.2 (WS=content): quick capture. One dialog for the whole
// dashboard (mounted in app/dashboard/layout.tsx), opened from anywhere by the
// "notes.capture" shortcut (⌥⇧N, lib/keyboard/shortcuts.ts), the Home Notes
// widget or a record's notes panel (which pre-links the record). Type, press
// ⌘↵ (or Save note), done: the note is private and lands in Notes.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Link2, NotebookPen } from "lucide-react";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import { sendSafeWrite } from "@/lib/offline/client";
import { NOTE_CAPTURE_EVENT, notifyNotesChanged, type NoteCaptureDetail } from "./events";

export function QuickCapture() {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [links, setLinks] = useState<NonNullable<NoteCaptureDetail["links"]>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const detail = ((e as CustomEvent<NoteCaptureDetail>).detail ?? {}) as NoteCaptureDetail;
      setLinks(detail.links ?? []);
      setError(null);
      setOpen(true);
    };
    window.addEventListener(NOTE_CAPTURE_EVENT, on);
    return () => window.removeEventListener(NOTE_CAPTURE_EVENT, on);
  }, []);

  async function save() {
    const body = text.trim();
    if (!body) {
      setError(t("notes.capture.empty"));
      return;
    }
    setSaving(true);
    // Phase 18.3 (WS=flow): offline, the note is queued with a client id and
    // sent once when the connection returns (lib/offline/queue.ts).
    const out = await sendSafeWrite("note_create", { body, links });
    setSaving(false);
    if (out.status === "queued") {
      setText("");
      setOpen(false);
      toast({ title: t("flow.offline.queuedNote") });
      return;
    }
    const json = (out.status === "sent" ? out.data : { error: out.error }) as { note?: { id: string; title: string }; error?: string };
    if (out.status !== "sent" || !json.note) {
      toastError(t("notes.capture.failed"), json.error);
      return;
    }
    const note = json.note;
    setText("");
    setOpen(false);
    notifyNotesChanged();
    toast({
      title: t("notes.capture.saved", { title: note.title }),
      action: { label: t("common.open"), onClick: () => router.push(`/dashboard/notes?note=${encodeURIComponent(note.id)}`) },
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/30" />
        <Dialog.Popup
          initialFocus={area}
          className="fixed top-[14%] left-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg bg-paper p-5 shadow-overlay"
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Dialog.Title className="flex items-center gap-2 aos-subheading">
              <NotebookPen className="size-5" aria-hidden />
              {t("notes.capture.title")}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-muted">{t("notes.capture.hint")}</Dialog.Description>
            <label className="flex flex-col gap-2">
              <span className="sr-only">{t("notes.capture.label")}</span>
              <textarea
                ref={area}
                value={text}
                rows={6}
                maxLength={20_000}
                onChange={(e) => {
                  setText(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void save();
                  }
                }}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? "quick-capture-error" : undefined}
                placeholder={t("notes.capture.placeholder")}
                className="w-full resize-y rounded-md border-[1.5px] border-control bg-paper px-3.5 py-3 text-base text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
              />
            </label>
            {error ? (
              <p id="quick-capture-error" role="alert" className="flex items-center gap-2 text-sm font-semibold text-failed-text">
                <span aria-hidden className="size-2 shrink-0 bg-failed" />
                {error}
              </p>
            ) : null}
            {links.length ? (
              <p className="flex items-center gap-1.5 text-sm text-muted">
                <Link2 className="size-4" aria-hidden />
                {t("notes.capture.linkedTo", { names: links.map((l) => l.label ?? l.id).join(", ") })}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Dialog.Close className={aosButton({ variant: "quiet", size: "sm" })}>{t("common.cancel")}</Dialog.Close>
              <button type="submit" disabled={saving} className={aosButton({ size: "sm" })}>
                {saving ? t("common.saving") : t("notes.capture.save")}
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default QuickCapture;
