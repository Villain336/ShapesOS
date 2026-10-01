// Marketr — Phase 11 "Canvas": stock media panel (Unsplash | Pexels | Pixabay).
// Server-side search proxies; API keys never reach the browser. Honest empty
// states when unconfigured — never fake media. Clicking a result places it on
// canvas via the existing image-insert factory, with attribution/provenance
// in the element's `custom` bag so exports/credits stay traceable.
// The editor has no video element type, so Pexels/Pixabay videos are placed
// as their preview poster image, with the direct video file URL + duration in
// the custom bag for reference.
// PROVIDER BLOCKS: /* PROVIDER:unsplash */, /* PROVIDER:pexels */,
// /* PROVIDER:pixabay */ — other integrations extend via their own blocks.

"use client";

import { useEffect, useState } from "react";
import {
  Film,
  Image as ImageIcon,
  ImageOff,
  Loader2,
  Search,
  Settings,
} from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { fitBox, makeImage } from "../factory";
import type { StockPhoto } from "@/lib/design/unsplash";
import { btnGhost, btnPrimary, inputCls, panelTitle } from "../ui";

const MAX_DIM = 800;
const PAGE_SIZE = 12;

type StockTab = "unsplash" | "pexels" | "pixabay";

interface SearchPayload<T> {
  results?: T[];
  total?: number;
  error?: string;
  code?: string;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function useProviderStatus(path: string): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(path);
        const json = (await res.json()) as { configured?: boolean };
        if (live) setConfigured(res.ok && json.configured === true);
      } catch {
        if (live) setConfigured(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);
  return configured;
}

/** Shared "not configured" card pointing at Settings → Providers. */
function UnconfiguredCard({
  provider,
  keyHint,
}: {
  provider: string;
  keyHint: string;
}) {
  return (
    <div className="rounded-md border border-line bg-canvas px-3 py-3">
      <p className="text-[13px] font-medium text-ink">
        Stock media need a free {provider} API key
      </p>
      <p className="mt-1 text-[12px] leading-snug text-muted">
        {keyHint} then add it in Settings → Providers.
      </p>
      <a href="/dashboard/settings/providers" className={`${btnGhost} mt-2 inline-flex`}>
        <Settings className="h-4 w-4" />
        Open Providers
      </a>
    </div>
  );
}

function ErrorBox({ error }: { error: string }) {
  return (
    <p className="rounded-md border border-failed bg-failed-tint px-2.5 py-2 text-[12px] leading-snug text-failed-text">
      {error}
    </p>
  );
}

function EmptySearchNote({ searched, label }: { searched: string; label: string }) {
  return (
    <p className="flex items-start gap-1.5 text-[12px] text-muted">
      <ImageOff className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        No {label} found for “{searched}”. Try another search.
      </span>
    </p>
  );
}

