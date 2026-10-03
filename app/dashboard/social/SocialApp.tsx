// Marketr — social publishing workspace (Phase 12, Postiz sidecar).
// Schedule and publish posts across ~30 channels via the self-hosted
// Postiz sidecar (AGPL-3.0, raw REST only — never its SDK). Platform OAuth
// tokens live inside Postiz; Marketr only holds the sidecar URL + API key.

"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { OpenInSheetsButton } from "@/components/office/OpenInSheetsButton";
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  ImagePlus,
  Link2,
  Plus,
  Search,
  Send,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";
import { closeOnEscape } from "@/lib/ui/keyboard";

interface PostizChannel {
  id: string;
  identifier: string;
  name: string | null;
  picture: string | null;
  connectedAt: string | null;
}

interface PostizPost {
  id: string;
  type: string;
  date: string | null;
  content: string | null;
  channels: string[];
  createdAt: string | null;
}

type Tab = "scheduled" | "channels";

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

const inputCls =
  "w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";
const btnPrimary =
  "inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700 disabled:opacity-50";
const btnSecondary =
  "inline-flex items-center gap-1.5 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50";

function Chip({ tone, children }: { tone: string; children: ReactNode }) {
  const tones: Record<string, string> = {
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    violet: "bg-brand-50 text-brand-700 border-violet-200",
    stone: "bg-stone-100 text-stone-600 border-stone-200",
    blue: "bg-sky-50 text-sky-700 border-sky-200",
  };
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium leading-4 ${tones[tone] ?? tones.stone}`}>
      {children}
    </span>
  );
}

const TYPE_TONE: Record<string, string> = { now: "green", schedule: "amber", draft: "stone" };

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function SocialApp() {
  const [tab, setTab] = useState<Tab>("scheduled");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [posts, setPosts] = useState<PostizPost[]>([]);
  const [channels, setChannels] = useState<PostizChannel[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const st = await api<{ configured: boolean }>("/api/integrations/postiz/status");
      setConnected(st.configured);
      if (!st.configured) {
        setLoading(false);
        return;
      }
      const [p, c] = await Promise.all([
        api<{ posts: PostizPost[] }>("/api/integrations/postiz/posts"),
        api<{ channels: PostizChannel[] }>("/api/integrations/postiz/channels"),
      ]);
      setPosts(p.posts);
      setChannels(c.channels);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deletePost = async (id: string) => {
    if (!await confirmAction("Delete this post from the Postiz queue?")) return;
    setBusy(id);
    setError(null);
    try {
      await api(`/api/integrations/postiz/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
      setPosts((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  if (connected === false) {
    return (
      <div className="rounded-[10px] border border-stone-200 bg-white p-8 text-center">
        <Share2 size={28} className="mx-auto text-stone-300" />
        <h3 className="mt-2 text-[15px] font-bold text-stone-900">Connect Postiz to schedule social posts</h3>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-stone-500">
          Postiz is a self-hosted publishing sidecar (AGPL-3.0) covering ~30 social channels behind one API.
          Set <span className="font-mono">POSTIZ_URL</span> and <span className="font-mono">POSTIZ_API_KEY</span> in
          Settings → Providers, then connect your channels inside the Postiz UI — Marketr never sees platform tokens.
        </p>
        <a href="/dashboard/settings/providers" className={`${btnSecondary} mt-3 inline-flex items-center`}>
          <ExternalLink size={14} /> Open Settings → Providers
        </a>
      </div>
    );
  }

  const filtered = posts.filter((p) =>
    !q.trim() || (p.content ?? "").toLowerCase().includes(q.trim().toLowerCase()),
  );

  const tabs: Array<{ id: Tab; label: string; Icon: typeof Search }> = [
    { id: "scheduled", label: "Scheduled & sent", Icon: CalendarClock },
    { id: "channels", label: "Channels", Icon: Link2 },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200">
        <div className="flex gap-1">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${
                tab === id ? "border-brand-600 text-brand-700" : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              <Icon size={15} />
              {label}
              {id === "channels" && channels.length ? (
                <span className={`rounded-full px-1.5 text-[11px] font-semibold ${tab === id ? "bg-brand-50 text-brand-700" : "bg-zinc-100 text-zinc-600"}`}>
                  {channels.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button className={btnPrimary} onClick={() => setComposeOpen(true)}>
          <Plus size={14} /> Compose
        </button>
      </div>

      {error ? (
        <p className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
      ) : null}

      {tab === "scheduled" ? (
        <div className="rounded-[10px] border border-stone-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-3 py-2">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
              <input
                className={`${inputCls} pl-8`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search posts…"
              />
            </div>
            <span className="ml-auto text-[12px] text-stone-500">{filtered.length} posts</span>
            {filtered.length > 0 && (
              <OpenInSheetsButton
                title="Content calendar"
                headers={["Scheduled for", "Post", "Channels", "Type", "Created"]}
                rows={filtered.map((p) => [
                  p.date ?? "—",
                  p.content ?? "—",
                  p.channels.join(", ") || "—",
                  p.type,
                  p.createdAt ?? "—",
                ])}
                sourceRef="social:calendar"
                sheetName="Calendar"
                className={btnSecondary}
              />
            )}
          </div>
          {loading ? (
            <div className="p-6 text-[13px] text-stone-500">Loading posts…</div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-medium text-stone-600">No posts yet</p>
              <p className="mt-1 text-[12px] text-stone-400">Compose one — it schedules through the Postiz sidecar.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-200 text-[11px] uppercase tracking-wide text-stone-400">
                    <th className="px-3 py-2 font-medium">Post</th>
                    <th className="px-3 py-2 font-medium">Channels</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                    <th className="px-3 py-2 font-medium">Scheduled for</th>
                    <th className="px-3 py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {filtered.map((p) => (
                    <tr key={p.id} className="hover:bg-brand-50/40">
                      <td className="max-w-[380px] px-3 py-2">
                        <div className="truncate text-stone-900">{p.content ?? "—"}</div>
                        <div className="text-[11px] text-stone-400">created {fmtDate(p.createdAt)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {p.channels.length ? p.channels.map((c) => <Chip key={c} tone="blue">{c}</Chip>) : <span className="text-[12px] text-stone-400">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2"><Chip tone={TYPE_TONE[p.type] ?? "stone"}>{p.type}</Chip></td>
                      <td className="whitespace-nowrap px-3 py-2 text-[12px] text-stone-500">{fmtDate(p.date)}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          className="rounded p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                          disabled={busy === p.id}
                          onClick={() => deletePost(p.id)}
                          title="Delete post"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[10px] border border-stone-200 bg-white">
          <div className="border-b border-stone-200 px-3 py-2">
            <span className="text-[13px] font-semibold text-stone-800">Connected channels</span>
            <p className="mt-0.5 text-[12px] text-stone-500">
              Channels connect inside the Postiz UI (its own OAuth flow). Marketr only reads them back for scheduling.
            </p>
          </div>
          {loading ? (
            <div className="p-6 text-[13px] text-stone-500">Loading channels…</div>
          ) : channels.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-[13px] font-medium text-stone-600">No channels connected yet</p>
              <p className="mx-auto mt-1 max-w-sm text-[12px] text-stone-400">
                Open your Postiz instance, go to Channels, and connect your X, LinkedIn, Instagram, TikTok, and other
                accounts there. They will appear here for scheduling.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-200 text-[11px] uppercase tracking-wide text-stone-400">
                    <th className="px-3 py-2 font-medium">Channel</th>
                    <th className="px-3 py-2 font-medium">Platform</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Connected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {channels.map((c) => (
                    <tr key={c.id} className="hover:bg-brand-50/40">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {c.picture ? (
                            <img src={c.picture} alt="" className="h-6 w-6 rounded-full object-cover" />
                          ) : (
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                              <Share2 size={12} />
                            </span>
                          )}
                          <span className="font-medium text-stone-900">{c.name ?? c.identifier}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2"><Chip tone="blue">{c.identifier}</Chip></td>
                      <td className="px-3 py-2"><Chip tone="green">connected</Chip></td>
                      <td className="whitespace-nowrap px-3 py-2 text-[12px] text-stone-500">{fmtDate(c.connectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {composeOpen ? (
        <ComposeModal channels={channels} onClose={() => setComposeOpen(false)} onDone={() => { setComposeOpen(false); load(); }} />
      ) : null}
    </div>
  );
}

function ComposeModal({
  channels,
  onClose,
  onDone,
}: {
  channels: PostizChannel[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [content, setContent] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"now" | "schedule" | "draft">("schedule");
  const [when, setWhen] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async () => {
    if (mode === "now" && !await confirmAction(`Publish now to ${picked.size} channel${picked.size === 1 ? "" : "s"}? This posts publicly.`)) return;
    setSaving(true);
    setError(null);
    try {
      const platformTypes: Record<string, string> = {};
      for (const c of channels) if (picked.has(c.id) && c.identifier) platformTypes[c.id] = c.identifier;
      await api("/api/integrations/postiz/posts", {
        method: "POST",
        body: JSON.stringify({
          type: mode,
          content,
          channelIds: [...picked],
          platformTypes,
          ...(mode === "schedule" && when ? { date: new Date(when).toISOString() } : {}),
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Schedule failed");
    } finally {
      setSaving(false);
    }
  };

  const valid = content.trim().length > 0 && picked.size > 0 && (mode !== "schedule" || when.trim().length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[8vh]" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div className="w-full max-w-3xl rounded-xl border border-stone-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
          <h3 className="text-[14px] font-semibold text-stone-900">Compose post</h3>
          <button onClick={onClose} className="rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700" aria-label="Close"><X size={16} /></button>
        </div>
        <div className="space-y-3 p-4">
          <textarea
            className={`${inputCls} min-h-[120px]`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="What should the post say?"
            maxLength={10_000}
          />
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-medium text-stone-600">Channels ({picked.size} selected)</p>
            <p className="text-[11px] text-stone-400">{content.length}/10000</p>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-stone-200 p-2">
            {channels.length === 0 ? (
              <p className="p-1 text-[12px] text-stone-400">
                No channels connected yet — connect them in the Postiz UI first.
              </p>
            ) : channels.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-stone-50">
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="accent-brand-600" />
                <span className="text-[13px] text-stone-800">{c.name ?? c.identifier}</span>
                <span className="ml-auto"><Chip tone="blue">{c.identifier}</Chip></span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {(["now", "schedule", "draft"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-md border px-2.5 py-1.5 text-[13px] font-medium ${
                    mode === m ? "border-brand-600 bg-brand-50 text-brand-700" : "border-stone-300 text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  {m === "now" ? "Publish now" : m === "schedule" ? "Schedule" : "Save draft"}
                </button>
              ))}
            </div>
            {mode === "schedule" ? (
              <input
                type="datetime-local"
                className={`${inputCls} !w-auto`}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            ) : null}
          </div>
          {error ? <p className="text-[13px] text-red-600">{error}</p> : null}
          <div className="flex items-center justify-between border-t border-stone-200 pt-3">
            <p className="flex items-center gap-1 text-[12px] text-stone-500">
              {mode === "now" ? <Send size={12} /> : mode === "schedule" ? <CalendarClock size={12} /> : <CheckCircle2 size={12} />}
              {mode === "now"
                ? "Publishes publicly the moment you confirm."
                : mode === "schedule"
                  ? "Postiz publishes at the scheduled time (needs Temporal running in Postiz)."
                  : "Saved as a draft in Postiz, not published."}
            </p>
            <div className="flex gap-2">
              <button className={btnSecondary} onClick={onClose}>Cancel</button>
              <button className={btnPrimary} disabled={saving || !valid} onClick={save}>
                <ImagePlus size={14} /> {saving ? "Saving…" : mode === "now" ? "Publish" : mode === "schedule" ? "Schedule" : "Save draft"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
