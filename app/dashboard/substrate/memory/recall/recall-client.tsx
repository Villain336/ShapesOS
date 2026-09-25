// Marketr — Phase 8 G3: recall playground (SPEC-PHASE8.md §6).
// Client component: query → POST /api/substrate/memory/recall → ranked hits
// with provenance + freshness. Exact-match bypass surfaced as a badge.

"use client";

import { useState } from "react";
import { Badge } from "@/components/vault/shadcn/badge";
import { Input } from "@/components/vault/shadcn/input";
import { Button } from "@/components/vault/shadcn/button";
import { Search, Zap, Database, FileText, Layers } from "lucide-react";

interface Hit {
  store: string;
  refId: string;
  title: string;
  body: string;
  subtitle: string | null;
  observedAt: string;
  validFrom: string | null;
  validTo: string | null;
  episodeId: string | null;
  score: number;
  rerankScore: number | null;
  exactMatch: boolean;
  freshness: { bucket: string; label: string };
}

const STORE_ICON = { episode: FileText, fact: Database, learning: Layers } as const;

function bucketVariant(bucket: string): "secondary" | "outline" | "destructive" {
  if (bucket === "fresh") return "secondary";
  if (bucket === "aging") return "outline";
  return "destructive";
}

export default function RecallClient({ workspaceId }: { workspaceId: string }) {
  const [query, setQuery] = useState("");
  const [asOf, setAsOf] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/substrate/memory/recall?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: query.trim(), topK: 10, ...(asOf ? { asOf } : {}) }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setHits(data.hits ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHits([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="flex flex-wrap items-center gap-2">
        <div className="relative w-96">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What did we learn about cart recovery?"
            className="pl-9"
            aria-label="Recall query"
          />
        </div>
        <Input
          type="datetime-local"
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          className="w-56"
          aria-label="as of (temporal query)"
          title="Temporal query: recall what was true at this time"
        />
        <Button type="submit" disabled={loading || !query.trim()}>
          {loading ? "Recalling…" : "Recall"}
        </Button>
      </form>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">{error}</div>
      )}

      {hits.length === 0 && !loading && !error && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          Ask the memory anything. Exact IDs and error codes bypass the vector search — try an experiment ID.
        </div>
      )}

      <div className="grid gap-3">
        {hits.map((h, i) => {
          const Icon = STORE_ICON[h.store as keyof typeof STORE_ICON] ?? FileText;
          return (
            <article key={`${h.store}:${h.refId}`} className="relative rounded-lg border bg-card p-4">
              <div className="absolute right-3 top-3 flex gap-1.5">
                {h.exactMatch && (
                  <Badge variant="secondary">
                    <Zap className="mr-1 h-3 w-3" aria-hidden /> exact match
                  </Badge>
                )}
                <Badge variant="outline">{h.store}</Badge>
                <Badge variant={bucketVariant(h.freshness.bucket)} title={h.freshness.label}>
                  {h.freshness.bucket}
                </Badge>
              </div>
              <div className="flex items-start gap-3 pr-48">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 font-medium leading-snug">
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{h.title}</span>
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">{h.body}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    score {h.score.toFixed(3)}
                    {h.rerankScore != null ? ` · rerank ${h.rerankScore.toFixed(2)}` : null}
                    {" · "}{h.freshness.label}
                    {h.validFrom ? ` · valid ${h.validFrom.slice(0, 10)} → ${h.validTo ? h.validTo.slice(0, 10) : "now"}` : null}
                    {h.episodeId ? ` · episode ${h.episodeId.slice(0, 8)}…` : null}
                  </p>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
