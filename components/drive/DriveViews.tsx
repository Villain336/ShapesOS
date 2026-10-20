"use client";

// ShapesOS — Phase 21B (WS=drive): the three ways to look at a folder — a dense table (list), big
// tiles (icons) and Finder-style columns. List data is a table (DESIGN.md: dense tables where lists);
// selection works the same in all three: click selects, ⌘/Ctrl-click and the checkboxes add, Shift
// extends, double click or Enter opens.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { ChevronRight, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/I18nProvider";
import { fileClass, fmtSize, type Row, type SortKey } from "@/lib/drive/client/rows";
import { DriveIcon } from "./DriveIcon";

export interface SelectEvent {
  additive: boolean;
  range: boolean;
}

const selOf = (e: MouseEvent | KeyboardEvent): SelectEvent => ({ additive: e.metaKey || e.ctrlKey, range: e.shiftKey });

function KindLabel({ row }: { row: Row }) {
  const { t } = useI18n();
  return <>{t(`drive.kinds.${fileClass(row)}` as never)}</>;
}

export function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {tags.slice(0, 3).map((x) => (
        <span key={x} className="rounded-full bg-canvas px-2 py-0.5 text-xs font-semibold text-muted">
          {x}
        </span>
      ))}
    </span>
  );
}

export function ListView({
  rows,
  selected,
  onSelect,
  onOpen,
  onToggleFavorite,
  sort,
  onSort,
  dateLabel,
  noteLabel,
  caption,
  showKind = true,
}: {
  rows: Row[];
  selected: ReadonlySet<string>;
  onSelect: (row: Row, ev: SelectEvent) => void;
  onOpen: (row: Row) => void;
  onToggleFavorite?: (row: Row) => void;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  dateLabel: string;
  noteLabel?: string;
  caption: string;
  showKind?: boolean;
}) {
  const { t, format } = useI18n();
  const th = (key: SortKey, label: string, cls = "") => {
    const on = sort.key === key;
    return (
      <th scope="col" aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={cn("px-3 py-2 text-left text-xs font-semibold text-muted", cls)}>
        <button type="button" onClick={() => onSort(key)} className="inline-flex items-center gap-1 rounded-sm hover:text-ink">
          {label}
          {on ? <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
        </button>
      </th>
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-line">
          <tr>
            <th scope="col" className="w-10 px-3 py-2">
              <span className="sr-only">{t("drive.table.select")}</span>
            </th>
            {th("name", t("drive.table.name"))}
            {showKind ? th("kind", t("drive.table.kind"), "hidden md:table-cell") : null}
            {th("size", t("drive.table.size"), "hidden sm:table-cell")}
            {th("modified", dateLabel)}
            {noteLabel ? (
              <th scope="col" className="hidden px-3 py-2 text-left text-xs font-semibold text-muted lg:table-cell">
                {noteLabel}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const on = selected.has(r.id);
            return (
              <tr key={`${r.kind}:${r.id}`} aria-selected={on} className={cn("border-b border-line last:border-0 hover:bg-hover-paper", on && "bg-hover")} onDoubleClick={() => onOpen(r)}>
                <td className="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => onSelect(r, { additive: true, range: (e.nativeEvent as unknown as { shiftKey?: boolean }).shiftKey === true })}
                    aria-label={t("drive.table.selectRow", { name: r.name })}
                    className="size-4 accent-[var(--aos-ink)]"
                  />
                </td>
                <td className="px-3 py-1.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <DriveIcon kind={fileClass(r)} />
                    <button
                      type="button"
                      onClick={(e) => onSelect(r, selOf(e))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onOpen(r);
                        }
                      }}
                      className="min-w-0 truncate rounded-sm text-left text-md font-semibold text-ink hover:underline"
                    >
                      {r.name}
                    </button>
                    <TagChips tags={r.tags} />
                    {onToggleFavorite && !r.system ? (
                      <button
                        type="button"
                        onClick={() => onToggleFavorite(r)}
                        aria-pressed={r.favorite}
                        aria-label={r.favorite ? t("drive.actions.unfavorite", { name: r.name }) : t("drive.actions.favorite", { name: r.name })}
                        className="ml-auto grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink"
                      >
                        <Star className={cn("size-3.5", r.favorite && "fill-current text-ink")} aria-hidden />
                      </button>
                    ) : null}
                  </div>
                </td>
                {showKind ? (
                  <td className="hidden px-3 py-1.5 text-muted md:table-cell">
                    <KindLabel row={r} />
                  </td>
                ) : null}
                <td className="hidden px-3 py-1.5 text-muted sm:table-cell">{r.kind === "file" ? fmtSize(r.sizeBytes) : "—"}</td>
                <td className="px-3 py-1.5 text-muted">{r.modifiedAt && r.modifiedAt > "1971" ? format.date(new Date(r.modifiedAt), "dateTime") : "—"}</td>
                {noteLabel ? <td className="hidden px-3 py-1.5 text-muted lg:table-cell">{r.note ?? r.path}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function IconView({ rows, selected, onSelect, onOpen, caption }: { rows: Row[]; selected: ReadonlySet<string>; onSelect: (row: Row, ev: SelectEvent) => void; onOpen: (row: Row) => void; caption: string }) {
  return (
    <ul aria-label={caption} className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 p-3">
      {rows.map((r) => {
        const on = selected.has(r.id);
        return (
          <li key={`${r.kind}:${r.id}`}>
            <button
              type="button"
              aria-pressed={on}
              onClick={(e) => onSelect(r, selOf(e))}
              onDoubleClick={() => onOpen(r)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onOpen(r);
                }
              }}
              className={cn("flex w-full flex-col items-center gap-2 rounded-lg px-2 py-3 text-center hover:bg-hover-paper", on && "bg-hover shadow-outline")}
            >
              <DriveIcon kind={fileClass(r)} className="size-9 text-muted" />
              <span className="line-clamp-2 w-full break-words text-sm font-semibold text-ink">{r.name}</span>
              {r.kind === "file" ? <span className="text-xs text-muted">{fmtSize(r.sizeBytes)}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface Column {
  path: string;
  rows: Row[] | null;
  selectedId: string | null;
  error?: boolean;
}

/** Finder-style columns: each folder you open adds a column; a file selects it for the details pane. */
export function ColumnsView({
  startPath,
  load,
  onNavigate,
  onSelectFile,
  onOpenFile,
  caption,
}: {
  startPath: string;
  load: (path: string) => Promise<Row[]>;
  /** The deepest folder shown changed (breadcrumbs follow). */
  onNavigate: (path: string) => void;
  onSelectFile: (row: Row | null) => void;
  onOpenFile: (row: Row) => void;
  caption: string;
}) {
  const { t } = useI18n();
  const [cols, setCols] = useState<Column[]>([{ path: startPath, rows: null, selectedId: null }]);
  const scroller = useRef<HTMLDivElement>(null);

  // The parent re-keys this component when the start folder or a reload changes, so the first
  // column is loaded once per mount and state is only set when the answer arrives.
  useEffect(() => {
    let live = true;
    load(startPath)
      .then((rows) => live && setCols([{ path: startPath, rows, selectedId: null }]))
      .catch(() => live && setCols([{ path: startPath, rows: [], selectedId: null, error: true }]));
    return () => {
      live = false;
    };
  }, [startPath, load]);

  useEffect(() => {
    scroller.current?.scrollTo({ left: scroller.current.scrollWidth, behavior: "smooth" });
  }, [cols.length]);

  async function choose(colIdx: number, row: Row) {
    if (row.kind === "folder") {
      setCols((c) => [...c.slice(0, colIdx), { ...c[colIdx]!, selectedId: row.id }, { path: row.path, rows: null, selectedId: null }]);
      onSelectFile(null);
      onNavigate(row.path);
      try {
        const rows = await load(row.path);
        setCols((c) => c.map((x, i) => (i === colIdx + 1 && x.path === row.path ? { ...x, rows } : x)));
      } catch {
        setCols((c) => c.map((x, i) => (i === colIdx + 1 && x.path === row.path ? { ...x, rows: [], error: true } : x)));
      }
    } else {
      setCols((c) => [...c.slice(0, colIdx + 1).map((x, i) => (i === colIdx ? { ...x, selectedId: row.id } : x))]);
      onSelectFile(row);
    }
  }

  return (
    <div ref={scroller} className="flex min-h-72 overflow-x-auto" role="group" aria-label={caption}>
      {cols.map((col, i) => (
        <ul key={col.path} aria-label={col.path} className="w-60 shrink-0 overflow-y-auto border-r border-line py-1 last:border-r-0">
          {col.rows === null ? (
            <li className="px-3 py-2 text-sm text-muted">{t("common.loading")}</li>
          ) : col.rows.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">{col.error ? t("drive.states.loadFailed") : t("drive.states.emptyFolder")}</li>
          ) : (
            col.rows.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <button
                  type="button"
                  aria-pressed={col.selectedId === r.id}
                  onClick={() => void choose(i, r)}
                  onDoubleClick={() => r.kind === "file" && onOpenFile(r)}
                  className={cn("flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm font-medium hover:bg-hover-paper", col.selectedId === r.id && "bg-ink text-paper hover:bg-ink")}
                >
                  <DriveIcon kind={fileClass(r)} className={cn("size-4 shrink-0", col.selectedId === r.id ? "text-paper" : "text-muted")} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {r.kind === "folder" ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      ))}
    </div>
  );
}
