// Marketr — AI landing-page builder page (milestone 7).
// Describe the page (optionally grounded in a milestone-4 content brief) →
// preview in a sandboxed iframe → regenerate → save to a site → edit in the
// IDE.

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * A srcdoc iframe inherits this page's CSP (proxy.ts nonce policy), so the
 * generated page's own <script> tags (Tailwind CDN) would be blocked. Stamp
 * them with this page's nonce: the frame is sandboxed without
 * allow-same-origin (opaque origin), so its scripts can never reach the app.
 * Inline on* handlers in the preview stay blocked (script-src-attr 'none').
 */
function withPreviewNonce(html: string): string {
  if (typeof document === "undefined") return html;
  const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
  if (!nonce) return html;
  return html.replace(/<script\b/gi, `<script nonce="${nonce}"`);
}

interface Brief {
  id: string;
  label: string;
}

export default function SiteBuilder({
  projectId,
  briefs,
  llmLive,
  llmModel,
}: {
  projectId: string;
  briefs: Brief[];
  llmLive: boolean;
  llmModel: string | null;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [briefId, setBriefId] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isMockHtml, setIsMockHtml] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [siteName, setSiteName] = useState("");

  async function generate() {
    setError(null);
    if (!prompt.trim()) {
      setError("Describe the landing page first.");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/websites/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt: prompt.trim(),
          contentItemId: briefId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Generation failed");
        return;
      }
      setHtml(data.html);
      setIsMockHtml(!data.llm?.isLive);
      if (!siteName) {
        const words = prompt.trim().split(/\s+/).slice(0, 4).join(" ");
        setSiteName(words.length > 40 ? words.slice(0, 40) : words);
      }
    } finally {
      setGenerating(false);
    }
  }

  async function saveToSite() {
    if (!html) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          name: siteName.trim() || "Landing page",
          sourceType: "file",
          initialFiles: [{ path: "/index.html", content: html }],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not save site");
        return;
      }
      router.push(`/dashboard/projects/${projectId}/ide?siteId=${data.site.id}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`/dashboard/projects/${projectId}/sites`} className="text-sm text-muted hover:text-ink">
          ← Sites
        </Link>
        <h1 className="aos-heading mt-1">AI landing-page builder</h1>
        <p className="mt-1 text-sm text-muted">
          Describe the page — the AI writes the full HTML. Preview it, regenerate, then save to a site for editing in the IDE.
        </p>
      </div>

      <div className={`rounded-md px-3 py-2 text-sm ${llmLive ? "bg-paper text-muted shadow-hairline" : "bg-paper text-ink shadow-hairline"}`}>
        {llmLive ? (
          <>AI builder: <strong>live</strong> ({llmModel})</>
        ) : (
          <><strong>AI builder: mock mode</strong> — set <code>LLM_API_KEY</code> for real AI-generated pages. Mock pages are labeled.</>
        )}
      </div>

      <div className="rounded-lg bg-paper p-4 shadow-hairline">
        <label className="block text-sm text-muted">
          What should this landing page be for?
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="A landing page for Acme Plumbing's $49 drain-cleaning special in Greensboro — urgent, trustworthy, strong call to action…"
            className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
          />
        </label>
        {briefs.length > 0 && (
          <label className="mt-3 block text-sm text-muted">
            Ground it in a content brief <span className="text-xs text-muted">(optional — keyword → brief → landing page)</span>
            <select
              value={briefId}
              onChange={(e) => setBriefId(e.target.value)}
              className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-sm text-ink"
            >
              <option value="">No brief — just the prompt</option>
              {briefs.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => void generate()}
            disabled={generating}
            className="rounded-full bg-ink px-4 py-1.5 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg"
          >
            {generating ? "Generating…" : html ? "Regenerate" : "Generate page"}
          </button>
          {html && (
            <>
              <input
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="Site name"
                className="rounded-md border-[1.5px] border-control bg-paper px-2 py-1.5 text-sm text-ink"
              />
              <button
                onClick={() => void saveToSite()}
                disabled={saving}
                className="rounded-full bg-paper px-4 py-1.5 text-sm font-semibold text-ink shadow-outline aos-press disabled:bg-disabled disabled:text-disabled-fg disabled:shadow-none"
              >
                {saving ? "Saving…" : "Save to site → edit in IDE"}
              </button>
            </>
          )}
        </div>
      </div>

      {html && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">
              Preview {isMockHtml && <span className="ml-2 rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">mock</span>}
            </h2>
            <span className="text-xs text-muted">sandboxed iframe</span>
          </div>
          <iframe
            title="Landing page preview"
            srcDoc={withPreviewNonce(html)}
            sandbox="allow-scripts"
            className="h-[640px] w-full rounded-md border border-line bg-paper"
          />
        </div>
      )}
    </div>
  );
}
