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

  const inputCls =
    "rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-[12px] text-stone-600">
            Landing page URL
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://example.com/offer"
              inputMode="url"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-stone-600">
            Campaign name (utm_campaign)
            <input
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              placeholder="e.g. q4-audio-test"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-stone-600">
            Medium (utm_medium)
            <input
              value={medium}
              onChange={(e) => setMedium(e.target.value)}
              placeholder="audio"
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-stone-600">
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
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
          >
            <LinkIcon className="h-3.5 w-3.5" />
            Build tagged URL
          </button>
          <span className="text-[11px] text-stone-400">utm_source=spotify is always set</span>
        </div>
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
        )}
        {url && (
          <div className="flex items-start gap-1.5">
            <code className="flex-1 overflow-x-auto break-all rounded-md bg-stone-900 px-2.5 py-2 font-mono text-[11px] text-stone-100">
              {url}
            </code>
            <button
              type="button"
              onClick={() => copy(url, "url")}
              title="Copy URL"
              className="rounded-md border border-stone-300 px-2 py-2 text-stone-500 hover:bg-stone-50"
            >
              {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
          </div>
        )}
        <p className="text-[11px] text-stone-400">
          Spotify appends a <code className="font-mono">spclid</code> click ID to ad landing URLs. Keep your
          redirects query-string–preserving end to end, or attribution breaks.
        </p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white px-3 py-3">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[13px] font-medium text-stone-900">Spotify Pixel — base code</p>
          <button
            type="button"
            onClick={() => copy(SPOTIFY_PIXEL_TEMPLATE, "pixel")}
            className="inline-flex items-center gap-1 rounded-md border border-stone-300 px-2 py-1 text-[11px] font-medium text-stone-600 hover:bg-stone-50"
          >
            {copiedPixel ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedPixel ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="max-h-64 overflow-auto rounded-md bg-stone-900 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-stone-100">
          {SPOTIFY_PIXEL_TEMPLATE}
        </pre>
        <p className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          Reference template only — the canonical snippet and your Pixel ID come from Ad Studio → the
          Events/Pixel section of your ad account. Replace{" "}
          <code className="font-mono">PIXEL_ID</code> and fire conversion events on the action page, not on load.
        </p>
      </div>
    </div>
  );
}
