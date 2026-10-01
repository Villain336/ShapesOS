// Marketr — Phase 13D: script legal-review surface client.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, ShieldAlert, FileText } from "lucide-react";
import {
  api,
  Chip,
  statusTone,
  inputCls,
  btnGhost,
  btnDanger,
  btnApprove,
  btnReview,
  tableCls,
  theadCls,
  thCls,
  rowCls,
  tdCls,
  VoiceTabs,
  Note,
} from "../_client";

interface ScriptRow {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  version: number;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string;
  hasDisclosure: boolean;
  _count: { sessions: number };
}

export function ScriptsApp() {
  const [rows, setRows] = useState<ScriptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fStatus, setFStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fStatus) qs.set("status", fStatus);
      const r = await api<{ scripts: ScriptRow[] }>(`/api/voice/scripts?${qs.toString()}`);
      setRows(r.scripts);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, [fStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (s: ScriptRow, action: "submit" | "approve" | "reject") => {
    const labels = {
      submit: `Submit "${s.name}" v${s.version} for legal review?`,
      approve: `Approve "${s.name}" v${s.version}? This stamps your user id as the human reviewer.`,
      reject: `Reject "${s.name}" v${s.version}?`,
    };
    if (!confirm(labels[action])) return;
    setBusyId(s.id);
    try {
      await api(`/api/voice/scripts/${s.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aos-heading">Call Scripts</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Draft-first: only human-approved scripts can attach to a live session. This is the legal-review surface.
        </p>
      </div>
      <VoiceTabs active="scripts" />
      <Note>
        Every script opening must carry the <strong>AI-identity disclosure</strong>
        (e.g. “Hi, I&apos;m an AI assistant calling on behalf of Acme”). The session gate
        refuses to attach any script whose opening lacks it — approval does not waive this.
      </Note>

      <div className="flex flex-wrap items-center gap-2">
        <select className={inputCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["draft", "in_review", "approved", "rejected", "archived"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Script</th>
              <th className={thCls}>Agent</th>
              <th className={thCls}>Ver</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>
                <span className="inline-flex items-center gap-1">
                  <FileText className="h-3 w-3" /> AI disclosure
                </span>
              </th>
              <th className={thCls}>Approved by</th>
              <th className={thCls}>Sessions</th>
              <th className={thCls}>Review</th>
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
            {!loading && rows.length === 0 && (
              <tr className={rowCls}>
                <td className={tdCls} colSpan={8}>No scripts yet. Create drafts via the API or seed.</td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={s.id} className={rowCls}>
                <td className={`${tdCls} font-medium text-ink`}>{s.name}</td>
                <td className={tdCls}>{s.agentName}</td>
                <td className={tdCls}>v{s.version}</td>
                <td className={tdCls}><Chip tone={statusTone(s.status)}>{s.status}</Chip></td>
                <td className={tdCls}>
                  {s.hasDisclosure ? (
                    <span className="inline-flex items-center gap-1 text-ink">
                      <ShieldCheck className="h-4 w-4" />
                      <span className="text-[12px] font-medium">Present</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-failed-text">
                      <ShieldAlert className="h-4 w-4" />
                      <span className="text-[12px] font-medium">Missing — will be refused</span>
                    </span>
                  )}
                </td>
                <td className={tdCls}>
                  {s.approvedBy ? (
                    <span className="text-[12px]">
                      {s.approvedBy.slice(0, 24)}
                      {s.approvedAt ? ` · ${new Date(s.approvedAt).toLocaleDateString()}` : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={tdCls}>{s._count.sessions}</td>
                <td className={tdCls}>
                  <div className="flex gap-1.5">
                    {(s.status === "draft" || s.status === "rejected") && (
                      <button className={btnReview} disabled={busyId === s.id} onClick={() => act(s, "submit")}>
                        Submit
                      </button>
                    )}
                    {s.status === "in_review" && (
                      <>
                        <button className={btnApprove} disabled={busyId === s.id} onClick={() => act(s, "approve")}>
                          Approve
                        </button>
                        <button className={btnDanger} disabled={busyId === s.id} onClick={() => act(s, "reject")}>
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
