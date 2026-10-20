"use client";

// ShapesOS — Phase 21B (WS=drive): Quick look — a floating preview of the selected file (Space, like
// Finder). Uses the same preview as the file details (images, PDF, text, Markdown, CSV, Excel and Word
// through the server preview) and offers the "Open with" handlers beside it. Esc closes.

import { useEffect, useRef } from "react";
import { Download, Info, X } from "lucide-react";
import { aosButton } from "@/components/aos";
import { FilePreview } from "@/components/files/FilePreview";
import { useI18n } from "@/components/i18n/I18nProvider";
import { fmtSize, type Row } from "@/lib/drive/client/rows";
import { openWithFor } from "@/lib/drive/client/open-with";
import { downloadUrl } from "./api";

export function QuickLook({ workspaceId, row, onClose, onDetails }: { workspaceId: string; row: Row; onClose: () => void; onDetails: () => void }) {
  const { t } = useI18n();
  const ws = encodeURIComponent(workspaceId);
  const closeRef = useRef<HTMLButtonElement>(null);
  // One listener for the dialog's whole life: the latest onClose is read through a ref, so a parent
  // re-render never leaves a gap where Esc would be missed.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    // Registered a tick late: Space opened this very dialog, and the same keydown is still bubbling
    // up to window, where a listener added now would see it and close the dialog again.
    const arm = setTimeout(() => window.addEventListener("keydown", onKey), 0);
    return () => {
      clearTimeout(arm);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  const handlers = openWithFor(row).filter((h) => h.id !== "drive:quick-look");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t("drive.quickLook.title", { name: row.name })} className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-paper shadow-overlay">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-md font-semibold text-ink">{row.name}</h2>
            <p className="truncate font-mono text-xs text-muted">
              {row.path} · {fmtSize(row.sizeBytes)}
              {row.version && row.version > 1 ? ` · ${t("filesApp.versions.versionN", { n: row.version })}` : ""}
            </p>
          </div>
          <button type="button" onClick={onDetails} className={aosButton({ variant: "quiet", size: "xs" })}>
            <Info className="size-3.5" aria-hidden /> {t("drive.actions.details")}
          </button>
          <a href={downloadUrl(workspaceId, row.id)} className={aosButton({ variant: "quiet", size: "xs" })}>
            <Download className="size-3.5" aria-hidden /> {t("filesApp.download")}
          </a>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t("common.close")} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <FilePreview src={downloadUrl(workspaceId, row.id)} mimeType={row.mimeType ?? "application/octet-stream"} filename={row.name} officeUrl={`/api/files/${encodeURIComponent(row.id)}/preview?workspaceId=${ws}`} />
        </div>
        {handlers.length ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
            <span className="text-xs font-semibold text-muted">{t("drive.actions.openWith")}</span>
            {handlers.map((h) => (
              <button key={h.id} type="button" onClick={() => void h.open(row)} className={aosButton({ variant: "secondary", size: "xs" })}>
                {h.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
