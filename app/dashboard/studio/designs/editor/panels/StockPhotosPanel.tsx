// Marketr — Phase 11 "Canvas": stock photos panel (Unsplash).
// Server-side search proxy; the API key never reaches the browser.
// Honest empty state when unconfigured — never fake photos. Clicking a
// result places it on canvas via the existing image-insert factory, with
// photographer credit in the element's `custom` bag (unsplashId,
// photographer, photographerUrl) so exports/credits stay traceable.

"use client";

import { useEffect, useState } from "react";
import { ImageOff, Loader2, Search, Settings } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { fitBox, makeImage } from "../factory";
import type { StockPhoto } from "@/lib/design/unsplash";
import { btnGhost, btnPrimary, inputCls, panelTitle } from "../ui";

const MAX_DIM = 800;
const PAGE_SIZE = 12;

interface SearchPayload {
  results?: StockPhoto[];
  total?: number;
  error?: string;
  code?: string;
}

export function StockPhotosPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<StockPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = document?.pages.find((p) => p.id === activePageId);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/studio/unsplash/status");
        const json = (await res.json()) as { configured?: boolean };
        if (live) setConfigured(res.ok && json.configured === true);
      } catch {
        if (live) setConfigured(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const place = (photo: StockPhoto) => {
    if (!page) return;
    const { width, height } = fitBox(photo.width || 800, photo.height || 600, MAX_DIM);
    addElement({
      ...makeImage({
        src: photo.urls.regular,
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: (photo.alt ?? "Stock photo").slice(0, 40),
      }),
      custom: {
        unsplashId: photo.id,
        photographer: photo.photographer,
        photographerUrl: photo.photographerUrl,
      },
    });
  };

  const search = async () => {
    const q = query.trim();
    if (q.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/studio/unsplash/search?${new URLSearchParams({ q, per_page: String(PAGE_SIZE) })}`,
      );
      const json = (await res.json()) as SearchPayload;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setResults(json.results ?? []);
      setSearched(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!page) return null;

  return (
    <div>
      <div className={panelTitle}>Stock photos</div>
      <div className="space-y-3 px-3 pb-4">
        {configured === null ? (
          <p className="flex items-center gap-1.5 text-[12px] text-stone-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking stock photo setup…
          </p>
        ) : configured === false ? (
          <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
            <p className="text-[13px] font-medium text-stone-800">
              Stock photos need a free Unsplash API key
            </p>
            <p className="mt-1 text-[12px] leading-snug text-stone-500">
              Get one free at unsplash.com/developers, then add it in Settings
              → Providers.
            </p>
            <a href="/dashboard/settings/providers" className={`${btnGhost} mt-2 inline-flex`}>
              <Settings className="h-4 w-4" />
              Open Providers
            </a>
          </div>
        ) : (
          <>
            <div className="flex gap-1.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void search();
                }}
                placeholder="Search free photos…"
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
            {error && (
              <p className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-snug text-red-700">
                {error}
              </p>
            )}
            {results.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {results.map((photo) => (
                  <div
                    key={photo.id}
                    className="overflow-hidden rounded-md border border-stone-200 bg-white hover:border-violet-400"
                  >
                    <button
                      onClick={() => place(photo)}
                      title={`Place photo${photo.alt ? ` — ${photo.alt}` : ""}`}
                      className="block w-full"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photo.urls.small}
                        alt={photo.alt ?? "Stock photo"}
                        loading="lazy"
                        className="h-20 w-full object-cover"
                      />
                    </button>
                    <div className="px-1.5 py-1 text-[10px] leading-snug text-stone-500">
                      Photo by{" "}
                      <a
                        href={photo.photographerUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium text-stone-700 hover:text-violet-700"
                      >
                        {photo.photographer}
                      </a>{" "}
                      on{" "}
                      <a
                        href="https://unsplash.com"
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:text-violet-700"
                      >
                        Unsplash
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : searched !== null && !busy ? (
              <p className="flex items-start gap-1.5 text-[12px] text-stone-500">
                <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  No photos found for “{searched}”. Try another search.
                </span>
              </p>
            ) : (
              <p className="text-[12px] leading-snug text-stone-500">
                Search millions of free photos from Unsplash. Click a photo to
                place it on the canvas — photographer credit travels with it.
              </p>
            )}
          </>
        )}
        <p className="border-t border-stone-100 pt-2 text-[11px] leading-snug text-stone-400">
          Photos by Unsplash contributors — free to use under the Unsplash
          License, with attribution.
        </p>
      </div>
    </div>
  );
}
