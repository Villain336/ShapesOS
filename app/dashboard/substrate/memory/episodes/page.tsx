// Marketr — Phase 8 G3: episodes log (SPEC-PHASE8.md §6).
// Immutable event history: type/actor/since filters, badges top-right.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { ScrollText } from "lucide-react";
import { listEpisodes } from "@/lib/substrate/memory/write";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";

// Episode types and freshness buckets are analytic states -> neutral chips.
const chipNeutral =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";

const EPISODE_TYPES = ["run", "session", "sync", "agent_call"] as const;

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Episodes — Growth Memory — Marketr",
  description: "The immutable event history everything was distilled from.",
};

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
          className={`${inputCls} w-44`}
          aria-label="Filter by episode type"
        >
          <option value="">All types</option>
          {EPISODE_TYPES.map((t: string) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input name="actor" placeholder="Actor…" defaultValue={sp.actor ?? ""} className={`${inputCls} w-40`} />
        <button type="submit" className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40">
          Filter
        </button>
        <span className="ml-auto text-sm text-muted">{episodes.length} episodes</span>
      </form>

      {episodes.length === 0 && (
        <div className="rounded-lg border border-line bg-paper p-8 text-center text-sm text-muted">
          No episodes yet. Agent runs and archived experiments are recorded here.
        </div>
      )}

      <div className="grid gap-3">
        {episodes.map((e) => {
          const fresh = freshnessLabel(e.startedAt, "memory:episode", now);
          return (
            <article key={e.id} id={e.id} className="relative rounded-lg border border-line bg-paper p-4">
              <div className="absolute right-3 top-3 flex gap-1.5">
                <span className={chipNeutral}>{e.episodeType}</span>
                <span className={chipNeutral} title={fresh.label}>
                  {fresh.bucket}
                </span>
              </div>
              <div className="flex items-start gap-3 pr-44">
                <ScrollText className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm leading-relaxed">{e.summary}</p>
                  <p className="mt-2 text-xs text-muted">
                    {e.actor} · {fresh.label} · id <span className="font-mono">{e.id.slice(0, 12)}</span>…
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
