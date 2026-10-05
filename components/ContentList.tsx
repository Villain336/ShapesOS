"use client";

// Marketr — content engine list (spec §5 flow 3).
// Pick a saved keyword → "Create brief" (SERP-informed brief, persisted as
// ContentItem status "brief") → open the item to draft / edit / publish.

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
// Phase 12 (embeds): `content.brief-v2` flag wires the v2 brief treatment.
import { useFlag } from "@/components/experiments/GrowthBookProvider";

export type ContentListItem = {
  id: string;
  status: string;
  seoScore: number | null;
  updatedAt: string;
  keyword: { phrase: string } | null;
};

export type SavedKeywordOption = {
  id: string;
  phrase: string;
  volume: number | null;
};

const inputCls =
  "rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

const STATUS_STYLES: Record<string, string> = {
  // Content workflow stages, not agent states: neutral, the label carries meaning.
  brief: "bg-canvas text-muted",
  draft: "bg-paper text-ink shadow-control",
  editing: "bg-paper text-ink shadow-outline",
  published: "bg-ink text-white",
};

export function statusPill(status: string) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        STATUS_STYLES[status] ?? "bg-canvas text-muted"
      }`}
    >
      {status}
    </span>
  );
}

export default function ContentList({
  projectId,
  keywords,
  items,
}: {
  projectId: string;
  keywords: SavedKeywordOption[];
  items: ContentListItem[];
}) {
  const router = useRouter();
  const [keywordId, setKeywordId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 12 (embeds): `content.brief-v2` flag — the v2 brief form treatment.
  const briefV2 = useFlag("content.brief-v2");

  async function onCreateBrief(e: FormEvent) {
    e.preventDefault();
    if (!keywordId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/content/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, keywordId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Brief creation failed.");
        return;
      }
      router.push(`/dashboard/projects/${projectId}/content/${json.contentItem.id}`);
    } catch {
      setError("Network error. Is the app server running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Create brief — v2 treatment when the `content.brief-v2` flag is on. */}
      <form
        onSubmit={onCreateBrief}
        className={`flex flex-col gap-3 rounded-lg bg-paper p-5 sm:flex-row sm:items-end ${
          briefV2 ? "shadow-outline" : "shadow-hairline"
        }`}
      >
        <div className="flex-1">
          <label
            htmlFor="keyword"
            className="mb-1 block text-xs font-semibold text-muted"
          >
            Saved keyword
            {briefV2 && (
              <span className="ml-1.5 rounded-full bg-ink px-1.5 py-0.5 text-2xs font-semibold text-white">
                v2
              </span>
            )}
          </label>
          <select
            id="keyword"
            value={keywordId}
            onChange={(e) => setKeywordId(e.target.value)}
            className={`w-full ${inputCls}`}
          >
            <option value="">Choose a saved keyword…</option>
            {keywords.map((k) => (
              <option key={k.id} value={k.id}>
                {k.phrase}
                {k.volume != null ? ` (${k.volume.toLocaleString()}/mo)` : ""}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={loading || !keywordId}
          className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg"
        >
          {loading ? "Building brief…" : "Create brief"}
        </button>
      </form>
      {error && <p className="text-sm text-failed-text">{error}</p>}
      {keywords.length === 0 && (
        <p className="text-sm text-muted">
          No saved keywords yet — run keyword research first, then come back
          to build a brief.
        </p>
      )}

      {/* Content items */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-muted">
          Content ({items.length})
        </h2>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-control p-8 text-center text-sm text-muted">
            No content yet. Create a brief from a saved keyword above.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  onClick={() =>
                    router.push(
                      `/dashboard/projects/${projectId}/content/${item.id}`,
                    )
                  }
                  className="flex w-full items-center justify-between gap-4 rounded-lg bg-paper px-5 py-3 text-left shadow-hairline hover:bg-hover-paper"
                >
                  <span className="flex items-center gap-3">
                    {statusPill(item.status)}
                    <span className="font-medium text-ink">
                      {item.keyword?.phrase ?? "Untitled"}
                    </span>
                  </span>
                  <span className="flex items-center gap-4 text-sm text-muted">
                    {item.seoScore != null && (
                      <span>
                        SEO <span className="text-ink">{Math.round(item.seoScore)}</span>/100
                      </span>
                    )}
                    <span>
                      {new Date(item.updatedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
