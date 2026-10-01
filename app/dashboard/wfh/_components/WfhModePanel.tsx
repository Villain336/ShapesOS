// Marketr — Wave 2 WFH mode slice 1: mode toggle + setup interstitial (client).

"use client";

import { useState } from "react";
import { Home, Building2, Loader2, Check, Clock } from "lucide-react";

export interface WfhInitial {
  mode: string;
  wfhDays: string[];
  focusStartMin: number;
  focusEndMin: number;
  focusBlockMinutes: number;
  standupCadence: string;
  notificationProfile: string;
  setupCompletedAt: string | null;
  indicator: { active: boolean; label: string; tone: string };
}

interface HistoryEntry {
  id: string;
  previousMode: string;
  newMode: string;
  reason: string;
  createdAt: string;
}

const DAYS = [
  { code: "mon", label: "Mon" },
  { code: "tue", label: "Tue" },
  { code: "wed", label: "Wed" },
  { code: "thu", label: "Thu" },
  { code: "fri", label: "Fri" },
  { code: "sat", label: "Sat" },
  { code: "sun", label: "Sun" },
];

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const labelCls = "block text-xs font-semibold text-muted";
// All workflow states render neutral: mode, day-selection and history states
// are workflow states, not agent states, so they never take a status color.
const chip =
  "h-chip inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-4 text-sm font-semibold text-muted shadow-control";
const chipPressed =
  "h-chip inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white shadow-control";

function fmtMin(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseTime(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 24 || mm < 0 || mm > 59 || (h === 24 && mm !== 0)) return null;
  return h * 60 + mm;
}

