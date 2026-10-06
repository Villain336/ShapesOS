"use client";

// ShapesOS — Phase 18.2 (WS=content): a record's notes. Any record page drops
// this in with its Spotlight kind and id; it lists the notes linked to the
// record (the ones the viewer can see) and adds new ones through quick
// capture with the record pre-linked.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { NotebookPen, Plus } from "lucide-react";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { NoteSummary } from "@/lib/notes/service";
import { NOTES_CHANGED_EVENT, openQuickCapture } from "./events";

export function RecordNotes({ kind, id, label, className }: { kind: string; id: string; label: string; className?: string }) {
  const { t, format } = useI18n();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/notes?recordKind=${encodeURIComponent(kind)}&recordId=${encodeURIComponent(id)}&facets=0&limit=20`, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setNotes([]);
      return;
    }
    const body = (await res.json()) as { notes: NoteSummary[] };
    setNotes(body.notes);
  }, [kind, id]);

  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener(NOTES_CHANGED_EVENT, on);
    return () => window.removeEventListener(NOTES_CHANGED_EVENT, on);
  }, [load]);

  return (
    <section aria-labelledby={`record-notes-${id}`} className={`rounded-lg bg-paper p-5 shadow-hairline ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 id={`record-notes-${id}`} className="flex items-center gap-2 aos-subheading">
          <NotebookPen className="size-5" aria-hidden />
          {t("notes.record.title")}
        </h2>
        <button type="button" onClick={() => openQuickCapture({ links: [{ kind, id, label }] })} className={aosButton({ variant: "secondary", size: "xs" })}>
          <Plus className="size-3.5" aria-hidden />
          {t("notes.record.add")}
        </button>
      </div>
      {notes === null ? (
        <p className="mt-3 text-sm text-muted">{t("common.loading")}</p>
      ) : notes.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("notes.record.empty")}</p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {notes.map((n) => (
            <li key={n.id} className="border-b border-line last:border-0">
              <Link href={`/dashboard/notes?note=${encodeURIComponent(n.id)}`} className="flex flex-col gap-0.5 rounded-sm px-2 py-2.5 hover:bg-hover-paper">
                <span className="truncate text-md font-semibold text-ink">{n.title}</span>
                {n.preview ? <span className="line-clamp-2 text-sm text-muted">{n.preview}</span> : null}
                <span suppressHydrationWarning className="text-xs text-muted">{format.relative(n.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default RecordNotes;
