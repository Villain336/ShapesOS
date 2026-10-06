// Marketr — Phase 13D: sessions table client.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Search, Loader2 } from "lucide-react";
import {
  api,
  Chip,
  statusTone,
  inputCls,
  tableCls,
  theadCls,
  thCls,
  rowCls,
  tdCls,
  VoiceTabs,
  Note,
} from "../_client";

interface SessionRow {
  id: string;
  channel: string;
  status: string;
  outcome: string | null;
  blockReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  agent: { id: string; name: string };
  lead: { id: string; name: string };
}

export function SessionsApp() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fStatus, setFStatus] = useState("");
  const [fChannel, setFChannel] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fStatus) qs.set("status", fStatus);
      if (fChannel) qs.set("channel", fChannel);
      const r = await api<{ sessions: SessionRow[] }>(`/api/voice/sessions?${qs.toString()}`);
      setRows(r.sessions);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, [fStatus, fChannel]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = q.trim()
    ? rows.filter(
        (s) =>
          s.lead.name.toLowerCase().includes(q.toLowerCase()) ||
          s.agent.name.toLowerCase().includes(q.toLowerCase()),
      )
    : rows;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aos-heading">Call Sessions</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          Every session — live, rehearsal, or blocked — with its consent proof and audit trail.
        </p>
      </div>
      <VoiceTabs active="sessions" />
      <Note>
        <strong>Blocked</strong> sessions are refused requests persisted for audit — consent missing,
        kill switch on, draft script, or missing AI disclosure. Refusals are never silent.
      </Note>

      <div className="flex flex-wrap items-center gap-2">
        <select className={inputCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["rehearsal", "queued", "in_progress", "completed", "cancelled", "blocked"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select className={inputCls} value={fChannel} onChange={(e) => setFChannel(e.target.value)}>
          <option value="">All channels</option>
          {["voice", "sms", "chat"].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            className={`${inputCls} pl-8`}
            placeholder="Search lead or agent…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Session</th>
              <th className={thCls}>Lead</th>
              <th className={thCls}>Agent</th>
              <th className={thCls}>Channel</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Outcome</th>
              <th className={thCls}>Blocked reason</th>
              <th className={thCls}>Started</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className={rowCls}>
                <td className={tdCls} colSpan={8}>
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </span>
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr className={rowCls}>
                <td className={tdCls} colSpan={8}>No sessions match.</td>
              </tr>
            )}
            {filtered.map((s) => (
              <tr key={s.id} className={rowCls}>
                <td className={tdCls}>
                  <Link
                    href={`/dashboard/voice/sessions/${s.id}`}
                    className="font-mono text-[0.75rem] text-ink hover:text-ink"
                  >
                    {s.id.slice(-8)}
                  </Link>
                </td>
                <td className={`${tdCls} font-medium`}>{s.lead.name}</td>
                <td className={tdCls}>{s.agent.name}</td>
                <td className={tdCls}><Chip tone="slate">{s.channel}</Chip></td>
                <td className={tdCls}><Chip tone={statusTone(s.status)}>{s.status}</Chip></td>
                <td className={tdCls}>{s.outcome ?? "—"}</td>
                <td className={`${tdCls} font-mono text-[0.75rem]`}>
                  {s.blockReason ? <Chip tone="red">{s.blockReason}</Chip> : "—"}
                </td>
                <td className={tdCls}>
                  {s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