/* PROVIDER:unsplash */
function UnsplashTab() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const configured = useProviderStatus("/api/studio/unsplash/status");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<StockPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = document?.pages.find((p) => p.id === activePageId);

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
        provider: "unsplash",
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
      const json = (await res.json()) as SearchPayload<StockPhoto>;
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
    <div className="space-y-3">
      {configured === null ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking stock photo setup…
        </p>
      ) : configured === false ? (
        <UnconfiguredCard
          provider="Unsplash"
          keyHint="Get one free at unsplash.com/developers,"
        />
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
          {error && <ErrorBox error={error} />}
          {results.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {results.map((photo) => (
                <div
                  key={photo.id}
                  className="overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
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
                  <div className="px-1.5 py-1 text-[10px] leading-snug text-muted">
                    Photo by{" "}
                    <a
                      href={photo.photographerUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium text-ink hover:underline"
                    >
                      {photo.photographer}
                    </a>{" "}
                    on{" "}
                    <a
                      href="https://unsplash.com"
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-ink"
                    >
                      Unsplash
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : searched !== null && !busy ? (
            <EmptySearchNote searched={searched} label="photos" />
          ) : (
            <p className="text-[12px] leading-snug text-muted">
              Search millions of free photos from Unsplash. Click a photo to
              place it on the canvas — photographer credit travels with it.
            </p>
          )}
        </>
      )}
      <p className="border-t border-line pt-2 text-[11px] leading-snug text-subtle">
        Photos by Unsplash contributors — free to use under the Unsplash
        License, with attribution.
      </p>
    </div>
  );
}
/* END */

/* PROVIDER:pexels */
interface PexelsPhotoShape {
  id: number;
  urls: { small: string; medium: string; large: string };
  width: number;
  height: number;
  alt: string | null;
  photographer: string;
  photographerUrl: string;
}

interface PexelsVideoShape {
  id: number;
  preview: string;
  width: number;
  height: number;
  duration: number;
  videoFile: string;
  videographer: string;
  videographerUrl: string;
}

type PexelsMediaType = "photo" | "video";

function PexelsTab() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const configured = useProviderStatus("/api/studio/pexels/status");
  const [mediaType, setMediaType] = useState<PexelsMediaType>("photo");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PexelsPhotoShape[]>([]);
  const [videos, setVideos] = useState<PexelsVideoShape[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = document?.pages.find((p) => p.id === activePageId);

  const placePhoto = (photo: PexelsPhotoShape) => {
    if (!page) return;
    const { width, height } = fitBox(photo.width || 800, photo.height || 600, MAX_DIM);
    addElement({
      ...makeImage({
        src: photo.urls.large,
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: (photo.alt ?? "Stock photo").slice(0, 40),
      }),
      custom: {
        provider: "pexels",
        pexelsId: photo.id,
        mediaType: "photo",
        photographer: photo.photographer,
        photographerUrl: photo.photographerUrl,
      },
    });
  };

  const placeVideo = (video: PexelsVideoShape) => {
    if (!page) return;
    // The editor has no video element type — place the preview poster; the
    // direct .mp4 link + duration ride along in the custom bag.
    const { width, height } = fitBox(video.width || 1280, video.height || 720, MAX_DIM);
    addElement({
      ...makeImage({
        src: video.preview,
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: `Video preview (${formatDuration(video.duration)})`.slice(0, 40),
      }),
      custom: {
        provider: "pexels",
        pexelsId: video.id,
        mediaType: "video",
        videoFile: video.videoFile,
        duration: video.duration,
        photographer: video.videographer,
        photographerUrl: video.videographerUrl,
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
        `/api/studio/pexels/search?${new URLSearchParams({
          q,
          per_page: String(PAGE_SIZE),
          type: mediaType,
        })}`,
      );
      const json = (await res.json()) as SearchPayload<PexelsPhotoShape | PexelsVideoShape>;
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const results = json.results ?? [];
      if (mediaType === "video") {
        setVideos(results as PexelsVideoShape[]);
        setPhotos([]);
      } else {
        setPhotos(results as PexelsPhotoShape[]);
        setVideos([]);
      }
      setSearched(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!page) return null;

  const mediaTabs: Array<{ key: PexelsMediaType; label: string; icon: React.ReactNode }> = [
    { key: "photo", label: "Photos", icon: <ImageIcon className="h-3.5 w-3.5" /> },
    { key: "video", label: "Videos", icon: <Film className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="space-y-3">
      {configured === null ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking Pexels setup…
        </p>
      ) : configured === false ? (
        <UnconfiguredCard
          provider="Pexels"
          keyHint="Get one free at pexels.com/api,"
        />
      ) : (
        <>
          <div className="flex gap-1.5">
            {mediaTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setMediaType(t.key)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium ${
                  mediaType === t.key
                    ? "border-ink text-ink"
                    : "border-line bg-paper text-muted hover:bg-hover-paper"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
              placeholder={mediaType === "video" ? "Search free videos…" : "Search free photos…"}
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
          {error && <ErrorBox error={error} />}
          {mediaType === "photo" ? (
            photos.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {photos.map((photo) => (
                  <div
                    key={photo.id}
                    className="overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
                  >
                    <button
                      onClick={() => placePhoto(photo)}
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
                    <div className="px-1.5 py-1 text-[10px] leading-snug text-muted">
                      Photo by{" "}
                      <a
                        href={photo.photographerUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-medium text-ink hover:underline"
                      >
                        {photo.photographer}
                      </a>{" "}
                      on{" "}
                      <a
                        href="https://www.pexels.com"
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:text-ink"
                      >
                        Pexels
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            ) : searched !== null && !busy ? (
              <EmptySearchNote searched={searched} label="photos" />
            ) : (
              <p className="text-[12px] leading-snug text-muted">
                Search Pexels’ curated library of free photos and videos. Click
                to place it on the canvas — credit travels with it.
              </p>
            )
          ) : videos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {videos.map((video) => (
                <div
                  key={video.id}
                  className="overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
                >
                  <button
                    onClick={() => placeVideo(video)}
                    title={`Place video preview (${formatDuration(video.duration)}) — the mp4 link is stored for reference`}
                    className="relative block w-full"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={video.preview}
                      alt="Video preview"
                      loading="lazy"
                      className="h-20 w-full object-cover"
                    />
                    <span className="absolute left-1 top-1 rounded bg-night/70 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
                      Video
                    </span>
                    <span className="absolute bottom-1 right-1 rounded bg-night/70 px-1 py-0.5 text-[10px] font-medium text-white">
                      {formatDuration(video.duration)}
                    </span>
                  </button>
                  <div className="px-1.5 py-1 text-[10px] leading-snug text-muted">
                    Video by{" "}
                    <a
                      href={video.videographerUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium text-ink hover:underline"
                    >
                      {video.videographer}
                    </a>{" "}
                    on{" "}
                    <a
                      href="https://www.pexels.com"
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-ink"
                    >
                      Pexels
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : searched !== null && !busy ? (
            <EmptySearchNote searched={searched} label="videos" />
          ) : (
            <p className="text-[12px] leading-snug text-muted">
              Videos are placed as preview posters — the canvas has no video
              element yet. The direct mp4 link and duration are stored on the
              element for reference.
            </p>
          )}
        </>
      )}
      {/* Required by the Pexels API terms: prominent "provided by Pexels" credit. */}
      <p className="border-t border-line pt-2 text-[11px] leading-snug text-subtle">
        Photos and videos provided by Pexels — free to use under the Pexels
        License, with photographer credit.
      </p>
    </div>
  );
}
/* END */

/* PROVIDER:pixabay */
interface PixabayAssetShape {
  id: number;
  thumbUrl: string;
  placeUrl: string;
  width: number;
  height: number;
  alt: string | null;
  author: string;
  pageUrl: string;
  mediaType: "image" | "video";
  duration?: number;
  videoFile?: string;
}

type PixabayMediaType = "image" | "video";
type PixabayImageType = "photo" | "illustration" | "vector";

function PixabayTab() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);

  const configured = useProviderStatus("/api/studio/pixabay/status");
  const [mediaType, setMediaType] = useState<PixabayMediaType>("image");
  const [imageType, setImageType] = useState<PixabayImageType>("photo");
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<PixabayAssetShape[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const page = document?.pages.find((p) => p.id === activePageId);

  const place = (asset: PixabayAssetShape) => {
    if (!page) return;
    // placeUrl is Marketr-served (/api/studio/pixabay/asset) — Pixabay CDN
    // URLs are never permanent design sources (no permanent hotlinking).
    const { width, height } = fitBox(asset.width || 800, asset.height || 600, MAX_DIM);
    const isVideo = asset.mediaType === "video";
    addElement({
      ...makeImage({
        src: asset.placeUrl,
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: ((isVideo ? `Video preview (${formatDuration(asset.duration ?? 0)})` : (asset.alt ?? "Stock image"))).slice(0, 40),
      }),
      custom: {
        provider: "pixabay",
        pixabayId: asset.id,
        mediaType: asset.mediaType,
        ...(isVideo ? { videoFile: asset.videoFile, duration: asset.duration } : {}),
        author: asset.author,
        pageUrl: asset.pageUrl,
        license: "Pixabay Content License",
        viaCache: true,
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
        `/api/studio/pixabay/search?${new URLSearchParams({
          q,
          per_page: String(PAGE_SIZE),
          type: mediaType,
          image_type: imageType,
        })}`,
      );
      const json = (await res.json()) as SearchPayload<PixabayAssetShape>;
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

  const mediaTabs: Array<{ key: PixabayMediaType; label: string; icon: React.ReactNode }> = [
    { key: "image", label: "Images", icon: <ImageIcon className="h-3.5 w-3.5" /> },
    { key: "video", label: "Videos", icon: <Film className="h-3.5 w-3.5" /> },
  ];

  return (
    <div className="space-y-3">
      {configured === null ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Checking Pixabay setup…
        </p>
      ) : configured === false ? (
        <UnconfiguredCard
          provider="Pixabay"
          keyHint="Get one free at pixabay.com (sign up for an API key),"
        />
      ) : (
        <>
          <div className="flex gap-1.5">
            {mediaTabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setMediaType(t.key)}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium ${
                  mediaType === t.key
                    ? "border-ink text-ink"
                    : "border-line bg-paper text-muted hover:bg-hover-paper"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
            {mediaType === "image" && (
              <select
                value={imageType}
                onChange={(e) => setImageType(e.target.value as PixabayImageType)}
                className={`${inputCls} w-28`}
                aria-label="Image type"
              >
                <option value="photo">Photos</option>
                <option value="illustration">Illustrations</option>
                <option value="vector">Vectors</option>
              </select>
            )}
          </div>
          <div className="flex gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
              placeholder={mediaType === "video" ? "Search free videos…" : "Search free images…"}
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
          {error && <ErrorBox error={error} />}
          {results.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {results.map((asset) => (
                <div
                  key={`${asset.mediaType}-${asset.id}`}
                  className="overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
                >
                  <button
                    onClick={() => place(asset)}
                    title={`Place ${asset.mediaType === "video" ? "video preview" : "image"}${
                      asset.alt ? ` — ${asset.alt}` : ""
                    }`}
                    className="relative block w-full"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={asset.thumbUrl}
                      alt={asset.alt ?? "Stock image"}
                      loading="lazy"
                      className="h-20 w-full object-cover"
                    />
                    {asset.mediaType === "video" && (
                      <>
                        <span className="absolute left-1 top-1 rounded bg-night/70 px-1 py-0.5 text-[9px] font-semibold uppercase text-white">
                          Video
                        </span>
                        <span className="absolute bottom-1 right-1 rounded bg-night/70 px-1 py-0.5 text-[10px] font-medium text-white">
                          {formatDuration(asset.duration ?? 0)}
                        </span>
                      </>
                    )}
                  </button>
                  <div className="px-1.5 py-1 text-[10px] leading-snug text-muted">
                    By{" "}
                    <a
                      href={asset.pageUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium text-ink hover:underline"
                    >
                      {asset.author}
                    </a>{" "}
                    via{" "}
                    <a
                      href="https://pixabay.com"
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-ink"
                    >
                      Pixabay
                    </a>
                  </div>
                </div>
              ))}
            </div>
          ) : searched !== null && !busy ? (
            <EmptySearchNote searched={searched} label={mediaType === "video" ? "videos" : "images"} />
          ) : (
            <p className="text-[12px] leading-snug text-muted">
              Search 6M+ free photos, illustrations, vectors, and videos. Placed
              assets are downloaded and served by Marketr (no permanent
              Pixabay hotlinking, per their API terms).
            </p>
          )}
          {/* Model/property-release disclaimer — Pixabay does not guarantee releases. */}
          <p className="flex items-start gap-1.5 rounded-md border border-line bg-needs-tint px-2.5 py-2 text-[11px] leading-snug text-ink">
            <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5" />
            <span>
              Pixabay doesn’t guarantee model or property releases for people,
              logos, or trademarks in an image — check rights before using an
              asset in a paid client campaign.
            </span>
          </p>
        </>
      )}
      <p className="border-t border-line pt-2 text-[11px] leading-snug text-subtle">
        Images and videos from Pixabay contributors — free to use under the
        Pixabay Content License.
      </p>
    </div>
  );
}
/* END */

const STOCK_TABS: Array<{ key: StockTab; label: string; icon: React.ReactNode }> = [
  { key: "unsplash", label: "Unsplash", icon: <ImageIcon className="h-3.5 w-3.5" /> },
  /* PROVIDER:pexels-tab */ { key: "pexels", label: "Pexels", icon: <ImageIcon className="h-3.5 w-3.5" /> }, /* END */
  /* PROVIDER:pixabay-tab */ { key: "pixabay", label: "Pixabay", icon: <ImageIcon className="h-3.5 w-3.5" /> }, /* END */
];

export function StockPhotosPanel() {
  const [tab, setTab] = useState<StockTab>("unsplash");

  return (
    <div>
      <div className={panelTitle}>Stock media</div>
      <div className="space-y-3 px-3 pb-4">
        <div className="flex gap-1.5" role="tablist" aria-label="Stock media provider">
          {STOCK_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] font-medium ${
                tab === t.key
                  ? "border-ink text-ink"
                  : "border-line bg-paper text-muted hover:bg-hover-paper"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
        {tab === "unsplash" && <UnsplashTab />}
        {/* PROVIDER:pexels-tab-render */ tab === "pexels" && <PexelsTab />} {/* END */}
        {/* PROVIDER:pixabay-tab-render */ tab === "pixabay" && <PixabayTab />} {/* END */}
      </div>
    </div>
  );
}
