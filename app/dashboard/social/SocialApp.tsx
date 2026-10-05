// ShapesOS — Social workspace (Phase 4b: the social loop).
// Posts are ShapesOS records (text + images/video + UTM-tagged link) that
// publish through the Postiz sidecar after approval; engagement comes back
// per post per day and feeds Attribution. Tabs: Posts (dense table),
// Calendar (month grid with media thumbnails), Channels. ?post=<id> opens a
// post (Studio "Send to social" and the approval inbox link here).
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Link2, ListChecks, Loader2, Plus, RefreshCw, Search, Settings2 } from "lucide-react";
import { platformLabel } from "@/lib/social/platforms";
import { toast, toastError } from "@/lib/ui/feedback";
import { OpenInSheetsButton } from "@/components/office/OpenInSheetsButton";
import { Composer } from "./Composer";
import {
  api,
  btnPrimary,
  btnQuiet,
  btnSecondary,
  cardCls,
  fmtDateTime,
  fmtInt,
  inputCls,
  postWhen,
  StatusChip,
  Tag,
  tdCls,
  tdNum,
  thCls,
  thNum,
  Thumb,
  type Channel,
  type Post,
  type PostStatus,
  type ProviderMode,
} from "./ui";

type Tab = "posts" | "calendar" | "channels";

interface Loaded {
  mode: ProviderMode;
  channels: Channel[];
  maxUploadBytes: number;
  posts: Post[];
}

const DEFAULT_UPLOAD_BYTES = Math.floor(9.5 * 1024 * 1024);

/** Channels (+ provider mode) and posts; errors become toasts and empty data. */
async function fetchAll(): Promise<Loaded> {
  const [ch, ps] = await Promise.all([
    api<{ mode: ProviderMode; channels: Channel[]; maxUploadBytes: number }>("/api/social/channels").catch((e: unknown) => {
      toastError(e instanceof Error ? e.message : "Channels didn't load.");
      return { mode: "none" as const, channels: [], maxUploadBytes: DEFAULT_UPLOAD_BYTES };
    }),
    api<{ posts: Post[] }>("/api/social/posts").catch((e: unknown) => {
      toastError(e instanceof Error ? e.message : "Posts didn't load.");
      return { posts: [] as Post[] };
    }),
  ]);
  return { ...ch, posts: ps.posts };
}

