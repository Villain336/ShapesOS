// Marketr — Phase 18 slice 5: UTM builder + Spotify Pixel reference template.
//
// utm_source=spotify is fixed. Spotify appends `spclid` to ad landing URLs
// (per spotify/ads-agentic-tools measurement docs), so the copy reminds
// users to keep query params intact through redirects.

"use client";

import { useState } from "react";
import { Link as LinkIcon, Check, Copy } from "lucide-react";
import {
  SpotifyGuidedError,
  buildSpotifyUtmUrl,
  SPOTIFY_PIXEL_TEMPLATE,
} from "@/lib/adplatforms/spotify/planning";

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const btnSecondarySm =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper";
const iconBtn =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper text-muted shadow-outline aos-press hover:bg-hover-paper hover:text-ink";
const cardCls = "rounded-lg bg-paper px-3 py-3 shadow-hairline";

export default function UtmBuilder() {
  const [baseUrl, setBaseUrl] = useState("");
  const [campaign, setCampaign] = useState("");
  const [medium, setMedium] = useState("audio");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedPixel, setCopiedPixel] = useState(false);

  function build() {
    setError(null);
    setUrl(null);
    try {
      setUrl(buildSpotifyUtmUrl({ baseUrl, campaign, medium, content: content.trim() || undefined }));
    } catch (e) {
      setError(e instanceof SpotifyGuidedError ? e.message : "Could not build the URL");
    }
  }

  async function copy(text: string, which: "url" | "pixel") {
    try {
      await navigator.clipboard.writeText(text);
      if (which === "url") {
        setCopiedUrl(true);
        setTimeout(() => setCopiedUrl(false), 1500);
      } else {
        setCopiedPixel(true);
        setTimeout(() => setCopiedPixel(false), 1500);
      }
    } catch {
      // Clipboard may be blocked; the text is still visible.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={`flex flex-col gap-2 ${cardCls}`}>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Landing page URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://example.com/offer"
              inputMode="url"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Campaign name (utm_campaign)
            <input
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              placeholder="e.g. q4-audio-test"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Medium (utm_medium)
            <input
              value={medium}
              onChange={(e) => setMedium(e.target.value)}
              placeholder="audio"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Content (utm_content, optional)
            <input
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="e.g. 30s-version-a"
              className={inputCls}
            />
          </label>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={build}
            className={btnPrimarySm}
          >
            <LinkIcon className="h-3.5 w-3.5" />
            Build tagged URL
          </button>
          <span className="text-xs text-subtle">utm_source=spotify is always set</span>
        </div>
        {error && (
          <p className="rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">{error}</p>
        )}
        {url && (
          <div className="flex items-start gap-1.5">
            <code className="flex-1 overflow-x-auto break-all rounded-md bg-night px-2.5 py-2 font-mono text-xs text-night-text">
              {url}
            </code>
            <button
              type="button"
              onClick={() => copy(url, "url")}
              title="Copy URL"
              className={iconBtn}
            >
              {copiedUrl ? <Check className="h-3.5 w-3.5 text-ink" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
        <p className="text-xs text-subtle">
          Spotify appends a <code className="font-mono">spclid</code> click ID to ad landing URLs. Keep your
          redirects query-string–preserving end to end, or attribution breaks.
        </p>
      </div>

      <div className={cardCls}>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">Spotify Pixel — base code</p>
          <button
            type="button"
            onClick={() => copy(SPOTIFY_PIXEL_TEMPLATE, "pixel")}
            className={btnSecondarySm}
          >
            {copiedPixel ? <Check className="h-3.5 w-3.5 text-ink" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedPixel ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="max-h-64 overflow-auto rounded-md bg-night px-3 py-2.5 font-mono text-xs leading-relaxed text-night-text">
          {SPOTIFY_PIXEL_TEMPLATE}
        </pre>
        <p className="mt-1.5 rounded-lg bg-paper px-3 py-2 text-sm text-muted shadow-hairline">
          Reference template only — the canonical snippet and your Pixel ID come from Ad Studio → the
          Events/Pixel section of your ad account. Replace{" "}
          <code className="rounded bg-canvas px-1 font-mono">PIXEL_ID</code> and fire conversion events on the action page, not on load.
        </p>
      </div>
    </div>
  );
}
