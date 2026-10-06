// Marketr — Phase 13D: Voice agents home.
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, Pause, Play, Trash2, Loader2, ShieldAlert } from "lucide-react";
import {
  api,
  Chip,
  statusTone,
  inputCls,
  btnPrimary,
  btnGhost,
  tableCls,
  theadCls,
  thCls,
  rowCls,
  tdCls,
  VoiceTabs,
  Note,
} from "./_client";
import { confirmAction, toastError } from "@/lib/ui/feedback";

interface Agent {
  id: string;
  name: string;
  purpose: string;
  voiceId: string;
  killSwitch: boolean;
  status: string;
  createdAt: string;
  _count: { sessions: number; scripts: number };
}

export function AgentsApp() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [purpose, setPurpose] = useState("followup");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ agents: Agent[] }>("/api/voice/agents");
      setAgents(r.agents);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!name.trim() || !voiceId.trim()) return;
    setCreating(true);
    try {
      await api("/api/voice/agents", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), voiceId: voiceId.trim(), purpose }),
      });
      setName("");
      setVoiceId("");
      await load();
    } finally {
      setCreating(false);
    }
  };

  const toggleKill = async (a: Agent) => {
    const ok = await confirmAction(
      a.killSwitch
        ? {
            title: `Release the kill switch for "${a.name}"?`,
            description: "The agent can start calling again.",
            confirmLabel: "Release",
          }
        : {
            title: `Engage the kill switch for "${a.name}"?`,
            description: "The agent stops placing and taking calls immediately.",
            confirmLabel: "Engage kill switch",
            destructive: true,
          },
    );
    if (!ok) return;
    await api(`/api/voice/agents/${a.id}/kill-switch`, {
      method: "POST",
      body: JSON.stringify({ enabled: !a.killSwitch }),
    });
    await load();
  };

  const remove = async (a: Agent) => {
    if (!await confirmAction(`Delete agent "${a.name}"? Sessions history blocks deletion.`)) return;
    try {
      await api(`/api/voice/agents/${a.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aos-heading">Voice Agents</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          LiveKit follow-up agents that qualify leads and book meetings — consent-gated, disclosure-first.
        </p>
      </div>
      <VoiceTabs active="agents" />
      <Note>
        Default mode is <strong>rehearsal</strong>: sessions run the four gates in simulation — nothing
        dials. Live dialing requires <code>LIVE_DIALING=1</code> plus a human-approved session.
        The kill switch refuses all new sessions for an agent, immediately.
      </Note>

      <div className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-paper p-3">
        <input className={inputCls} placeholder="Agent name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inputCls} placeholder="VoiceStudio voice id" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} />
        <select className={inputCls} value={purpose} onChange={(e) => setPurpose(e.target.value)}>
          <option value="followup">followup</option>
          <option value="voiceover">voiceover</option>
        </select>
        <button className={btnPrimary} onClick={create} disabled={creating || !name.trim() || !voiceId.trim()}>
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          New agent
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Agent</th>
              <th className={thCls}>Purpose</th>
              <th className={thCls}>Voice</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Sessions</th>
              <th className={thCls}>Scripts</th>
              <th className={thCls}>Kill switch</th>
              <th className={thCls} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className={rowCls}>
                <td className={tdCls} colSpan={8}>Loading…</td>
              </tr>
            )}
            {!loading && agents.length === 0 && (
              <tr className={rowCls}>
                <td className={tdCls} colSpan={8}>No agents yet — create the first follow-up agent above.</td>
              </tr>
            )}
            {agents.map((a) => (
              <tr key={a.id} className={rowCls}>
                <td className={tdCls}>
                  <Link href={`/dashboard/voice/sessions?agentId=${a.id}`} className="font-medium text-ink hover:text-ink">
                    {a.name}
                  </Link>
                </td>
                <td className={tdCls}><Chip tone={a.purpose === "followup" ? "brand" : "slate"}>{a.purpose}</Chip></td>
                <td className={`${tdCls} font-mono text-[0.75rem]`}>{a.voiceId}</td>
                <td className={tdCls}><Chip tone={statusTone(a.status)}>{a.status}</Chip></td>
                <td className={tdCls}>{a._count.sessions}</td>
                <td className={tdCls}>{a._count.scripts}</td>
                <td className={tdCls}>
                  <button
                    className={a.killSwitch ? "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover" : btnGhost}
                    onClick={() => toggleKill(a)}
                    title={a.killSwitch ? "Kill switch engaged — release" : "Engage kill switch"}
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {a.killSwitch ? "Engaged" : "Off"}
                  </button>
                </td>
                <td className={`${tdCls} text-right`}>
                  <button className={btnGhost} onClick={() => remove(a)} title="Delete agent">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-[0.75rem] text-muted">
        <Pause className="h-3.5 w-3.5" />
        <Play className="h-3.5 w-3.5" />
        Pausing/archiving an agent also refuses new sessions (gate a). Delete is blocked while session history exists.
      </div>
    </div>
  );
}
