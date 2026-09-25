// Marketr — Phase 8 G3: episodes log (SPEC-PHASE8.md §6).
// Immutable event history: type/actor/since filters, badges top-right.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { Badge } from "@/components/vault/shadcn/badge";
import { Input } from "@/components/vault/shadcn/input";
import { Button } from "@/components/vault/shadcn/button";
import { ScrollText } from "lucide-react";
import { listEpisodes } from "@/lib/substrate/memory/write";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";

const EPISODE_TYPES = ["run", "session", "sync", "agent_call"] as const;

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Episodes — Growth Memory — Marketr",
  description: "The immutable event history everything was distilled from.",
};

function bucketVariant(bucket: string): "secondary" | "outline" | "destructive" {
  if (bucket === "fresh") return "secondary";
  if (bucket === "aging") return "outline";
  return "destructive";
}

export default async function EpisodesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; actor?: string }>;
}) {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const sp = await searchParams;
  const type = sp.type && (EPISODE_TYPES as readonly string[]).includes(sp.type) ? sp.type : undefined;
  const actorFilter = sp.actor?.trim().toLowerCase() || "";
  // listEpisodes has no actor filter (episodes are query-light); filter the
  // small page client-side after the scoped fetch.
  const episodes = (await listEpisodes(workspace.id, {
    type: type as (typeof EPISODE_TYPES)[number] | undefined,
    limit: 60,
  })).filter((e) => !actorFilter || e.actor.toLowerCase().includes(actorFilter));
  const now = new Date();

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-center gap-2">
        <select
          name="type"
          defaultValue={type ?? ""}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          aria-label="Filter by episode type"
        >
          <option value="">All types</option>
          {EPISODE_TYPES.map((t: string) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Input name="actor" placeholder="Actor…" defaultValue={sp.actor ?? ""} className="w-40" />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">{episodes.length} episodes</span>
      </form>

      {episodes.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No episodes yet. Agent runs and archived experiments are recorded here.
        </div>
      )}

      <div className="grid gap-3">
        {episodes.map((e) => {
          const fresh = freshnessLabel(e.startedAt, "memory:episode", now);
          return (
            <article key={e.id} id={e.id} className="relative rounded-lg border bg-card p-4">
              <div className="absolute right-3 top-3 flex gap-1.5">
                <Badge variant="outline">{e.episodeType}</Badge>
                <Badge variant={bucketVariant(fresh.bucket)} title={fresh.label}>
                  {fresh.bucket}
                </Badge>
              </div>
              <div className="flex items-start gap-3 pr-44">
                <ScrollText className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm leading-relaxed">{e.summary}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {e.actor} · {fresh.label} · id {e.id.slice(0, 12)}…
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
