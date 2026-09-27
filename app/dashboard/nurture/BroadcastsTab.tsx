// Marketr — nurture workspace: Listmonk broadcast tab (Phase 12).
// Newsletter campaigns via the Listmonk sidecar (AGPL, raw REST only).
// Unconfigured → honest "connect to enable" empty state, never fake data.

"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ExternalLink, MailOpen, Plus, Search, Send } from "lucide-react";
import { Chip, EmptyState, Modal, btnPrimary, btnSecondary, inputCls } from "./ui";

export interface Broadcast {
  id: number;
  name: string;
  subject: string;
  status: string;
  lists: Array<{ id: number; name: string }>;
  type: string;
  messenger: string;
  sendAt: string | null;
  sentCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BroadcastList {
  id: number;
  name: string;
  type: string;
  optin: string;
  subscriberCount: number | null;
}

interface BroadcastStats {
  sent: number;
  viewed: number;
  clicked: number;
  bounced: number;
}

const STATUS_TONE: Record<string, "green" | "amber" | "red" | "blue" | "stone" | "zinc" | "violet"> = {
  running: "green",
  sent: "green",
  scheduled: "amber",
  draft: "stone",
  paused: "amber",
  cancelled: "red",
  finished: "blue",
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d ago" : `${d}d ago`;
}

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export function BroadcastsTab() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Broadcast[]>([]);
  const [lists, setLists] = useState<BroadcastList[]>([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<{ campaign: Broadcast; stats: BroadcastStats | null } | null>(null);
  const [sending, setSending] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const st = await api<{ configured: boolean }>("/api/integrations/listmonk/status");
      setConnected(st.configured);
      if (!st.configured) {
        setRows([]);
        setLoading(false);
        return;
      }
      const [c, l] = await Promise.all([
        api<{ campaigns: Broadcast[] }>(`/api/integrations/listmonk/campaigns?${new URLSearchParams({ ...(status ? { status } : {}), ...(q.trim() ? { query: q.trim() } : {}) })}`),
        api<{ lists: BroadcastList[] }>("/api/integrations/listmonk/lists").catch(() => ({ lists: [] as BroadcastList[] })),
      ]);
      setRows(c.campaigns);
      setLists(l.lists);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [status, q]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (b: Broadcast) => {
    try {
      const data = await api<{ campaign: Broadcast; stats: BroadcastStats | null }>(
        `/api/integrations/listmonk/campaigns/${b.id}`,
      );
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  };

  const send = async (b: Broadcast, mode: "now" | "scheduled", runAt?: string) => {
    if (mode === "now") {
      if (
        !confirm(
          `Send "${b.name}" to ${b.lists.map((l) => l.name).join(", ")} now? This is an irreversible real email send.`,
        )
      )
        return;
    } else if (!runAt) return;
    setSending(b.id);
    setError(null);
    try {
      await api(`/api/integrations/listmonk/campaigns/${b.id}/send`, {
        method: "POST",
        body: JSON.stringify({ mode, runAt }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSending(null);
    }
  };

  if (connected === false) {
    return (
      <div className="rounded-[10px] border border-stone-200 bg-white p-8 text-center">
        <MailOpen size={28} className="mx-auto text-stone-300" />
        <h3 className="mt-2 text-[15px] font-bold text-stone-900">Connect Listmonk to run newsletter broadcasts</h3>
        <p className="mx-auto mt-1 max-w-md text-[13px] text-stone-500">
          Listmonk is a self-hosted email engine sidecar (AGPL-3.0, own Postgres). Set{" "}
          <span className="font-mono">LISTMONK_URL</span>, <span className="font-mono">LISTMONK_USER</span>, and{" "}
          <span className="font-mono">LISTMONK_TOKEN</span> in Settings → Providers, then come back here.
        </p>
        <a href="/dashboard/settings/providers" className={`${btnSecondary} mt-3 inline-flex items-center`}>
          <ExternalLink size={14} /> Open Settings → Providers
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-[10px] border border-stone-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 px-3 py-2">
        <select className={`${inputCls} w-36`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["draft", "scheduled", "running", "sent", "paused", "cancelled"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            className={`${inputCls} pl-8`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search campaigns…"
          />
        </div>
        <span className="ml-auto text-[12px] text-stone-500">{rows.length} broadcasts</span>
        <button className={btnPrimary} onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> New broadcast
        </button>
      </div>

      {error ? (
        <p className="border-b border-stone-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
      ) : null}

      {loading ? (
        <div className="p-6 text-[13px] text-stone-500">Loading broadcasts…</div>
      ) : rows.length === 0 ? (
        <div className="p-4"><EmptyState title="No broadcasts yet" hint="Create one to send a newsletter via the Listmonk sidecar." /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 text-[11px] uppercase tracking-wide text-stone-400">
                <th className="px-3 py-2 font-medium">Campaign</th>
                <th className="px-3 py-2 font-medium">Lists</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {rows.map((b) => (
                <tr key={b.id} className="hover:bg-violet-50/40">
                  <td className="px-3 py-2">
                    <button className="text-left hover:text-violet-700" onClick={() => openDetail(b)}>
                      <div className="font-medium text-stone-900">{b.name}</div>
                      <div className="max-w-[320px] truncate text-[12px] text-stone-500">{b.subject}</div>
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {b.lists.map((l) => (
                        <Chip key={l.id} tone="blue">{l.name}</Chip>
                      ))}
                      {b.lists.length === 0 ? <span className="text-[12px] text-stone-400">—</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2"><Chip tone={STATUS_TONE[b.status] ?? "zinc"}>{b.status}</Chip></td>
                  <td className="px-3 py-2 text-stone-700">{b.sentCount ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-stone-500">{timeAgo(b.updatedAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      {b.status === "draft" ? (
                        <>
                          <button
                            className={btnSecondary}
                            disabled={sending === b.id}
                            onClick={() => {
                              const runAt = prompt("Schedule for (YYYY-MM-DD HH:MM, local time):", "");
                              if (!runAt) return;
                              const d = new Date(runAt.replace(" ", "T"));
                              if (!Number.isFinite(d.getTime())) {
                                alert("Could not parse that date/time.");
                                return;
                              }
                              send(b, "scheduled", d.toISOString());
                            }}
                            title="Schedule for a future time"
                          >
                            <CalendarClock size={13} />
                          </button>
                          <button
                            className={btnPrimary}
                            disabled={sending === b.id}
                            onClick={() => send(b, "now")}
                            title="Send now (irreversible)"
                          >
                            <Send size={13} /> {sending === b.id ? "…" : "Send"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen ? (
        <CreateBroadcastModal
          lists={lists}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); load(); }}
        />
      ) : null}

      {detail ? (
        <Modal title={`Broadcast — ${detail.campaign.name}`} onClose={() => setDetail(null)} wide>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Chip tone={STATUS_TONE[detail.campaign.status] ?? "zinc"}>{detail.campaign.status}</Chip>
              <span className="text-[13px] text-stone-600">{detail.campaign.subject}</span>
            </div>
            {detail.stats ? (
              <div className="grid grid-cols-4 gap-2">
                {([["sent", detail.stats.sent], ["viewed", detail.stats.viewed], ["clicked", detail.stats.clicked], ["bounced", detail.stats.bounced]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-stone-200 bg-stone-50 p-2 text-center">
                    <div className="text-[16px] font-bold text-stone-900">{v}</div>
                    <div className="text-[11px] uppercase tracking-wide text-stone-400">{k}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-stone-500">No send stats yet — stats appear after the first send.</p>
            )}
            <p className="text-[12px] text-stone-500">
              New drafts send through the Listmonk sidecar only. Sends are irreversible — confirm in the row actions.
            </p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function CreateBroadcastModal({
  lists,
  onClose,
  onCreated,
}: {
  lists: BroadcastList[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number) =>
    setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/api/integrations/listmonk/campaigns", {
        method: "POST",
        body: JSON.stringify({ name, subject, body, listIds: [...picked] }),
      });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New broadcast (draft)" onClose={onClose} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
          <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line" />
        </div>
        <div>
          <p className="mb-1 text-[12px] font-medium text-stone-600">Lists ({picked.size} selected)</p>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-stone-200 p-2">
            {lists.length === 0 ? (
              <p className="text-[12px] text-stone-400">No lists yet — create one in the Listmonk admin UI first.</p>
            ) : lists.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-stone-50">
                <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="accent-violet-600" />
                <span className="text-[13px] text-stone-800">{l.name}</span>
                <span className="ml-auto text-[11px] text-stone-400">{l.subscriberCount ?? "—"} subscribers</span>
              </label>
            ))}
          </div>
        </div>
        <textarea
          className={`${inputCls} min-h-[140px] font-mono`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="<h1>Hello</h1><p>Your newsletter HTML…</p>"
        />
        {error ? <p className="text-[13px] text-red-600">{error}</p> : null}
        <div className="flex items-center justify-between border-t border-stone-200 pt-3">
          <p className="text-[12px] text-stone-500">Saved as a draft in Listmonk. Sends happen from the row actions.</p>
          <div className="flex gap-2">
            <button className={btnSecondary} onClick={onClose}>Cancel</button>
            <button
              className={btnPrimary}
              disabled={saving || !name.trim() || !subject.trim() || !body.trim() || picked.size === 0}
              onClick={save}
            >
              {saving ? "Saving…" : "Save draft"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
