// Marketr — Phase 13D: session detail client (transcript timeline + audit trail + consent proof).
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ShieldCheck, ShieldAlert, Loader2, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import {
  api,
  Chip,
  statusTone,
  btnPrimary,
  btnGhost,
  rowCls,
  tdCls,
  thCls,
  theadCls,
  tableCls,
  Note,
} from "../../_client";

interface Turn {
  role: "agent" | "prospect" | "system";
  text: string;
  ts: string;
}

interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  detail?: string;
}

interface SessionDetail {
  id: string;
  channel: string;
  direction: string;
  status: string;
  outcome: string | null;
  blockReason: string | null;
  consentProof: Record<string, unknown>;
  transcript: Turn[];
  auditTrail: AuditEntry[];
  recordingRef: string | null;
  recordingConsent: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  agent: { id: string; name: string; killSwitch: boolean };
  lead: { id: string; name: string; email: string | null; phone: string | null };
  script: { id: string; name: string; version: number; status: string } | null;
}

export function SessionDetailApp({ sessionId }: { sessionId: string }) {
  const [s, setS] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ session: SessionDetail }>(`/api/voice/sessions/${sessionId}`);
      setS(r.session);
    } catch {
      setS(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const transition = async (to: string) => {
    setBusy(true);
    try {
      await api(`/api/voice/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ op: "transition", to }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveOutcome = async () => {
    if (!outcome.trim()) return;
    setBusy(true);
    try {
      await api(`/api/voice/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ op: "outcome", outcome: outcome.trim() }),
      });
      setOutcome("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <div className="flex items-center gap-2 text-[13px] text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading session…
      </div>
    );
  if (!s) return <div className="text-[13px] text-stone-500">Session not found.</div>;

  const proof = s.consentProof ?? {};
  const turns: Turn[] = Array.isArray(s.transcript) ? s.transcript : [];
  const trail: AuditEntry[] = Array.isArray(s.auditTrail) ? s.auditTrail : [];

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/dashboard/voice/sessions"
        className="inline-flex w-fit items-center gap-1 text-[13px] text-stone-500 hover:text-stone-800"
      >
        <ArrowLeft className="h-4 w-4" /> Sessions
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold tracking-tight text-stone-900">
          Session {s.id.slice(-8)}
        </h1>
        <Chip tone={statusTone(s.status)}>{s.status}</Chip>
        <Chip tone="slate">{s.channel}</Chip>
        {s.blockReason && <Chip tone="red">{s.blockReason}</Chip>}
        {s.outcome && <Chip tone="brand">{s.outcome}</Chip>}
      </div>
      <div className="flex flex-wrap gap-2">
        {s.status === "rehearsal" && (
          <>
            <button className={btnPrimary} disabled={busy} onClick={() => transition("in_progress")}>
              Mark in progress
            </button>
            <button className={btnGhost} disabled={busy} onClick={() => transition("completed")}>
              Mark completed
            </button>
            <button className={btnGhost} disabled={busy} onClick={() => transition("cancelled")}>
              Cancel
            </button>
          </>
        )}
        {(s.status === "rehearsal" || s.status === "in_progress") && (
          <select
            className="rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
          >
            <option value="">Set outcome…</option>
            {["qualified", "booked", "callback", "not_interested", "no_answer", "wrong_number"].map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        )}
        {outcome && (
          <button className={btnPrimary} disabled={busy} onClick={saveOutcome}>
            <CheckCircle2 className="h-4 w-4" /> Save outcome
          </button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Consent proof panel */}
        <div className="rounded-md border border-stone-200 bg-white p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-stone-900">
            {String(proof.status) === "opted_in" ? (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-red-600" />
            )}
            Consent proof
          </div>
          <dl className="space-y-1.5 text-[12px]">
            {[
              ["Status", String(proof.status ?? "—")],
              ["Channel", String(proof.channel ?? "—")],
              ["Consented at", proof.consentedAt ? new Date(String(proof.consentedAt)).toLocaleString() : "—"],
              ["Opted out at", proof.optedOutAt ? new Date(String(proof.optedOutAt)).toLocaleString() : "—"],
              ["Source", String(proof.source ?? "—")],
              ["Checked at", proof.checkedAt ? new Date(String(proof.checkedAt)).toLocaleString() : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt className="text-stone-500">{k}</dt>
                <dd className="font-medium text-stone-800">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[11px] text-stone-500">{String(proof.legalBasis ?? "")}</p>
        </div>

        {/* Meta panel */}
        <div className="rounded-md border border-stone-200 bg-white p-4">
          <div className="mb-2 text-[13px] font-semibold text-stone-900">Details</div>
          <dl className="space-y-1.5 text-[12px]">
            {[
              ["Lead", s.lead.name],
              ["Phone", s.lead.phone ?? "—"],
              ["Agent", s.agent.name],
              ["Script", s.script ? `${s.script.name} v${s.script.version} (${s.script.status})` : "—"],
              ["Direction", s.direction],
              ["Recording consent", s.recordingConsent ? "granted" : "not granted"],
              ["Recording", s.recordingRef ?? "—"],
              ["Started", s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"],
              ["Ended", s.endedAt ? new Date(s.endedAt).toLocaleString() : "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt className="text-stone-500">{k}</dt>
                <dd className="font-medium text-stone-800">{v}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Transcript */}
        <div className="rounded-md border border-stone-200 bg-white p-4">
          <div className="mb-2 text-[13px] font-semibold text-stone-900">
            Transcript ({turns.length})
          </div>
          {turns.length === 0 && (
            <p className="text-[12px] text-stone-500">No transcript turns yet.</p>
          )}
          <ol className="max-h-72 space-y-2 overflow-y-auto">
            {turns.map((t, i) => (
              <li
                key={i}
                className={`rounded-md px-2.5 py-1.5 text-[12px] ${
                  t.role === "agent"
                    ? "bg-[var(--brand-50)]/60 text-stone-800"
                    : t.role === "prospect"
                      ? "bg-stone-100 text-stone-800"
                      : "bg-amber-50 text-stone-600"
                }`}
              >
                <span className="font-semibold capitalize">{t.role}: </span>
                {t.text}
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* Audit trail */}
      <div className="overflow-x-auto rounded-md border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-3 py-2 text-[13px] font-semibold text-stone-900">
          Audit trail ({trail.length})
        </div>
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Time</th>
              <th className={thCls}>Actor</th>
              <th className={thCls}>Action</th>
              <th className={thCls}>Detail</th>
            </tr>
          </thead>
          <tbody>
            {trail.map((a, i) => (
              <tr key={i} className={rowCls}>
                <td className={`${tdCls} font-mono text-[12px]`}>
                  {new Date(a.ts).toLocaleString()}
                </td>
                <td className={tdCls}>{a.actor}</td>
                <td className={`${tdCls} font-mono text-[12px]`}>{a.action}</td>
                <td className={`${tdCls} font-mono text-[12px]`}>{a.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {s.status === "blocked" && (
        <Note>
          This session was <strong>refused</strong> by the gate ({s.blockReason}). Refusals are
          persisted for legal audit — the prospect was never contacted.
        </Note>
      )}
    </div>
  );
}
