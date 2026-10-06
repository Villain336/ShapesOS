"use client";

// ShapesOS — Phase 18.2 (WS=content): link a note to any record. Searches
// with Spotlight (GET /api/search/records — the same index, role gates and
// per-record visibility as ⌘K) and hands the picked {kind, id, title} back.

import { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";

export interface PickedRecord {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
}

export function LinkRecordPicker({ onPick, exclude = [] }: { onPick: (r: PickedRecord) => void; exclude?: Array<{ kind: string; id: string }> }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PickedRecord[] | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search/records?q=${encodeURIComponent(query)}&limit=4`, { signal: ctl.signal, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((body: { results: PickedRecord[] }) => {
          const list = (body.results ?? []).filter((r) => r.kind !== "note" && !exclude.some((e) => e.kind === r.kind && e.id === r.id)).slice(0, 12);
          setResults(list);
          setActive(0);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, exclude]);

  const kindLabel = (kind: string) => {
    const key = `records.kinds.${kind}` as MessageKey;
    const label = t(key);
    return label === key ? kind : label;
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="relative block">
        <span className="sr-only">{t("notes.links.searchLabel")}</span>
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (!results?.length) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const r = results[active];
              if (r) onPick(r);
            }
          }}
          role="combobox"
          aria-expanded={!!results?.length}
          aria-controls={listId}
          aria-activedescendant={results?.length ? `${listId}-${active}` : undefined}
          placeholder={t("notes.links.searchPlaceholder")}
          className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
        />
      </label>
      <ul id={listId} role="listbox" aria-label={t("notes.links.resultsLabel")} className="max-h-64 overflow-y-auto">
        {results && results.length === 0 ? <li className="px-2 py-2 text-sm text-muted">{t("notes.links.noResults")}</li> : null}
        {results?.map((r, i) => (
          <li key={`${r.kind}:${r.id}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
            <button
              type="button"
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(r)}
              className={`flex w-full items-center justify-between gap-3 rounded-sm px-2.5 py-2 text-left ${i === active ? "bg-ink text-paper" : "hover:bg-hover-paper"}`}
            >
              <span className="min-w-0">
                <span className="block truncate text-md font-semibold">{r.title}</span>
                {r.subtitle ? <span className={`block truncate text-xs ${i === active ? "text-on-ink-muted" : "text-muted"}`}>{r.subtitle}</span> : null}
              </span>
              <span className={`shrink-0 text-xs ${i === active ? "text-on-ink-muted" : "text-subtle"}`}>{kindLabel(r.kind)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default LinkRecordPicker;
