// Marketr — nurture workspace: Listmonk broadcast tab (Phase 12).
// Newsletter campaigns via the Listmonk sidecar (AGPL, raw REST only).
// Unconfigured → honest "connect to enable" empty state, never fake data.

"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ExternalLink, MailOpen, Plus, Search, Send } from "lucide-react";
import { Chip, EmptyState, Modal, btnExecute, btnPrimary, btnSecondary, inputCls } from "./ui";
import { confirmAction, toastError } from "@/lib/ui/feedback";

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
        !await confirmAction(
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
      <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
        <MailOpen size={28} className="mx-auto text-subtle" />
        <h3 className="mt-2 text-sm font-semibold text-ink">Connect Listmonk to run newsletter broadcasts</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Listmonk is a self-hosted email engine sidecar (AGPL-3.0, own Postgres). Set{" "}
          <span className="aos-mono">LISTMONK_URL</span>, <span className="aos-mono">LISTMONK_USER</span>, and{" "}
          <span className="aos-mono">LISTMONK_TOKEN</span> in Settings → Providers, then come back here.
        </p>
        <a href="/dashboard/settings/providers" className={`${btnSecondary} mt-3 inline-flex items-center`}>
          <ExternalLink size={14} /> Open Settings → Providers
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select className={`${inputCls} w-36`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["draft", "scheduled", "running", "sent", "paused", "cancelled"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search campaigns…"
          />
        </div>
        <span className="ml-auto text-[12px] text-muted">{rows.length} broadcasts</span>
        <button className={btnPrimary} onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> New broadcast
        </button>
      </div>

      {error ? (
        <p className="border-b border-line bg-failed-tint px-3 py-2 text-[12px] text-failed-text">{error}</p>
      ) : null}

      {loading ? (
        <div className="p-6 text-[13px] text-muted">Loading broadcasts…</div>
      ) : rows.length === 0 ? (
        <div className="p-4"><EmptyState title="No broadcasts yet" hint="Create one to send a newsletter via the Listmonk sidecar." /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2">Campaign</th>
                <th className="px-3 py-2">Lists</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Sent</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((b) => (
                <tr key={b.id} className="hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <button className="text-left hover:text-ink" onClick={() => openDetail(b)}>
                      <div className="font-medium text-ink">{b.name}</div>
                      <div className="max-w-[320px] truncate text-[12px] text-muted">{b.subject}</div>
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {b.lists.map((l) => (
                        <Chip key={l.id}>{l.name}</Chip>
                      ))}
                      {b.lists.length === 0 ? <span className="text-[12px] text-subtle">—</span> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2"><Chip>{b.status}</Chip></td>
                  <td className="px-3 py-2 text-muted">{b.sentCount ?? "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-[12px] text-muted">{timeAgo(b.updatedAt)}</td>
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
                                toastError("Could not parse that date/time.");
                                return;
                              }
                              send(b, "scheduled", d.toISOString());
                            }}
                            title="Schedule for a future time"
                          >
                            <CalendarClock size={13} />
                          </button>
                          <button
                            className={btnExecute}
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
              <Chip>{detail.campaign.status}</Chip>
              <span className="text-[13px] text-muted">{detail.campaign.subject}</span>
            </div>
            {detail.stats ? (
              <div className="grid grid-cols-4 gap-2">
                {([["sent", detail.stats.sent], ["viewed", detail.stats.viewed], ["clicked", detail.stats.clicked], ["bounced", detail.stats.bounced]] as const).map(([k, v]) => (
                  <div key={k} className="rounded-lg bg-canvas p-2 text-center">
                    <div className="text-[16px] font-bold text-ink">{v}</div>
                    <div className="text-xs font-semibold text-muted">{k}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-muted">No send stats yet — stats appear after the first send.</p>
            )}
            <p className="text-[12px] text-muted">
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
          <p className="mb-1 text-xs font-semibold text-muted">Lists ({picked.size} selected)</p>
          <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {lists.length === 0 ? (
              <p className="text-[12px] text-subtle">No lists yet — create one in the Listmonk admin UI first.</p>
            ) : lists.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-2 px-1 py-0.5 hover:bg-hover-paper">
                <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} className="accent-ink" />
                <span className="text-[13px] text-ink">{l.name}</span>
                <span className="ml-auto text-[11px] text-subtle">{l.subscriberCount ?? "—"} subscribers</span>
              </label>
            ))}
          </div>
        </div>
        <textarea
          className={`${inputCls} aos-mono min-h-[140px]`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="<h1>Hello</h1><p>Your newsletter HTML…</p>"
        />
        {error ? <p className="text-[13px] text-failed-text">{error}</p> : null}
        <div className="flex items-center justify-between border-t border-line pt-3">
          <p className="text-[12px] text-muted">Saved as a draft in Listmonk. Sends happen from the row actions.</p>
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
