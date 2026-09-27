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
  "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent focus:outline-none";

const STATUS_STYLES: Record<string, string> = {
  brief: "border-sky-200 bg-sky-50/40 text-sky-700",
  draft: "border-violet-200 bg-violet-50/40 text-violet-700",
  editing: "border-amber-200 bg-amber-50/40 text-amber-700",
  published: "border-emerald-800 bg-emerald-50/40 text-emerald-700",
};

export function statusPill(status: string) {
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? "border-zinc-200 text-zinc-500"
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
        className={`flex flex-col gap-3 rounded-xl border p-5 sm:flex-row sm:items-end ${
          briefV2 ? "border-violet-200 bg-violet-50/40" : "border-zinc-200 bg-white/60"
        }`}
      >
        <div className="flex-1">
          <label
            htmlFor="keyword"
            className="mb-1 block text-xs font-medium uppercase tracking-widest text-zinc-500"
          >
            Saved keyword
            {briefV2 && (
              <span className="ml-1.5 rounded-full bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal text-white">
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
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          {loading ? "Building brief…" : "Create brief"}
        </button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {keywords.length === 0 && (
        <p className="text-sm text-zinc-500">
          No saved keywords yet — run keyword research first, then come back
          to build a brief.
        </p>
      )}

      {/* Content items */}
      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
          Content ({items.length})
        </h2>
        {items.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
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
                  className="flex w-full items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white/60 px-5 py-3 text-left hover:border-zinc-300"
                >
                  <span className="flex items-center gap-3">
                    {statusPill(item.status)}
                    <span className="font-medium text-zinc-900">
                      {item.keyword?.phrase ?? "Untitled"}
                    </span>
                  </span>
                  <span className="flex items-center gap-4 text-sm text-zinc-500">
                    {item.seoScore != null && (
                      <span>
                        SEO <span className="text-zinc-800">{Math.round(item.seoScore)}</span>/100
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