export default function WfhModePanel({
  initial,
  history,
}: {
  initial: WfhInitial | null;
  history: HistoryEntry[];
}) {
  const [mode, setMode] = useState<WfhInitial | null>(initial);
  const [hist, setHist] = useState(history);
  const [showSetup, setShowSetup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Setup interstitial form state.
  const [setupMode, setSetupMode] = useState<"wfh" | "hybrid">("wfh");
  const [days, setDays] = useState<string[]>(["mon", "tue", "wed", "thu", "fri"]);
  const [focusStart, setFocusStart] = useState("09:00");
  const [focusEnd, setFocusEnd] = useState("17:00");
  const [blockMin, setBlockMin] = useState("90");
  const [cadence, setCadence] = useState("daily");
  const [profile, setProfile] = useState("batched");

  const active = mode?.indicator.active ?? false;

  function toggleDay(code: string) {
    setDays((d) => (d.includes(code) ? d.filter((x) => x !== code) : [...d, code]));
  }

  async function refresh() {
    const res = await fetch("/api/wfh/mode");
    if (res.ok) {
      const data = await res.json();
      const row = data.mode;
      setMode(
        row
          ? {
              mode: row.mode,
              wfhDays: row.wfhDays,
              focusStartMin: row.focusStartMin,
              focusEndMin: row.focusEndMin,
              focusBlockMinutes: row.focusBlockMinutes,
              standupCadence: row.standupCadence,
              notificationProfile: row.notificationProfile,
              setupCompletedAt: row.setupCompletedAt,
              indicator: data.indicator,
            }
          : null,
      );
    }
  }

  async function doToggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle" }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === "SETUP_REQUIRED") {
          setShowSetup(true);
          return;
        }
        throw new Error(data.error ?? "Toggle failed");
      }
      await refresh();
      setHist((h) => [
        {
          id: `local-${Date.now()}`,
          previousMode: active ? "wfh" : "office",
          newMode: active ? "office" : "wfh",
          reason: "user_toggle",
          createdAt: new Date().toISOString(),
        },
        ...h,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitSetup() {
    setBusy(true);
    setError(null);
    try {
      const startMin = parseTime(focusStart);
      const endMin = parseTime(focusEnd);
      const res = await fetch("/api/wfh/mode/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: setupMode,
          wfhDays: days,
          focusStartMin: startMin,
          focusEndMin: endMin,
          focusBlockMinutes: parseInt(blockMin, 10),
          standupCadence: cadence,
          notificationProfile: profile,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.details?.length ? data.details.join(" ") : (data.error ?? "Setup failed"),
        );
      }
      setShowSetup(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Mode indicator + toggle */}
      <div className="flex items-center justify-between gap-4 rounded-lg bg-paper px-4 py-3 shadow-hairline">
        <div className="flex items-center gap-3">
          <span className={chip} aria-live="polite">
            {active ? <Home className="h-3.5 w-3.5 text-ink" /> : <Building2 className="h-3.5 w-3.5 text-muted" />}
            {mode?.indicator.label ?? "Office mode"}
          </span>
          <p className="text-sm text-muted">
            {active
              ? "Async-first notifications, protected focus time, and rituals are on."
              : "Office defaults are on. Flip the switch to reconfigure the OS for remote work."}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2.5">
          <label htmlFor="wfh-mode-switch" className="text-sm font-semibold text-ink">
            WFH mode
          </label>
          <button
            type="button"
            role="switch"
            id="wfh-mode-switch"
            aria-checked={active}
            onClick={doToggle}
            disabled={busy}
            className={`relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full px-[3px] transition-colors ${
              active ? "bg-ink" : "bg-disabled-fg"
            } disabled:opacity-40`}
          >
            <span
              className={`block h-5 w-5 rounded-full bg-paper transition-transform ${
                active ? "translate-x-[18px]" : "translate-x-0"
              }`}
            />
          </button>
        </span>
      </div>

      {error && (
        <div
          className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
          role="alert"
        >
          <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {/* Current preferences summary */}
      {mode && mode.setupCompletedAt && (
        <div className="rounded-lg bg-paper px-4 py-3 shadow-hairline">
          <p className="text-xs font-semibold text-muted">Your WFH setup</p>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink">
            <span>
              <span className="text-muted">Days:</span>{" "}
              {mode.mode === "hybrid" ? mode.wfhDays.join(", ") || "—" : "every day"}
            </span>
            <span>
              <span className="text-muted">Focus hours:</span> {fmtMin(mode.focusStartMin)}–
              {fmtMin(mode.focusEndMin)}
            </span>
            <span>
              <span className="text-muted">Focus blocks:</span> {mode.focusBlockMinutes} min
            </span>
            <span>
              <span className="text-muted">Standups:</span> {mode.standupCadence}
            </span>
            <span>
              <span className="text-muted">Notifications:</span>{" "}
              {mode.notificationProfile === "batched" ? "batched digest" : "realtime"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowSetup(true)}
            className={`${btnGhost} mt-2`}
            disabled={busy}
          >
            Edit setup
          </button>
        </div>
      )}

      {/* Setup interstitial */}
      {showSetup && (
        <div className="rounded-lg bg-paper px-4 py-4 shadow-hairline">
          <h2 className="aos-subheading">60-second WFH setup</h2>
          <p className="mt-0.5 text-sm text-muted">
            Turning WFH mode on changes how the OS treats your time. Set your defaults once —
            everything below stays reversible in one tap.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className={labelCls}>Mode</label>
              <div className="mt-1 flex gap-2">
                {(["wfh", "hybrid"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setSetupMode(m)}
                    aria-pressed={setupMode === m}
                    className={`${setupMode === m ? chipPressed : chip} aos-press`}
                  >
                    {m === "wfh" ? "Fully remote" : "Hybrid"}
                  </button>
                ))}
              </div>
              {setupMode === "hybrid" && (
                <div className="mt-2">
                  <label className={labelCls}>WFH days</label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {DAYS.map((d) => (
                      <button
                        key={d.code}
                        type="button"
                        onClick={() => toggleDay(d.code)}
                        aria-pressed={days.includes(d.code)}
                        className={`${days.includes(d.code) ? chipPressed : chip} aos-press`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Focus start</label>
                <input
                  className={`${inputCls} mt-1 w-full`}
                  value={focusStart}
                  onChange={(e) => setFocusStart(e.target.value)}
                  placeholder="09:00"
                />
              </div>
              <div>
                <label className={labelCls}>Focus end</label>
                <input
                  className={`${inputCls} mt-1 w-full`}
                  value={focusEnd}
                  onChange={(e) => setFocusEnd(e.target.value)}
                  placeholder="17:00"
                />
              </div>
              <div>
                <label className={labelCls}>Block (min)</label>
                <input
                  className={`${inputCls} mt-1 w-full`}
                  value={blockMin}
                  onChange={(e) => setBlockMin(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>
            <div>
              <label className={labelCls}>Standup cadence</label>
              <select className={`${inputCls} mt-1 w-full`} value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value="daily">Daily async standup</option>
                <option value="none">No standups</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Notifications</label>
              <select className={`${inputCls} mt-1 w-full`} value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="batched">Batched digest (async-first)</option>
                <option value="realtime">Realtime</option>
              </select>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button type="button" onClick={submitSetup} disabled={busy} className={btnPrimary}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save and turn on WFH mode
            </button>
            <button type="button" onClick={() => setShowSetup(false)} className={btnGhost} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Mode history (dense table, preference-learning feed) */}
      {hist.length > 0 && (
        <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Clock className="h-4 w-4 text-muted" />
            <h2 className="text-sm font-semibold text-ink">Mode history</h2>
            <span className="text-xs text-muted">— the OS learns your preferences from this</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {hist.map((h) => (
                <tr key={h.id} className="border-b border-line hover:bg-hover-paper">
                  <td className="px-4 py-2 text-muted">
                    {new Date(h.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <span className={chip}>{h.previousMode}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={chip}>{h.newMode}</span>
                  </td>
                  <td className="px-4 py-2 text-muted">{h.reason.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
