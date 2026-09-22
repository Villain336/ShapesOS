// Marketr — social studio (milestone 20).
// Client island: Calendar, Composer, Posts, Channels, Settings tabs.
// Motion language (better-ui / emil-design-eng): press scale 0.96, named
// transitions with cubic-bezier(0.2,0,0,1), 150ms tab fades, Lucide-only.

"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  Check,
  Clock,
  Link2,
  Pencil,
  PenLine,
  Plug,
  RefreshCw,
  Send,
  Settings2,
  Share2,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  ALL_SERVICES,
  CHANNEL_DEFS,
  bucketPostsByDay,
  type SocialContent,
  type SocialService,
} from "@/lib/social/channels";

export interface StudioChannel {
  id: string;
  bufferProfileId: string;
  service: string;
  handle: string | null;
  enabled: boolean;
}

export interface StudioPost {
  id: string;
  content: SocialContent;
  services: string[];
  serviceLabels: string[];
  scheduledFor: string | null;
  status: string;
  bufferUpdateIds: unknown;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  stats: unknown;
  statsSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  projectId: string;
  channels: StudioChannel[];
  posts: StudioPost[];
  connected: boolean;
  tokenHint: string | null;
  canEdit: boolean;
}

type Tab = "calendar" | "composer" | "posts" | "channels" | "settings";

const STATUS_STYLE: Record<string, string> = {
  draft: "bg-zinc-800 text-zinc-300",
  scheduled: "bg-blue-950 text-blue-300",
  sent: "bg-emerald-950 text-emerald-300",
  failed: "bg-red-950 text-red-300",
  cancelled: "bg-zinc-900 text-zinc-500",
};

function serviceLabel(s: string): string {
  return CHANNEL_DEFS[s as SocialService]?.label ?? s;
}

