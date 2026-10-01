// Marketr — Phase 11 "Canvas": 3D panel.
// Browse/search 3D assets as 2D stickers — no 3D viewport in v1.
// Two sources, both CC0-only:
//   - "Curated": Kenney models pre-rendered to transparent PNGs at 3
//     preset angles (scripts/render-3d-stills.mts). Click inserts the
//     selected angle's still as a normal Konva image node.
//   - "Search": live Poly Haven model search (keyless, server-proxied).
//     Results insert the Poly Haven preview render (256px, baked
//     background) as an image node — labeled honestly in the UI.
// The "Powered by Poly Haven" credit line is rendered in this panel per
// the Poly Haven ToS. Provenance (source, asset id, CC0 license) travels
// in the placed element's `custom` bag.

"use client";

import { useEffect, useState } from "react";
import { ImageOff, Loader2, Search } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { fitBox, makeImage } from "../factory";
import {
  CURATED_3D_ASSETS,
  POLY_HAVEN_CREDIT,
  POLY_HAVEN_URL,
  threeDProvenance,
  THREE_D_ANGLES,
  type CuratedModel3D,
  type PolyHavenAsset,
  type ThreeDAngle,
} from "@/lib/design/polyhaven";
import { btnGhost, btnPrimary, inputCls, panelTitle } from "../ui";

const MAX_DIM = 480;
const PAGE_SIZE = 12;

const ANGLE_LABELS: Record<ThreeDAngle, string> = {
  "three-quarter": "¾ view",
  front: "Front",
  side: "Side",
};

interface SearchPayload {
  results?: PolyHavenAsset[];
  total?: number;
  error?: string;
  code?: string;
}

export function ThreeDPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const [tab, setTab] = useState<"curated" | "search">("curated");
  const [angle, setAngle] = useState<ThreeDAngle>("three-quarter");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<PolyHavenAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = document?.pages.find((p) => p.id === activePageId);

  useEffect(() => {
    // Keep the panel's Poly Haven source-availability check uniform with
    // the keyed providers; Poly Haven needs no key so it is always live.
    void fetch("/api/studio/polyhaven/status").catch(() => undefined);
  }, []);

  const placeCurated = (model: CuratedModel3D) => {
    if (!page) return;
    const { width, height } = fitBox(640, 640, MAX_DIM);
    addElement({
      ...makeImage({
        src: model.png[angle],
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: model.name,
      }),
      custom: threeDProvenance(model.source, model.id, { angle }),
    });
  };

  const placeSearchResult = (asset: PolyHavenAsset) => {
    if (!page) return;
    const { width, height } = fitBox(256, 256, MAX_DIM);
    addElement({
      ...makeImage({
        src: asset.thumbnailUrl,
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: asset.name,
      }),
      custom: threeDProvenance("poly-haven", asset.id, { pageUrl: asset.pageUrl }),
    });
  };

  const search = async () => {
    const q = query.trim();
    if (q.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/studio/polyhaven/search?${new URLSearchParams({ q, limit: String(PAGE_SIZE) })}`,
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

  const categories = [...new Set(CURATED_3D_ASSETS.map((m) => m.category))];

  return (
    <div>
      <div className={panelTitle}>3D stickers</div>
      <div className="space-y-3 px-3 pb-4">
        {/* Tabs */}
        <div className="flex gap-1 rounded-md border border-line bg-canvas p-0.5">
          {(["curated", "search"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded px-2 py-1 text-[12px] font-medium ${
                tab === t ? "bg-paper text-ink shadow-outline" : "text-muted hover:text-ink"
              }`}
            >
              {t === "curated" ? "Curated" : "Poly Haven"}
            </button>
          ))}
        </div>

        {tab === "curated" ? (
          <>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-muted">Angle</p>
              <div className="flex gap-1">
                {THREE_D_ANGLES.map((a) => (
                  <button
                    key={a}
                    onClick={() => setAngle(a)}
                    className={`flex-1 rounded-md border px-2 py-1 text-[12px] font-medium ${
                      angle === a
                        ? "border-ink bg-ink text-white"
                        : "border-line bg-paper text-muted hover:bg-hover-paper hover:text-ink"
                    }`}
                  >
                    {ANGLE_LABELS[a]}
                  </button>
                ))}
              </div>
            </div>
            {categories.map((cat) => (
              <div key={cat}>
                <p className="mb-1.5 text-[11px] font-semibold text-muted">{cat}</p>
                <div className="grid grid-cols-3 gap-2">
                  {CURATED_3D_ASSETS.filter((m) => m.category === cat).map((model) => (
                    <button
                      key={model.id}
                      onClick={() => placeCurated(model)}
                      title={`Place ${model.name} (${ANGLE_LABELS[angle]})`}
                      className="group overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={model.png[angle]}
                        alt={model.name}
                        loading="lazy"
                        className="h-20 w-full bg-canvas object-contain transition-transform group-hover:scale-105"
                      />
                      <div className="px-1 py-1 text-[10px] font-medium leading-tight text-muted">
                        {model.name}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="text-[11px] leading-snug text-subtle">
              Starter props from Kenney (CC0, no attribution needed), rendered
              as transparent stickers. Click to place the {ANGLE_LABELS[angle].toLowerCase()} render.
            </p>
          </>
        ) : (
          <>
            <div className="flex gap-1.5">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void search();
                }}
                placeholder="Search 3D models…"
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
              <p className="rounded-md border border-failed bg-failed-tint px-2.5 py-2 text-[12px] leading-snug text-failed-text">
                {error}
              </p>
            )}
            {results.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {results.map((asset) => (
                  <div
                    key={asset.id}
                    className="overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
                  >
                    <button
                      onClick={() => placeSearchResult(asset)}
                      title={`Place ${asset.name}`}
                      className="block w-full"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={asset.thumbnailUrl}
                        alt={asset.name}
                        loading="lazy"
                        className="h-24 w-full object-cover"
                      />
                    </button>
                    <div className="px-1.5 py-1 text-[10px] leading-snug text-muted">
                      <span className="font-medium text-ink">{asset.name}</span>
                      <span className="text-subtle"> · CC0</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : searched !== null && !busy ? (
              <p className="flex items-start gap-1.5 text-[12px] text-muted">
                <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>No 3D models found for “{searched}”. Try another search.</span>
              </p>
            ) : (
              <p className="text-[12px] leading-snug text-muted">
                Search Poly Haven’s library of photorealistic 3D models (CC0).
                Click a result to place its preview render — curated
                transparent stickers live in the Curated tab.
              </p>
            )}
            <button
              onClick={() => setTab("curated")}
              className={`${btnGhost} w-full justify-center`}
            >
              Browse curated stickers
            </button>
          </>
        )}
        <p className="border-t border-line pt-2 text-[11px] leading-snug text-subtle">
          <a href={POLY_HAVEN_URL} target="_blank" rel="noreferrer noopener" className="hover:text-ink">
            {POLY_HAVEN_CREDIT}
          </a>
          {" "}· all 3D assets CC0, free for commercial use
        </p>
      </div>
    </div>
  );
}
