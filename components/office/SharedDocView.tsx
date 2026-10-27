// ShapesOS — faithful read-only rendering of a shared Office doc (Phase 23).
// Server component: the snapshot is flattened to plain HTML (headings, bold,
// sheet grids, slide text). No editor is mounted, so there is no toolbar, no
// caret, nothing to type or paste into, and no client JS that could change
// the view. The server also has no write route behind the public link.

import type { IDocumentData, IWorkbookData } from "@univerjs/core";
import { docSnapshotToParagraphs, sheetSnapshotToSheets } from "@/lib/univer/export";

function collectStreams(node: unknown, out: string[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectStreams(n, out, depth + 1);
    return;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.dataStream === "string") {
    const t = rec.dataStream.replace(/[\r\n]+/g, " ").trim();
    if (t) out.push(t);
    return;
  }
  for (const v of Object.values(rec)) collectStreams(v, out, depth + 1);
}

function slideTexts(snapshot: unknown): string[][] {
  const rec = (snapshot ?? {}) as { body?: { pages?: Record<string, unknown>; pageOrder?: string[] }; slides?: unknown[] };
  const pages = rec.body?.pages;
  if (pages && typeof pages === "object") {
    const order = (rec.body?.pageOrder ?? []).filter((id) => id in pages);
    const ids = order.length ? order : Object.keys(pages);
    return ids.map((id) => {
      const out: string[] = [];
      collectStreams(pages[id], out);
      return out;
    });
  }
  if (Array.isArray(rec.slides)) {
    return rec.slides.map((s) => (typeof s === "string" ? [s] : (() => { const o: string[] = []; collectStreams(s, o); return o; })()));
  }
  return [];
}

export default function SharedDocView({ kind, snapshot }: { kind: string; snapshot: unknown }) {
  if (kind === "doc") {
    const paras = docSnapshotToParagraphs(snapshot as IDocumentData);
    return (
      <article className="rounded-lg bg-paper px-8 py-6 shadow-hairline" aria-label="Shared document content">
        {paras.length === 0 && <p className="text-sm text-muted">This document is empty.</p>}
        {paras.map((p, i) => {
          const body = p.boldRanges.length ? <strong>{p.text}</strong> : p.text;
          if (p.headingLevel === 1) return <h2 key={i} className="mb-3 text-xl font-semibold text-ink">{body}</h2>;
          if (p.headingLevel === 2) return <h3 key={i} className="mb-2 text-lg font-semibold text-ink">{body}</h3>;
          if (p.headingLevel >= 3) return <h4 key={i} className="mb-2 text-base font-semibold text-ink">{body}</h4>;
          return <p key={i} className="mb-3 text-sm leading-relaxed text-ink">{body}</p>;
        })}
      </article>
    );
  }
  if (kind === "sheet") {
    const sheets = sheetSnapshotToSheets(snapshot as IWorkbookData);
    return (
      <div className="flex flex-col gap-6" aria-label="Shared spreadsheet content">
        {sheets.map((s, si) => (
          <section key={si} className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
            <h2 className="border-b border-line bg-canvas px-3 py-2 text-sm font-medium text-muted">{s.name}</h2>
            {s.rows.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted">This sheet is empty.</p>
            ) : (
              <table className="min-w-full border-collapse text-sm text-ink">
                <tbody>
                  {s.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-line">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1.5">{cell === null ? "" : String(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>
    );
  }
  const slides = slideTexts(snapshot);
  return (
    <div className="flex flex-col gap-4" aria-label="Shared slides content">
      {slides.length === 0 && <p className="text-sm text-muted">This deck is empty.</p>}
      {slides.map((texts, i) => (
        <section key={i} className="rounded-lg bg-paper px-8 py-6 shadow-hairline">
          <p className="mb-2 text-xs text-muted">Slide {i + 1}</p>
          {texts.map((t, ti) => (
            <p key={ti} className={ti === 0 ? "text-lg font-semibold text-ink" : "text-sm text-ink"}>{t}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