async function api(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) ?? `Request failed (${res.status}).`);
  return json;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function SocialStudio(props: Props) {
  const [tab, setTab] = useState<Tab>("calendar");
  const [channels, setChannels] = useState(props.channels);
  const [posts, setPosts] = useState(props.posts);
  const [connected, setConnected] = useState(props.connected);
  const [tokenHint, setTokenHint] = useState(props.tokenHint);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);

  const enabledChannels = useMemo(() => channels.filter((c) => c.enabled), [channels]);
  const selectedPost = posts.find((p) => p.id === selectedPostId) ?? null;

  function showNotice(kind: "ok" | "err", text: string) {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 6000);
  }

  async function refreshPosts() {
    const json = await api(`/api/social/posts?projectId=${props.projectId}`, "GET");
    setPosts((json.posts as StudioPost[]) ?? []);
  }

  async function refreshChannels() {
    const json = await api(`/api/social/channels?projectId=${props.projectId}`, "GET");
    setChannels((json.channels as StudioChannel[]) ?? []);
  }

  // -- calendar state -------------------------------------------------------
  const now = new Date();
  const [calYear, setCalYear] = useState(now.getFullYear());
  const [calMonth, setCalMonth] = useState(now.getMonth() + 1);
  const [calMode, setCalMode] = useState<"month" | "week">("month");
  const [calFilter, setCalFilter] = useState<string>("all");

  const calPosts = useMemo(() => {
    const filtered = calFilter === "all" ? posts : posts.filter((p) => p.services.includes(calFilter));
    return filtered.map((p) => ({
      id: p.id,
      scheduledFor: p.scheduledFor,
      services: p.services as SocialService[],
      status: p.status,
    }));
  }, [posts, calFilter]);
  const bucketed = useMemo(() => bucketPostsByDay(calPosts, calYear, calMonth), [calPosts, calYear, calMonth]);

  function shiftMonth(delta: number) {
    let y = calYear;
    let m = calMonth + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    setCalYear(y);
    setCalMonth(m);
  }

  const monthName = new Date(calYear, calMonth - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const firstWeekday = new Date(calYear, calMonth - 1, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const cells: Array<number | null> = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  // -- composer state --------------------------------------------------------
  const [compServices, setCompServices] = useState<string[]>([]);
  const [compText, setCompText] = useState("");
  const [compOverrides, setCompOverrides] = useState<Record<string, string>>({});
  const [compImages, setCompImages] = useState("");
  const [compVideos, setCompVideos] = useState("");
  const [compLink, setCompLink] = useState("");
  const [compUtmSource, setCompUtmSource] = useState("");
  const [compUtmMedium, setCompUtmMedium] = useState("social");
  const [compUtmCampaign, setCompUtmCampaign] = useState("");
  const [compWhen, setCompWhen] = useState("");
  const [overrideOpen, setOverrideOpen] = useState<string | null>(null);

  function toggleService(s: string) {
    setCompServices((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  function buildContent(): SocialContent {
    const perChannel: SocialContent["perChannel"] = {};
    for (const s of compServices) {
      const t = compOverrides[s];
      if (t !== undefined && t !== "") perChannel[s as SocialService] = { text: t };
    }
    const media = [
      ...compImages.split("\n").map((u) => u.trim()).filter(Boolean).map((url) => ({ type: "image" as const, url })),
      ...compVideos.split("\n").map((u) => u.trim()).filter(Boolean).map((url) => ({ type: "video" as const, url })),
    ];
    return {
      text: compText,
      perChannel,
      media,
      link: compLink.trim() || undefined,
      utm: {
        ...(compUtmSource.trim() ? { source: compUtmSource.trim() } : {}),
        ...(compUtmMedium.trim() ? { medium: compUtmMedium.trim() } : {}),
        ...(compUtmCampaign.trim() ? { campaign: compUtmCampaign.trim() } : {}),
      },
    };
  }

  /** Worst-case char count across selected channels (with overrides applied). */
  const compLimits = useMemo(() => {
    return compServices.map((s) => {
      const def = CHANNEL_DEFS[s as SocialService];
      const text = compOverrides[s] !== undefined && compOverrides[s] !== "" ? compOverrides[s] : compText;
      return { service: s, label: def?.label ?? s, max: def?.maxLength ?? 0, len: text.trim().length };
    });
  }, [compServices, compText, compOverrides]);
  const compOverLimit = compLimits.some((l) => l.len > l.max);

  async function composerSave(asDraftOnly: boolean) {
    if (compServices.length === 0) return showNotice("err", "Select at least one channel.");
    if (compOverLimit) return showNotice("err", "One or more channels exceed their character limit.");
    setBusy("composer");
    try {
      const json = await api("/api/social/posts", "POST", {
        projectId: props.projectId,
        content: buildContent(),
        services: compServices,
      });
      const post = json.post as { id: string };
      if (!asDraftOnly && compWhen) {
        await api(`/api/social/posts/${post.id}/schedule`, "POST", {
          projectId: props.projectId,
          scheduledFor: new Date(compWhen).toISOString(),
        });
        showNotice("ok", "Post scheduled.");
      } else {
        showNotice("ok", "Draft saved.");
      }
      setCompServices([]); setCompText(""); setCompOverrides({}); setCompImages("");
      setCompVideos(""); setCompLink(""); setCompWhen("");
      await refreshPosts();
      setTab("posts");
    } catch (err) {
      showNotice("err", err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  }

  // -- post actions ----------------------------------------------------------
  async function postAction(id: string, action: "schedule" | "publish-now" | "cancel" | "delete" | "analytics", extra?: Record<string, unknown>) {
    setBusy(`${action}:${id}`);
    try {
      const base = `/api/social/posts/${id}`;
      if (action === "schedule") {
        await api(`${base}/schedule`, "POST", { projectId: props.projectId, ...(extra ?? {}) });
        showNotice("ok", "Post scheduled.");
      } else if (action === "publish-now") {
        await api(`${base}/publish-now`, "POST", { projectId: props.projectId });
        showNotice("ok", "Published via Buffer.");
      } else if (action === "cancel") {
        await api(`${base}/cancel`, "POST", { projectId: props.projectId });
        showNotice("ok", "Post cancelled.");
      } else if (action === "delete") {
        await api(`${base}?projectId=${props.projectId}`, "DELETE");
        showNotice("ok", "Post deleted.");
        if (selectedPostId === id) setSelectedPostId(null);
      } else if (action === "analytics") {
        await api(`${base}/analytics`, "POST", { projectId: props.projectId });
        showNotice("ok", "Analytics refreshed.");
      }
      await refreshPosts();
    } catch (err) {
      showNotice("err", err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  // -- settings actions ------------------------------------------------------
  const [tokenInput, setTokenInput] = useState("");
  async function saveToken() {
    if (!tokenInput.trim()) return showNotice("err", "Paste your Buffer access token first.");
    setBusy("token");
    try {
      const json = await api("/api/social/settings", "POST", { projectId: props.projectId, token: tokenInput });
      setConnected(true);
      setTokenHint((json.hint as string) ?? null);
      setTokenInput("");
      showNotice("ok", "Buffer connected.");
    } catch (err) {
      showNotice("err", err instanceof Error ? err.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  }
  async function revokeToken() {
    setBusy("token");
    try {
      await api(`/api/social/settings?projectId=${props.projectId}`, "DELETE");
      setConnected(false);
      setTokenHint(null);
      showNotice("ok", "Buffer token revoked.");
    } catch (err) {
      showNotice("err", err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setBusy(null);
    }
  }

  async function syncChannelsNow() {
    setBusy("sync");
    try {
      const json = await api("/api/social/channels", "POST", { projectId: props.projectId });
      setChannels((json.channels as StudioChannel[]) ?? []);
      showNotice("ok", "Channels synced from Buffer.");
    } catch (err) {
      showNotice("err", err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setBusy(null);
    }
  }

  async function toggleChannel(id: string, enabled: boolean) {
    setBusy(`channel:${id}`);
    try {
      await api(`/api/social/channels/${id}?projectId=${props.projectId}`, "PATCH", { enabled });
      setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, enabled } : c)));
    } catch (err) {
      showNotice("err", err instanceof Error ? err.message : "Toggle failed.");
    } finally {
      setBusy(null);
    }
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "calendar", label: "Calendar", icon: <CalendarDays className="h-4 w-4" /> },
    { id: "composer", label: "Composer", icon: <PenLine className="h-4 w-4" /> },
    { id: "posts", label: "Posts", icon: <Send className="h-4 w-4" /> },
    { id: "channels", label: "Channels", icon: <Share2 className="h-4 w-4" /> },
    { id: "settings", label: "Settings", icon: <Settings2 className="h-4 w-4" /> },
  ];

  const press = "transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96]";
  const fade = "transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)]";

  return (
    <div>
      {notice && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${fade} ${
            notice.kind === "ok"
              ? "border-emerald-900 bg-emerald-950/40 text-emerald-300"
              : "border-red-900 bg-red-950/40 text-red-300"
          }`}
        >
          {notice.kind === "ok" ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          {notice.text}
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 flex flex-wrap gap-1 rounded-xl border border-zinc-800 bg-zinc-950 p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${press} ${fade} ${
              tab === t.id ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* CALENDAR */}
      {tab === "calendar" && (
        <div className={fade}>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => shiftMonth(-1)} className={`rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 ${press}`}>←</button>
              <span className="min-w-40 text-center text-sm font-semibold text-zinc-100">{monthName}</span>
              <button onClick={() => shiftMonth(1)} className={`rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-300 ${press}`}>→</button>
            </div>
            <div className="flex gap-1 rounded-lg border border-zinc-800 p-0.5">
              {(["month", "week"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setCalMode(m)}
                  className={`rounded-md px-3 py-1 text-xs font-medium capitalize ${press} ${fade} ${calMode === m ? "bg-zinc-800 text-zinc-100" : "text-zinc-500"}`}
                >
                  {m}
                </button>
              ))}
            </div>
            <select
              value={calFilter}
              onChange={(e) => setCalFilter(e.target.value)}
              className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-200"
            >
              <option value="all">All channels</option>
              {ALL_SERVICES.map((s) => (
                <option key={s} value={s}>{serviceLabel(s)}</option>
              ))}
            </select>
          </div>

          {calMode === "month" ? (
            <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-zinc-800 bg-zinc-800">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="bg-zinc-950 px-2 py-2 text-center text-xs font-medium text-zinc-500">{d}</div>
              ))}
              {cells.map((day, i) => {
                const dayPosts = day ? bucketed.days.get(day) ?? [] : [];
                return (
                  <div key={i} className="min-h-24 bg-zinc-950 p-1.5">
                    {day && (
                      <>
                        <div className="mb-1 text-xs font-medium text-zinc-500">{day}</div>
                        <div className="flex flex-col gap-1">
                          {dayPosts.slice(0, 3).map((p) => (
                            <button
                              key={p.id}
                              onClick={() => { setSelectedPostId(p.id); setTab("posts"); }}
                              className={`truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium ${press} ${STATUS_STYLE[p.status] ?? STATUS_STYLE.draft}`}
                              title={p.services.map(serviceLabel).join(", ")}
                            >
                              {p.services.map(serviceLabel).join(" · ").slice(0, 18)}
                            </button>
                          ))}
                          {dayPosts.length > 3 && (
                            <div className="text-[11px] text-zinc-500">+{dayPosts.length - 3} more</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(calYear, calMonth - 1, 1);
                d.setDate(d.getDate() + i);
                const dayPosts = bucketed.days.get(d.getDate()) ?? [];
                return (
                  <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                    <div className="mb-2 text-sm font-semibold text-zinc-200">
                      {d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                    </div>
                    {dayPosts.length === 0 ? (
                      <div className="text-xs text-zinc-600">Nothing scheduled</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {dayPosts.map((p) => (
                          <button
                            key={p.id}
                            onClick={() => { setSelectedPostId(p.id); setTab("posts"); }}
                            className="flex items-center justify-between rounded-lg border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 hover:border-zinc-600"
                          >
                            <span className="truncate">{p.services.map(serviceLabel).join(" · ")}</span>
                            <span className={`ml-2 shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status] ?? STATUS_STYLE.draft}`}>
                              {p.status}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-zinc-600">Week view shows the first 7 days of the selected month.</p>
            </div>
          )}
        </div>
      )}

      {/* COMPOSER */}
      {tab === "composer" && (
        <div className={`${fade} grid gap-6 lg:grid-cols-[1fr_320px]`}>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">New post</h3>
            {!props.canEdit && <p className="mb-3 text-xs text-zinc-500">Viewer role — you can preview but not publish.</p>}

            <div className="mb-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">Channels</div>
              {enabledChannels.length === 0 ? (
                <p className="text-sm text-zinc-500">No channels connected yet — sync them in the Channels tab.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {enabledChannels.map((c) => (
                    <button
                      key={c.bufferProfileId}
                      onClick={() => toggleService(c.service)}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${press} ${fade} ${
                        compServices.includes(c.service)
                          ? "border-blue-700 bg-blue-950/40 text-blue-200"
                          : "border-zinc-800 text-zinc-400 hover:border-zinc-600"
                      }`}
                    >
                      {serviceLabel(c.service)}{c.handle ? ` · ${c.handle}` : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mb-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-widest text-zinc-500">Text</span>
                {compLimits.length > 0 && (
                  <span className="text-xs text-zinc-500">
                    {compLimits.map((l) => (
                      <span key={l.service} className={l.len > l.max ? "text-red-400" : ""}>
                        {l.label.split(" ")[0]} {l.len}/{l.max}{"  "}
                      </span>
                    ))}
                  </span>
                )}
              </div>
              <textarea
                value={compText}
                onChange={(e) => setCompText(e.target.value)}
                rows={5}
                placeholder="What should this post say?"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
            </div>

            {compServices.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">Per-channel overrides</div>
                <div className="flex flex-col gap-2">
                  {compServices.map((s) => (
                    <div key={s} className="rounded-lg border border-zinc-800">
                      <button
                        onClick={() => setOverrideOpen(overrideOpen === s ? null : s)}
                        className="flex w-full items-center justify-between px-3 py-2 text-sm text-zinc-300"
                      >
                        {serviceLabel(s)}
                        <span className="text-xs text-zinc-500">{compOverrides[s] ? "custom" : "uses shared text"}</span>
                      </button>
                      {overrideOpen === s && (
                        <div className="border-t border-zinc-800 p-3">
                          <textarea
                            value={compOverrides[s] ?? ""}
                            onChange={(e) => setCompOverrides((prev) => ({ ...prev, [s]: e.target.value }))}
                            rows={3}
                            placeholder={`Custom text for ${serviceLabel(s)} (blank = shared text)`}
                            className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-widest text-zinc-500">Image URLs (one per line)</div>
                <textarea value={compImages} onChange={(e) => setCompImages(e.target.value)} rows={2} placeholder="https://…" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600" />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-widest text-zinc-500">Video URLs (one per line)</div>
                <textarea value={compVideos} onChange={(e) => setCompVideos(e.target.value)} rows={2} placeholder="https://…" className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600" />
              </div>
            </div>

            <div className="mb-4">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-zinc-500">
                <Link2 className="h-3.5 w-3.5" /> Link + UTM
              </div>
              <input value={compLink} onChange={(e) => setCompLink(e.target.value)} placeholder="https://example.com/article" className="mb-2 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600" />
              <div className="grid grid-cols-3 gap-2">
                <input value={compUtmSource} onChange={(e) => setCompUtmSource(e.target.value)} placeholder="utm_source" className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600" />
                <input value={compUtmMedium} onChange={(e) => setCompUtmMedium(e.target.value)} placeholder="utm_medium" className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600" />
                <input value={compUtmCampaign} onChange={(e) => setCompUtmCampaign(e.target.value)} placeholder="utm_campaign" className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600" />
              </div>
            </div>

            <div className="mb-5">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-zinc-500">
                <Clock className="h-3.5 w-3.5" /> Schedule (optional)
              </div>
              <input type="datetime-local" value={compWhen} onChange={(e) => setCompWhen(e.target.value)} className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100" />
            </div>

            {props.canEdit && (
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => composerSave(true)}
                  disabled={busy === "composer"}
                  className={`flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 ${press}`}
                >
                  <Pencil className="h-4 w-4" /> Save draft
                </button>
                <button
                  onClick={() => composerSave(false)}
                  disabled={busy === "composer" || !compWhen}
                  className={`flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${press}`}
                  title={compWhen ? "Save and schedule" : "Pick a schedule time first"}
                >
                  <Clock className="h-4 w-4" /> {busy === "composer" ? "Saving…" : "Save & schedule"}
                </button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
            <h3 className="mb-3 text-sm font-semibold text-zinc-100">Channel rules</h3>
            <div className="flex flex-col gap-3">
              {ALL_SERVICES.map((s) => {
                const def = CHANNEL_DEFS[s];
                return (
                  <div key={s} className="text-xs">
                    <div className="font-medium text-zinc-200">{def.label}</div>
                    <div className="text-zinc-500">{def.maxLength.toLocaleString()} chars · {def.mediaHint}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* POSTS */}
      {tab === "posts" && (
        <div className={`${fade} grid gap-6 lg:grid-cols-[1fr_360px]`}>
          <div className="flex flex-col gap-3">
            {posts.length === 0 && (
              <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
                No posts yet. Compose one to get started.
              </p>
            )}
            {posts.map((p) => (
              <div
                key={p.id}
                className={`rounded-xl border bg-zinc-950 p-4 ${selectedPostId === p.id ? "border-blue-800" : "border-zinc-800"}`}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status] ?? STATUS_STYLE.draft}`}>
                    {p.status}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {p.scheduledFor ? fmtDateTime(p.scheduledFor) : "unscheduled"}
                  </span>
                </div>
                <p className="mb-2 line-clamp-3 text-sm text-zinc-200">{p.content.text || <span className="text-zinc-600">(no shared text)</span>}</p>
                <div className="mb-3 text-xs text-zinc-500">{p.serviceLabels.join(" · ")}</div>
                {p.error && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{p.error}</span>
                  </div>
                )}
                {p.nextAttemptAt && p.status === "scheduled" && (
                  <div className="mb-3 text-xs text-amber-300">Retrying at {fmtDateTime(p.nextAttemptAt)} (attempt {p.attempts + 1})</div>
                )}
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => setSelectedPostId(selectedPostId === p.id ? null : p.id)} className={`rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 ${press}`}>
                    Details
                  </button>
                  {props.canEdit && p.status === "draft" && (
                    <>
                      <button
                        onClick={() => {
                          const when = window.prompt("Schedule for (YYYY-MM-DDTHH:MM):", new Date(Date.now() + 3600000).toISOString().slice(0, 16));
                          if (when) postAction(p.id, "schedule", { scheduledFor: new Date(when).toISOString() });
                        }}
                        className={`flex items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 ${press}`}
                      >
                        <Clock className="h-3.5 w-3.5" /> Schedule
                      </button>
                      <button onClick={() => postAction(p.id, "publish-now")} disabled={busy === `publish-now:${p.id}`} className={`flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white ${press}`}>
                        <Send className="h-3.5 w-3.5" /> Publish now
                      </button>
                      <button onClick={() => { if (window.confirm("Delete this draft?")) postAction(p.id, "delete"); }} className={`flex items-center gap-1 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-red-300 ${press}`}>
                        <Trash2 className="h-3.5 w-3.5" /> Delete
                      </button>
                    </>
                  )}
                  {props.canEdit && p.status === "failed" && (
                    <button
                      onClick={() => {
                        const when = window.prompt("Retry schedule for (YYYY-MM-DDTHH:MM), blank = now:", "");
                        postAction(p.id, "schedule", when ? { scheduledFor: new Date(when).toISOString() } : { scheduledFor: new Date().toISOString() });
                      }}
                      className={`flex items-center gap-1 rounded-md border border-amber-800 px-2.5 py-1.5 text-xs text-amber-300 ${press}`}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> Retry
                    </button>
                  )}
                  {props.canEdit && (p.status === "scheduled" || p.status === "failed") && (
                    <button onClick={() => { if (window.confirm("Cancel this post? Pending Buffer updates will be removed.")) postAction(p.id, "cancel"); }} className={`flex items-center gap-1 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 ${press}`}>
                      <X className="h-3.5 w-3.5" /> Cancel
                    </button>
                  )}
                  {(p.status === "sent" || p.status === "scheduled") && props.canEdit && (
                    <button onClick={() => postAction(p.id, "analytics")} disabled={busy === `analytics:${p.id}`} className={`flex items-center gap-1 rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300 ${press}`}>
                      <BarChart3 className="h-3.5 w-3.5" /> {busy === `analytics:${p.id}` ? "Syncing…" : "Sync analytics"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Detail drawer */}
          <div>
            {selectedPost ? (
              <div className={`rounded-xl border border-zinc-800 bg-zinc-950 p-5 ${fade}`}>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-zinc-100">Post detail</h3>
                  <button onClick={() => setSelectedPostId(null)} className="text-zinc-500 hover:text-zinc-300"><X className="h-4 w-4" /></button>
                </div>
                <div className="mb-3 text-sm text-zinc-200 whitespace-pre-wrap">{selectedPost.content.text}</div>
                {Object.entries(selectedPost.content.perChannel).length > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 text-xs font-medium uppercase tracking-widest text-zinc-500">Overrides</div>
                    {Object.entries(selectedPost.content.perChannel).map(([s, o]) => (
                      <div key={s} className="mb-1 text-xs text-zinc-400">
                        <span className="font-medium text-zinc-300">{serviceLabel(s)}:</span> {(o as { text?: string }).text}
                      </div>
                    ))}
                  </div>
                )}
                {(selectedPost.content.media.length > 0 || selectedPost.content.link) && (
                  <div className="mb-3 text-xs text-zinc-400">
                    {selectedPost.content.media.map((m, i) => (
                      <div key={i} className="truncate">[{m.type}] {m.url}</div>
                    ))}
                    {selectedPost.content.link && <div className="truncate">[link] {selectedPost.content.link}</div>}
                  </div>
                )}
                <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
                  <div><div className="text-zinc-500">Status</div><div className="text-zinc-200">{selectedPost.status}</div></div>
                  <div><div className="text-zinc-500">Scheduled</div><div className="text-zinc-200">{fmtDateTime(selectedPost.scheduledFor)}</div></div>
                  <div><div className="text-zinc-500">Attempts</div><div className="text-zinc-200">{selectedPost.attempts}</div></div>
                  <div><div className="text-zinc-500">Analytics synced</div><div className="text-zinc-200">{selectedPost.statsSyncedAt ? fmtDateTime(selectedPost.statsSyncedAt) : "never"}</div></div>
                </div>
                <AnalyticsBlock stats={selectedPost.stats} />
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-600">
                Select a post for details and analytics.
              </div>
            )}
          </div>
        </div>
      )}

      {/* CHANNELS */}
      {tab === "channels" && (
        <div className={fade}>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-zinc-400">
              {connected ? "Buffer connected. Sync to pull your connected profiles." : "Connect Buffer in Settings first."}
            </p>
            {props.canEdit && connected && (
              <button onClick={syncChannelsNow} disabled={busy === "sync"} className={`flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 ${press}`}>
                <RefreshCw className="h-4 w-4" /> {busy === "sync" ? "Syncing…" : "Sync channels"}
              </button>
            )}
          </div>
          {channels.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No channels yet. Connect Buffer, then sync.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {channels.map((c) => (
                <div key={c.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-semibold text-zinc-100">{serviceLabel(c.service)}</span>
                    {props.canEdit ? (
                      <button
                        onClick={() => toggleChannel(c.id, !c.enabled)}
                        disabled={busy === `channel:${c.id}`}
                        className={`relative h-6 w-11 rounded-full ${press} ${fade} ${c.enabled ? "bg-blue-600" : "bg-zinc-700"}`}
                        aria-label={c.enabled ? "Disable channel" : "Enable channel"}
                      >
                        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${c.enabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
                      </button>
                    ) : (
                      <span className="text-xs text-zinc-500">{c.enabled ? "enabled" : "disabled"}</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">{c.handle ?? c.bufferProfileId}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SETTINGS */}
      {tab === "settings" && (
        <div className={`${fade} max-w-xl rounded-xl border border-zinc-800 bg-zinc-950 p-5`}>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Plug className="h-4 w-4" /> Buffer connection
          </h3>
          <p className="mb-4 text-xs text-zinc-500">
            Connect with a Buffer access token (Buffer dashboard → Manage Apps → access token). Stored encrypted,
            never shown again. Workspace-wide: all projects share the connection; channels are enabled per project.
          </p>
          {connected ? (
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm text-emerald-300">
                <Check className="h-4 w-4" /> Connected {tokenHint && <span className="text-zinc-500">({tokenHint})</span>}
              </div>
              {props.canEdit && (
                <div className="flex flex-col gap-3">
                  <input
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    type="password"
                    placeholder="Paste a new token to rotate…"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                  />
                  <div className="flex gap-2">
                    <button onClick={saveToken} disabled={busy === "token" || !tokenInput.trim()} className={`rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${press}`}>
                      Rotate token
                    </button>
                    <button onClick={() => { if (window.confirm("Revoke the Buffer token? Scheduled posts will stop dispatching.")) revokeToken(); }} disabled={busy === "token"} className={`rounded-lg border border-red-900 px-4 py-2 text-sm font-medium text-red-300 ${press}`}>
                      Revoke
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : props.canEdit ? (
            <div className="flex flex-col gap-3">
              <input
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                type="password"
                placeholder="Buffer access token"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
              <button onClick={saveToken} disabled={busy === "token" || !tokenInput.trim()} className={`w-fit rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${press}`}>
                {busy === "token" ? "Connecting…" : "Connect Buffer"}
              </button>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">Not connected. An editor can connect Buffer.</p>
          )}
        </div>
      )}
    </div>
  );
}

function AnalyticsBlock({ stats }: { stats: unknown }) {
  const s = (stats ?? {}) as { byChannel?: Record<string, Record<string, number | undefined>>; totals?: Record<string, number> };
  const totals = s.totals ?? {};
  const hasAny = Object.values(totals).some((v) => (v ?? 0) > 0) || (s.byChannel && Object.keys(s.byChannel).length > 0);
  if (!hasAny) return <p className="text-xs text-zinc-600">No analytics yet — sync to pull engagement from Buffer.</p>;
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">Analytics</div>
      <div className="mb-2 grid grid-cols-4 gap-2 text-center">
        {(["likes", "shares", "comments", "clicks"] as const).map((k) => (
          <div key={k} className="rounded-lg border border-zinc-800 px-2 py-2">
            <div className="text-lg font-semibold text-zinc-100">{totals[k] ?? 0}</div>
            <div className="text-[11px] capitalize text-zinc-500">{k}</div>
          </div>
        ))}
      </div>
      {s.byChannel && Object.entries(s.byChannel).map(([svc, vals]) => (
        <div key={svc} className="flex justify-between text-xs text-zinc-400">
          <span>{serviceLabel(svc)}</span>
          <span>
            {vals.likes ?? 0} likes · {vals.shares ?? 0} shares · {vals.comments ?? 0} comments · {vals.clicks ?? 0} clicks
          </span>
        </div>
      ))}
    </div>
  );
}
