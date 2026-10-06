"use client";

// ShapesOS — Phase 18.2 (WS=content): show a file in the browser.
// Images, video, audio, text, Markdown and CSV from the bytes; PDFs with
// pdf.js (components/files/PdfViewer.tsx, loaded on demand); Excel and Word
// through the server preview (the existing exceljs reader / text extractor);
// anything else says to download it.

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { FileQuestion } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { parseCsv, previewKind } from "@/lib/files/preview";
import type { NewPdfAnnotation, PdfAnnotation } from "./PdfViewer";

const PdfViewer = dynamic(() => import("./PdfViewer"), { ssr: false });

const MAX_TEXT = 200_000;

function Table({ rows, caption }: { rows: string[][]; caption: string }) {
  const [head, ...body] = rows;
  return (
    <div className="max-h-[60vh] overflow-auto rounded-md border border-line">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        {head ? (
          <thead className="sticky top-0 bg-canvas">
            <tr>
              {head.map((c, i) => (
                <th key={i} scope="col" className="border-b border-line px-2.5 py-1.5 text-left font-semibold text-ink">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-2.5 py-1.5 text-muted">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilePreview({
  src,
  mimeType,
  filename,
  officeUrl,
  pdf,
}: {
  /** Where the bytes are (same origin). */
  src: string;
  mimeType: string;
  filename: string;
  /** The server preview for Excel / Word (members only). */
  officeUrl?: string;
  pdf?: { annotations: PdfAnnotation[]; canAnnotate: boolean; onCreate?: (a: NewPdfAnnotation) => Promise<void>; onRemove?: (id: string) => Promise<void> };
}) {
  const { t } = useI18n();
  const kind = previewKind(mimeType, filename);
  const [text, setText] = useState<string | null>(null);
  const [office, setOffice] = useState<{ kind: "table"; sheets: Array<{ name: string; rows: string[][] }> } | { kind: "text"; text: string } | { kind: "none" } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setText(null);
    setOffice(null);
    setFailed(false);
    const ctl = new AbortController();
    if (kind === "text" || kind === "markdown" || kind === "csv") {
      fetch(src, { signal: ctl.signal, cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          setText((await r.text()).slice(0, MAX_TEXT));
        })
        .catch(() => !ctl.signal.aborted && setFailed(true));
    } else if (kind === "office" && officeUrl) {
      fetch(officeUrl, { signal: ctl.signal, cache: "no-store" })
        .then(async (r) => {
          if (!r.ok) throw new Error(String(r.status));
          setOffice(await r.json());
        })
        .catch(() => !ctl.signal.aborted && setFailed(true));
    }
    return () => ctl.abort();
  }, [src, kind, officeUrl]);

  const none = (
    <div className="flex flex-col items-center gap-2 rounded-md bg-canvas px-6 py-12 text-center">
      <FileQuestion className="size-6 text-subtle" aria-hidden />
      <p className="text-md font-semibold text-ink">{t("filesApp.preview.noneTitle")}</p>
      <p className="max-w-[40ch] text-sm text-muted">{t("filesApp.preview.noneBody")}</p>
    </div>
  );

  if (failed) {
    return (
      <p role="alert" className="flex items-center gap-2 py-6 text-sm font-semibold text-failed-text">
        <span aria-hidden className="size-2 shrink-0 bg-failed" />
        {t("filesApp.preview.loadFailed")}
      </p>
    );
  }
  switch (kind) {
    case "image":
      // eslint-disable-next-line @next/next/no-img-element -- user file bytes from our own route, not an optimisable static image
      return <img src={src} alt={filename} className="mx-auto max-h-[70vh] max-w-full rounded-md bg-canvas object-contain" />;
    case "video":
      return <video src={src} controls className="max-h-[70vh] w-full rounded-md bg-night" aria-label={filename} />;
    case "audio":
      return <audio src={src} controls className="w-full" aria-label={filename} />;
    case "pdf":
      return <PdfViewer src={src} annotations={pdf?.annotations ?? []} canAnnotate={!!pdf?.canAnnotate} onCreate={pdf?.onCreate} onRemove={pdf?.onRemove} />;
    case "csv":
      return text === null ? <p className="text-sm text-muted">{t("common.loading")}</p> : <Table rows={parseCsv(text)} caption={filename} />;
    case "text":
    case "markdown":
      return text === null ? (
        <p className="text-sm text-muted">{t("common.loading")}</p>
      ) : (
        <pre className="max-h-[70vh] overflow-auto rounded-md bg-canvas p-4 font-mono text-sm whitespace-pre-wrap text-ink">{text}</pre>
      );
    case "office":
      if (!officeUrl) return none;
      if (!office) return <p className="text-sm text-muted">{t("common.loading")}</p>;
      if (office.kind === "table")
        return (
          <div className="flex flex-col gap-4">
            {office.sheets.map((s) => (
              <section key={s.name} className="flex flex-col gap-1.5">
                <h3 className="text-sm font-semibold text-ink">{s.name}</h3>
                <Table rows={s.rows} caption={s.name} />
              </section>
            ))}
          </div>
        );
      if (office.kind === "text") return <pre className="max-h-[70vh] overflow-auto rounded-md bg-canvas p-4 font-sans text-sm whitespace-pre-wrap text-ink">{office.text}</pre>;
      return none;
    default:
      return none;
  }
}

export default FilePreview;
