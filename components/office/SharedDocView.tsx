// ShapesOS - read-only rendering of a shared Office doc (Phase 23).
// Server component over lib/sharing/render-support. No editor is mounted:
// no toolbar, caret, contenteditable or client JS. Callers must have passed
// assessSnapshot; content the viewer can't render is rejected, not dropped.

import { docToBlocks, sheetToGrids, slideToPages, type DocBlock, type Seg } from "@/lib/sharing/render-support";

function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) => {
        let n: React.ReactNode = s.text;
        if (s.bold) n = <strong>{n}</strong>;
        if (s.italic) n = <em>{n}</em>;
        if (s.underline) n = <u>{n}</u>;
        if (s.strike) n = <s>{n}</s>;
        // href was validated by safeHref (absolute http/https/mailto only).
        if (s.href) n = <a href={s.href} target="_blank" rel="noopener noreferrer nofollow" className="text-ink underline underline-offset-2">{n}</a>;
        return <span key={i}>{n}</span>;
      })}
    </>
  );
}

function Blocks({ blocks }: { blocks: DocBlock[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.table) {
          return (
            <div key={i} className="mb-3 overflow-x-auto" data-shared-table>
              <table className="min-w-full border-collapse text-sm text-ink">
                <tbody>
                  {b.table.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="border border-line px-3 py-1.5 align-top"><Blocks blocks={cell} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        const empty = b.segs.every((s) => s.text.trim() === "");
        if (empty && b.level === 0) return <div key={i} className="h-3" aria-hidden />;
        if (b.level === 1) return <h2 key={i} className="mb-3 text-xl font-semibold text-ink"><Segs segs={b.segs} /></h2>;
        if (b.level === 2) return <h3 key={i} className="mb-2 text-lg font-semibold text-ink"><Segs segs={b.segs} /></h3>;
        if (b.level === 3) return <h4 key={i} className="mb-2 text-base font-semibold text-ink"><Segs segs={b.segs} /></h4>;
        if (b.bullet) return <p key={i} className="mb-1 pl-5 text-sm text-ink before:mr-2 before:content-['•']"><Segs segs={b.segs} /></p>;
        return <p key={i} className="mb-3 text-sm leading-relaxed text-ink"><Segs segs={b.segs} /></p>;
      })}
    </>
  );
}

export default function SharedDocView({ kind, snapshot }: { kind: string; snapshot: unknown }) {
  if (kind === "doc") {
    return (
      <article className="rounded-lg bg-paper px-8 py-6 shadow-hairline" aria-label="Shared document content">
        <Blocks blocks={docToBlocks(snapshot)} />
      </article>
    );
  }
  if (kind === "sheet") {
    return (
      <div className="flex flex-col gap-6" aria-label="Shared spreadsheet content">
        {sheetToGrids(snapshot).map((s, si) => (
          <section key={si} className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
            <h2 className="border-b border-line bg-canvas px-3 py-2 text-sm font-medium text-muted">{s.name}</h2>
            {s.rows.length === 0 ? (
              <p className="px-3 py-4 text-sm text-muted">This sheet is empty.</p>
            ) : (
              <table className="min-w-full border-collapse text-sm text-ink">
                <tbody>
                  {s.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-line">
                      {row.map((c, ci) => <td key={ci} className="px-3 py-1.5">{c}</td>)}
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
  return (
    <div className="flex flex-col gap-4" aria-label="Shared slides content">
      {slideToPages(snapshot).map((p, i) => (
        <section key={i} className="rounded-lg bg-paper px-8 py-6 shadow-hairline" aria-label={`Slide ${i + 1}`}>
          <p className="mb-2 text-xs text-muted">Slide {i + 1}</p>
          {p.elements.map((blocks, ei) => <Blocks key={ei} blocks={blocks} />)}
        </section>
      ))}
    </div>
  );
}

export function UnsupportedShare() {
  return (
    <div className="rounded-lg bg-paper px-8 py-6 text-sm text-muted shadow-hairline" role="status">
      This shared document is unavailable.
    </div>
  );
}