const STATUS_FILTERS: Array<{ id: "" | PostStatus; label: string }> = [
  { id: "", label: "All statuses" },
  { id: "draft", label: "Drafts" },
  { id: "pending_approval", label: "Needs approval" },
  { id: "scheduled", label: "Scheduled" },
  { id: "published", label: "Published" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

export function SocialApp({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const search = useSearchParams();
  const [tab, setTab] = useState<Tab>("posts");
  const [mode, setMode] = useState<ProviderMode | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [maxUploadBytes, setMaxUploadBytes] = useState(DEFAULT_UPLOAD_BYTES);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | PostStatus>("");
  const [open, setOpen] = useState<{ post: Post | null } | null>(null);

  const apply = useCallback((d: Loaded) => {
    setMode(d.mode);
    setChannels(d.channels);
    setMaxUploadBytes(d.maxUploadBytes);
    setPosts(d.posts);
    setLoading(false);
  }, []);

  /** Reload after an action (event-driven). */
  const load = useCallback(async () => {
    apply(await fetchAll());
  }, [apply]);

  // Initial load; a deep link (?post=<id>) opens that post once the list is in.
  const deepLink = search.get("post");
  useEffect(() => {
    let live = true;
    void fetchAll().then(async (d) => {
      if (!live) return;
      apply(d);
      if (!deepLink) return;
      const hit = d.posts.find((p) => p.id === deepLink);
      const one = hit ? { post: hit } : await api<{ post: Post }>(`/api/social/posts/${encodeURIComponent(deepLink)}`).catch(() => null);
      if (live && one) setOpen({ post: one.post });
    });
    return () => {
      live = false;
    };
  }, [apply, deepLink]);

  const closeComposer = () => {
    setOpen(null);
    if (deepLink) router.replace("/dashboard/social");
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api<{ refresh: { published: number; failed: number }; ingest: { rows: number } }>("/api/social/sync", { method: "POST" });
      toast({
        title: "Synced",
        description: `${r.refresh.published} newly published, ${r.refresh.failed} failed, ${r.ingest.rows} engagement rows updated.`,
      });
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return posts.filter(
      (p) =>
        (!status || p.status === status || (status === "scheduled" && p.status === "approved")) &&
        (!needle || p.content.toLowerCase().includes(needle) || (p.utmCampaign ?? "").toLowerCase().includes(needle)),
    );
  }, [posts, q, status]);

  const pending = posts.filter((p) => p.status === "pending_approval").length;
  const tabs: Array<{ id: Tab; label: string; Icon: typeof Search; count?: number }> = [
    { id: "posts", label: "Posts", Icon: ListChecks, count: pending || undefined },
    { id: "calendar", label: "Calendar", Icon: CalendarDays },
    { id: "channels", label: "Channels", Icon: Link2, count: channels.length || undefined },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {mode === "mock" ? (
        <p className="rounded-md bg-paper px-3 py-2 text-[13px] text-muted shadow-hairline">
          Sample mode: Postiz isn&apos;t connected, so channels are sample channels, publishing is simulated and engagement is sample
          data. Set POSTIZ_URL and POSTIZ_API_KEY to publish for real.
        </p>
      ) : null}
      {mode === "none" ? (
        <div className={`${cardCls} flex flex-wrap items-center justify-between gap-3 p-4`}>
          <div>
            <p className="text-[15px] font-semibold text-ink">Connect Postiz to publish</p>
            <p className="text-[13px] text-muted">
              You can draft posts now. Set POSTIZ_URL and POSTIZ_API_KEY in Settings → Providers, then connect channels inside Postiz.
            </p>
          </div>
          <a href="/dashboard/settings/providers" className={btnSecondary}>
            <Settings2 className="h-4 w-4" /> Open providers
          </a>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line">
        <div className="flex gap-1" role="tablist" aria-label="Social views">
          {tabs.map(({ id, label, Icon, count }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[14px] font-semibold ${
                tab === id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
              {count ? <span className="rounded-full bg-control px-1.5 text-[12px] font-semibold text-ink">{count}</span> : null}
            </button>
          ))}
        </div>
        <div className="flex gap-2 pb-2">
          {canEdit && mode && mode !== "none" ? (
            <button type="button" className={btnSecondary} onClick={() => void sync()} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 aos-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? "Syncing" : "Sync"}
            </button>
          ) : null}
          {canEdit ? (
            <button type="button" className={btnPrimary} onClick={() => setOpen({ post: null })}>
              <Plus className="h-4 w-4" /> New post
            </button>
          ) : null}
        </div>
      </div>

      {tab === "posts" ? (
        <section className={cardCls}>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <select aria-label="Status" className={`${inputCls} !w-auto`} value={status} onChange={(e) => setStatus(e.target.value as "" | PostStatus)}>
              {STATUS_FILTERS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <input aria-label="Search posts" className={`${inputCls} !w-64 pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text or campaign" />
            </div>
            <span className="ml-auto text-[13px] text-muted">{filtered.length} posts</span>
            {filtered.length > 0 ? (
              <OpenInSheetsButton
                title="Content calendar"
                headers={["When", "Post", "Channels", "Status", "Campaign", "Impressions", "Clicks"]}
                rows={filtered.map((p) => [
                  postWhen(p),
                  p.content,
                  p.channels.map((c) => platformLabel(c.identifier)).join(", "),
                  p.status,
                  p.utmCampaign ?? "",
                  String(p.metrics?.impressions ?? ""),
                  String(p.metrics?.clicks ?? ""),
                ])}
                sourceRef="social:calendar"
                sheetName="Calendar"
                className={btnSecondary}
              />
            ) : null}
          </div>
          {loading ? (
            <p className="p-6 text-[13px] text-muted">Loading posts…</p>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-[15px] font-semibold text-ink">{posts.length ? "No posts match these filters" : "No posts yet"}</p>
              <p className="mt-1 text-[13px] text-muted">
                {posts.length ? "Clear the filters to see everything." : "Write one with New post, or send a design from Studio."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] text-left">
                <thead>
                  <tr className="border-b border-line">
                    <th className={thCls}>Post</th>
                    <th className={thCls}>Channels</th>
                    <th className={thCls}>Status</th>
                    <th className={thCls}>When</th>
                    <th className={thNum}>Impressions</th>
                    <th className={thNum}>Engagements</th>
                    <th className={thNum}>Clicks</th>
                    <th className={thCls}>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className={`${tdCls} max-w-[360px]`}>
                        <div className="flex items-start gap-2">
                          {p.media[0] ? <Thumb media={p.media[0]} /> : null}
                          <div className="min-w-0">
                            <div className="truncate font-medium">{p.content.trim() || (p.media.length ? `Media post (${p.media.length})` : "Untitled post")}</div>
                            <div className="flex flex-wrap gap-x-2 text-[12px] text-muted">
                              {p.media.length ? <span>{p.media.length} media</span> : null}
                              {p.utmCampaign ? <span className="font-mono">{p.utmCampaign}</span> : null}
                              {p.source === "studio" ? <span>From Studio</span> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div className="flex flex-wrap gap-1">
                          {p.channels.length ? p.channels.map((c) => <Tag key={c.id}>{platformLabel(c.identifier)}</Tag>) : <span className="text-muted">—</span>}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <StatusChip status={p.status} scheduledFor={p.scheduledFor} />
                      </td>
                      <td className={`${tdCls} whitespace-nowrap text-muted`}>{fmtDateTime(postWhen(p))}</td>
                      <td className={tdNum}>{p.metrics ? fmtInt(p.metrics.impressions) : "—"}</td>
                      <td className={tdNum}>{p.metrics ? fmtInt(p.metrics.likes + p.metrics.comments + p.metrics.shares) : "—"}</td>
                      <td className={tdNum}>
                        {p.metrics ? fmtInt(p.metrics.clicks) : "—"}
                        {p.metrics?.mock ? <span className="ml-1 text-[11px] text-muted">sample</span> : null}
                      </td>
                      <td className={`${tdCls} text-right`}>
                        <button type="button" className={btnQuiet} onClick={() => setOpen({ post: p })}>
                          {p.status === "pending_approval" && canEdit ? "Review" : canEdit && (p.status === "draft" || p.status === "failed") ? "Edit" : "Open"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : tab === "calendar" ? (
        <CalendarView posts={posts} onOpen={(p) => setOpen({ post: p })} />
      ) : (
        <section className={cardCls}>
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-semibold text-ink">Connected channels</h2>
            <p className="text-[13px] text-muted">
              {mode === "zernio"
                ? "Channels are your Zernio accounts — connect them in Settings → Connectors → Zernio."
                : "Channels connect inside Postiz (its own OAuth). ShapesOS reads them back to publish."}
            </p>
          </div>
          {channels.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-muted">
              {mode === "none"
                ? "Connect Postiz first."
                : mode === "zernio"
                  ? "No channels yet. Connect X, LinkedIn, Instagram and others in Settings → Connectors → Zernio."
                  : "No channels yet. Connect X, LinkedIn, Instagram and others in Postiz."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="border-b border-line">
                    <th className={thCls}>Channel</th>
                    <th className={thCls}>Platform</th>
                    <th className={thCls}>Provider id</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className={`${tdCls} font-medium`}>{c.name}</td>
                      <td className={tdCls}>
                        <Tag>{platformLabel(c.identifier)}</Tag>
                      </td>
                      <td className={`${tdCls} font-mono text-[12px] text-muted`}>{c.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {open ? (
        <Composer
          key={open.post?.id ?? "new"}
          post={open.post}
          channels={channels}
          mode={mode ?? "none"}
          maxUploadBytes={maxUploadBytes}
          canEdit={canEdit}
          onClose={closeComposer}
          onSaved={(p) => {
            closeComposer();
            void load();
            if (p && (p.status === "draft" || p.status === "failed")) setOpen({ post: p });
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar: month grid, posts on their publish/schedule/created day
// ---------------------------------------------------------------------------

function CalendarView({ posts, onOpen }: { posts: Post[]; onOpen: (p: Post) => void }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = [
    ...Array.from({ length: startOffset }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);

  const byDay = new Map<string, Post[]>();
  for (const p of posts) {
    if (p.status === "cancelled") continue;
    const d = new Date(postWhen(p));
    if (d.getFullYear() !== year || d.getMonth() !== month) continue;
    const k = String(d.getDate());
    byDay.set(k, [...(byDay.get(k) ?? []), p].sort((a, b) => postWhen(a).localeCompare(postWhen(b))));
  }
  const today = new Date();
  const label = cursor.toLocaleString(undefined, { month: "long", year: "numeric" });

  return (
    <section className={cardCls}>
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="flex items-center gap-1">
          <button type="button" className={btnQuiet} aria-label="Previous month" onClick={() => setCursor(new Date(year, month - 1, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button type="button" className={btnQuiet} aria-label="Next month" onClick={() => setCursor(new Date(year, month + 1, 1))}>
            <ChevronRight className="h-4 w-4" />
          </button>
          <h2 className="ml-1 text-[15px] font-semibold text-ink">{label}</h2>
        </div>
        <button type="button" className={btnQuiet} onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}>
          Today
        </button>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="border-b border-line px-2 py-1.5 text-xs font-semibold text-muted">
              {d}
            </div>
          ))}
          {cells.map((d, i) => {
            const items = d ? byDay.get(String(d.getDate())) ?? [] : [];
            const isToday = d && d.toDateString() === today.toDateString();
            return (
              <div key={i} className={`min-h-[112px] border-b border-r border-line p-1.5 ${d ? "" : "bg-canvas"}`}>
                {d ? (
                  <div className={`mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12px] font-semibold ${isToday ? "bg-ink text-paper" : "text-ink"}`}>
                    {d.getDate()}
                  </div>
                ) : null}
                <div className="flex flex-col gap-1">
                  {items.slice(0, 3).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onOpen(p)}
                      className="flex w-full items-center gap-1.5 rounded-sm bg-paper p-1 text-left shadow-hairline hover:bg-hover-paper"
                    >
                      {p.media[0] ? <Thumb media={p.media[0]} size={24} /> : null}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-ink">{p.content.trim() || "Media post"}</span>
                        <span className="flex items-center gap-1 text-[11px] text-muted">
                          {new Date(postWhen(p)).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          <StatusDot status={p.status} />
                        </span>
                      </span>
                    </button>
                  ))}
                  {items.length > 3 ? <span className="px-1 text-[11px] text-muted">+{items.length - 3} more</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Calendar marker. Status shapes are reserved for agent states
 *  (DESIGN.md): only "needs approval" keeps the needs-you triangle; a failed
 *  post reads "Failed" in failed-text; the rest are screen-reader text. */
function StatusDot({ status }: { status: PostStatus }) {
  const label = status.replace(/_/g, " ");
  if (status === "pending_approval") {
    return (
      <span
        className="aos-shape aos-shape--needs aos-shape--edged"
        style={{ ["--aos-shape-size" as string]: "8px" }}
        role="img"
        aria-label={label}
      />
    );
  }
  if (status === "failed") return <span className="text-[10px] font-semibold text-failed-text">Failed</span>;
  return <span className="sr-only">{label}</span>;
}
