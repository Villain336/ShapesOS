// Marketr — Phase 13D: consent management client.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  api,
  Chip,
  statusTone,
  inputCls,
  btnGhost,
  tableCls,
  theadCls,
  thCls,
  rowCls,
  tdCls,
  VoiceTabs,
  Note,
} from "../_client";
import { confirmAction } from "@/lib/ui/feedback";

interface ConsentRow {
  id: string;
  leadId: string;
  channel: string;
  status: string;
  source: string | null;
  consentedAt: string | null;
  optedOutAt: string | null;
  lead: { name: string; email: string | null; phone: string | null };
}

export function ConsentApp() {
  const [rows, setRows] = useState<ConsentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fChannel, setFChannel] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fChannel) qs.set("channel", fChannel);
      if (fStatus) qs.set("status", fStatus);
      const r = await api<{ consent: ConsentRow[] }>(`/api/voice/consent?${qs.toString()}`);
      setRows(r.consent);
    } catch {
      /* keep previous */
    } finally {
      setLoading(false);
    }
  }, [fChannel, fStatus]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (r: ConsentRow, status: "opted_in" | "opted_out") => {
    const verb = status === "opted_in" ? "Opt in" : "Opt out";
    const ok = await confirmAction({
      title: `${verb} "${r.lead.name}" for ${r.channel}?`,
      description: "This is recorded as a manual consent review.",
      confirmLabel: verb,
      destructive: status === "opted_out",
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      await api("/api/voice/consent", {
        method: "POST",
        body: JSON.stringify({
          leadId: r.leadId,
          channel: r.channel,
          status,
          source: "manual_review",
        }),
      });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="aos-heading">Consent</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          Prior express consent per lead per channel. Outbound AI calls only to opted-in leads.
        </p>
      </div>
      <VoiceTabs active="consent" />
      <Note>
        <strong>No opted-in consent → no dial, always.</strong> Opting out takes effect immediately:
        any subsequent session request for that channel is refused with{" "}
        <code>consent_opted_out</code>.
      </Note>

      <div className="flex flex-wrap items-center gap-2">
        <select className={inputCls} value={fChannel} onChange={(e) => setFChannel(e.target.value)}>
          <option value="">All channels</option>
          {["voice", "sms", "chat"].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className={inputCls} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["opted_in", "opted_out", "pending", "unknown"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-md border border-line bg-paper">
        <table className={tableCls}>
          <thead className={theadCls}>
            <tr>
              <th className={thCls}>Lead</th>
              <th className={thCls}>Contact</th>
              <th className={thCls}>Channel</th>
              <th className={thCls}>Status</th>
              <th className={thCls}>Source</th>
              <th className={thCls}>Consented at</th>
              <th className={thCls}>Opted out at</th>
              <th className={thCls}>Manage</th>
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
                <td className={tdCls} colSpan={8}>No consent records.</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className={rowCls}>
                <td className={`${tdCls} font-medium text-ink`}>{r.lead.name}</td>
                <td className={tdCls}>{r.lead.phone ?? r.lead.email ?? "—"}</td>
                <td className={tdCls}><Chip tone="slate">{r.channel}</Chip></td>
                <td className={tdCls}><Chip tone={statusTone(r.status)}>{r.status}</Chip></td>
                <td className={tdCls}>{r.source ?? "—"}</td>
                <td className={tdCls}>
                  {r.consentedAt ? new Date(r.consentedAt).toLocaleString() : "—"}
                </td>
                <td className={tdCls}>
                  {r.optedOutAt ? new Date(r.optedOutAt).toLocaleString() : "—"}
                </td>
                <td className={tdCls}>
                  <div className="flex gap-1.5">
                    <button
                      className={btnGhost}
                      disabled={busyId === r.id || r.status === "opted_in"}
                      onClick={() => setStatus(r, "opted_in")}
                    >
                      Opt in
                    </button>
                    <button
                      className={btnGhost}
                      disabled={busyId === r.id || r.status === "opted_out"}
                      onClick={() => setStatus(r, "opted_out")}
                    >
                      Opt out
                    </button>
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
