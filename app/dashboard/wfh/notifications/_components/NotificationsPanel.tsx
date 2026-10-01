// Marketr — Wave 2 WFH mode slice 2: notifications panel (client).
// Digest window editor + live queue + a routing probe that shows whether a
// sample notification would deliver now or wait for a digest.

"use client";

import { useState } from "react";
import { Bell, BellOff, Loader2, Save, Zap } from "lucide-react";

interface QueuedItem {
  id: string;
  kind: string;
  title: string;
  windowMin: number;
  windowLabel: string;
  queuedAt: string;
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";
const labelCls = "block text-[12px] font-medium text-stone-600";

const PROBE_KINDS = [
  "approval_requested",
  "money_moved",
  "customer_message",
  "comment",
  "standup_reminder",
  "report_ready",
];

export default function NotificationsPanel({
  initialProfile,
  initialTimes,
  modeActive,
  setupDone,
  queued,
}: {
  initialProfile: string;
  initialTimes: number[];
  modeActive: boolean;
  setupDone: boolean;
  queued: QueuedItem[];
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [timesText, setTimesText] = useState(
    initialTimes.length > 0
      ? initialTimes
          .map((t) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`)
          .join(", ")
      : "09:00, 16:00",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [probeKind, setProbeKind] = useState("comment");
  const [probeResult, setProbeResult] = useState<string | null>(null);

  function parseTimes(text: string): number[] | null {
    const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
    const out: number[] = [];
    for (const p of parts) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(p);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
      out.push(h * 60 + mm);
    }
    return out;
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const times = parseTimes(timesText);
      if (!times || times.length === 0 || times.length > 6) {
        throw new Error("Digest times must be 1–6 times like 09:00, 16:00.");
      }
      const res = await fetch("/api/wfh/mode", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digestTimesMin: times, notificationProfile: profile }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function probe() {
    setBusy(true);
    setError(null);
    setProbeResult(null);
    try {
      const res = await fetch("/api/wfh/notifications/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: probeKind, title: `Probe: ${probeKind}` }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Probe failed");
      const d = data.decision;
      setProbeResult(
        d.deliver === "now"
          ? `Delivers now (${d.reason}).`
          : `Queued for the ${String(Math.floor(d.windowMin / 60)).padStart(2, "0")}:${String(d.windowMin % 60).padStart(2, "0")} digest (${d.reason}).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Probe failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {!setupDone && (
        <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[13px] text-stone-600">
          Finish the 60-second WFH setup on the Mode tab first — digest routing follows your
          notification profile.
        </div>
      )}

      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="text-[15px] font-semibold text-stone-900">Digest preferences</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelCls}>Notification profile</label>
            <div className="mt-1 flex gap-2">
              {(
                [
                  { v: "batched", label: "Batched digest", icon: BellOff },
                  { v: "realtime", label: "Realtime", icon: Bell },
                ] as const
              ).map((o) => {
                const Icon = o.icon;
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setProfile(o.v)}
                    className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium ${
                      profile === o.v
                        ? "border-[var(--brand-600)] bg-[var(--brand-50)] text-[var(--brand-700)]"
                        : "border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className={labelCls}>Digest windows (local time, comma-separated)</label>
            <input
              className={`${inputCls} mt-1 w-full`}
              value={timesText}
              onChange={(e) => setTimesText(e.target.value)}
              placeholder="09:00, 16:00"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={save} disabled={busy} className={btnPrimary}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save preferences
          </button>
          {saved && <span className="text-[13px] text-emerald-700">Saved.</span>}
        </div>
        {error && <p className="mt-2 text-[13px] text-red-700">{error}</p>}
        <p className="mt-2 text-[12px] text-stone-500">
          {modeActive
            ? "WFH mode is on: routine notifications batch into these windows."
            : "WFH mode is off: everything delivers in realtime until you turn it on."}
        </p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
          <Zap className="h-4 w-4 text-stone-400" /> Routing probe
        </h2>
        <p className="mt-0.5 text-[13px] text-stone-500">
          See how a notification kind routes under your current mode — no queue side effects
          beyond the probe item itself.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <select className={inputCls} value={probeKind} onChange={(e) => setProbeKind(e.target.value)}>
            {PROBE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button type="button" onClick={probe} disabled={busy} className={btnPrimary}>
            Probe routing
          </button>
        </div>
        {probeResult && <p className="mt-2 text-[13px] text-stone-700">{probeResult}</p>}
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-stone-900">
            Queued for digest <span className="font-normal text-stone-500">({queued.length})</span>
          </h2>
        </div>
        {queued.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-stone-500">
            Nothing waiting. Routine notifications will appear here while WFH mode batches them.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[12px] text-stone-500">
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Digest window</th>
                <th className="px-4 py-2 font-medium">Queued</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((q) => (
                <tr key={q.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-4 py-2 text-stone-900">{q.title}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex rounded-full border border-stone-200 bg-stone-100 px-1.5 py-0.5 text-[11px] font-medium text-stone-600">
                      {q.kind}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-stone-600">{q.windowLabel}</td>
                  <td className="px-4 py-2 text-stone-500">{new Date(q.queuedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
