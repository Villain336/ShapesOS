// Marketr — Phase 11 "Canvas": icons panel (Iconify, default, no key).
// Searches 100k+ icons across permissive-only open-source sets (the picker's
// prefix allowlist lives in lib/design/iconify.ts — MIT/Apache-2.0/ISC/CC0,
// no attribution required). Clicking a result fetches the SVG once,
// sanitizes it, and stores prefix:name + body + viewBox in the element's
// document data, so canvas rendering and PNG/PDF/SVG export never touch the
// network afterward. Provenance travels in the element's `custom` bag.

"use client";

import { useState } from "react";
import { ImageOff, Loader2, Search, Shapes } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { makeIconifySvg } from "../factory";
import {
  PERMISSIVE_PREFIXES,
  fetchIconBatch,
  iconDataUrl,
  searchIcons,
  type IconSvg,
} from "@/lib/design/iconify";
import { btnPrimary, inputCls, panelTitle } from "../ui";

const PAGE_SIZE = 32;
// Fill baked into the inserted icon's SVG (design document data + its data-URL
// preview). It must be a literal color — CSS variables don't resolve inside an
// <img> data URL or an exported design.
const FILL = "#1c1917";

const PREFIX_LABELS: Record<string, string> = {
  mdi: "Material Design Icons",
  "material-symbols": "Material Symbols",
  lucide: "Lucide",
  tabler: "Tabler",
  heroicons: "Heroicons",
  bi: "Bootstrap Icons",
  ph: "Phosphor",
  fluent: "Fluent",
  ri: "Remix Icon",
  carbon: "Carbon",
  devicon: "Devicon",
  "simple-icons": "Simple Icons (brands)",
  logos: "SVG Logos",
  noto: "Noto Emoji",
};

export function IconsPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const [query, setQuery] = useState("");
  const [prefix, setPrefix] = useState<string>("all");
  const [searched, setSearched] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<IconSvg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = document?.pages.find((p) => p.id === activePageId);

  const place = (icon: IconSvg) => {
    if (!page) return;
    addElement({
      ...makeIconifySvg({
        iconRef: icon.ref,
        body: icon.body,
        viewBox: icon.viewBox,
        fill: FILL,
        pageW: page.width,
        pageH: page.height,
        name: icon.ref,
      }),
      custom: {
        iconifyRef: icon.ref,
        iconifyPrefix: icon.prefix,
        source: "iconify",
      },
    });
  };

  const search = async () => {
    const q = query.trim();
    if (q.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { results: hits, total: t } = await searchIcons(q, {
        prefixes: prefix === "all" ? undefined : [prefix],
        limit: PAGE_SIZE,
      });
      // Group hits by prefix and batch-fetch one request per prefix.
      const byPrefix = new Map<string, string[]>();
      for (const h of hits) {
        const list = byPrefix.get(h.prefix) ?? [];
        list.push(h.name);
        byPrefix.set(h.prefix, list);
      }
      const batches = await Promise.all(
        [...byPrefix.entries()].map(([p, names]) =>
          fetchIconBatch(p, names).catch(() => [] as IconSvg[]),
        ),
      );
      setResults(batches.flat());
      setTotal(t);
      setSearched(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Icon search failed.");
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  if (!page) return null;

  return (
    <div>
      <div className={panelTitle}>Icons</div>
      <div className="space-y-3 px-3 pb-4">
        <div className="flex gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
            placeholder="Search icons…"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button
            onClick={() => void search()}
            disabled={query.trim().length === 0 || busy}
            className={btnPrimary}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Search
          </button>
        </div>
        <select
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          className={`${inputCls} w-full`}
          aria-label="Icon set"
        >
          <option value="all">All icon sets</option>
          {PERMISSIVE_PREFIXES.map((p) => (
            <option key={p} value={p}>
              {PREFIX_LABELS[p] ?? p}
            </option>
          ))}
        </select>
        {error && (
          <p className="rounded-md border border-failed bg-failed-tint px-2.5 py-2 text-[0.75rem] leading-snug text-failed-text">
            {error}
          </p>
        )}
        {results.length > 0 ? (
          <>
            <p className="text-[0.6875rem] text-subtle">
              {total > results.length
                ? `Showing ${results.length} of ~${total.toLocaleString()} matches`
                : `${results.length} match${results.length === 1 ? "" : "es"}`}
              {searched ? ` for “${searched}”` : ""}
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {results.map((icon) => (
                <button
                  key={icon.ref}
                  onClick={() => place(icon)}
                  title={`${icon.ref} — click to place`}
                  className="flex aspect-square items-center justify-center rounded-md border border-line bg-paper p-2 hover:border-line-strong hover:bg-hover-paper"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={iconDataUrl(icon.body, icon.viewBox, FILL)}
                    alt={icon.ref}
                    loading="lazy"
                    className="h-full w-full"
                  />
                </button>
              ))}
            </div>
          </>
        ) : searched !== null && !busy ? (
          <p className="flex items-start gap-1.5 text-[0.75rem] text-muted">
            <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              No icons found for “{searched}”. Try another search or a different
              set.
            </span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5 text-[0.75rem] leading-snug text-muted">
            <Shapes className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
            <span>
              Search 100k+ icons from open-source sets. Click an icon to place
              it — it lands in ink and recolors from the toolbar.
            </span>
          </p>
        )}
        <p className="border-t border-line pt-2 text-[0.6875rem] leading-snug text-subtle">
          Only permissively-licensed sets (MIT, Apache-2.0, ISC, CC0) are
          searchable — no attribution required on your exports. Icons are
          stored in your design, so exports never phone home.
        </p>
      </div>
    </div>
  );
}
