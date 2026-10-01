// Marketr — Wave 2 WFH mode slice 3: focus panel (client).
// Create blocks, preview conflicts against a manual event list, enforce
// protection, and manage the one-time auto-decline consent.

"use client";

import { useState } from "react";
import { Loader2, Plus, ShieldCheck, ShieldAlert, CalendarClock } from "lucide-react";

interface FocusBlock {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  recurrence: string;
  protection: string;
  source: string;
  status: string;
  defendedEventIds: string[];
}

interface Connection {
  provider: string;
  status: string;
  autoDeclineConsentAt: string | null;
}

interface ManualEvent {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
}

interface EnforcementView {
  conflicts: { eventId: string; title: string; overlapMin: number }[];
  suggestions: { eventId: string; title: string; suggestedStartAt: string; suggestedEndAt: string }[];
  autoDeclined: string[];
  note: string;
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
const labelCls = "block text-[12px] font-medium text-stone-600";
const chip =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight";

function fmtDT(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FocusPanel({
  initialBlocks,
  connections,
}: {
  initialBlocks: FocusBlock[];
  connections: Connection[];
}) {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [conns, setConns] = useState(connections);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form.
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("11:00");
  const [recurrence, setRecurrence] = useState("none");
  const [protection, setProtection] = useState("soft");

  // Manual event list for conflict checks (calendar-lite).
  const [events, setEvents] = useState<ManualEvent[]>([]);
  const [evTitle, setEvTitle] = useState("");
  const [evStart, setEvStart] = useState("");
  const [evEnd, setEvEnd] = useState("");

  const [enforcement, setEnforcement] = useState<{ blockId: string; result: EnforcementView } | null>(null);

  const googleConn = conns.find((c) => c.provider === "google");
  const consented = !!googleConn?.autoDeclineConsentAt;

  async function reload() {
    const res = await fetch("/api/wfh/focus");
    if (res.ok) {
      const data = await res.json();
      setBlocks(data.blocks);
    }
    const cres = await fetch("/api/wfh/calendar/consent");
    if (cres.ok) {
      const data = await cres.json();
      setConns(data.connections);
    }
  }

  async function createBlock() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          startAt: new Date(`${date}T${start}`).toISOString(),
          endAt: new Date(`${date}T${end}`).toISOString(),
          recurrence,
          protection,
          source: "user",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.length ? data.details.join(" ") : (data.error ?? "Create failed"));
      }
      setTitle("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  function addEvent() {
    if (!evTitle.trim() || !evStart || !evEnd) return;
    setEvents((evs) => [...evs, { id: `manual-${Date.now()}`, title: evTitle.trim(), startAt: evStart, endAt: evEnd }]);
    setEvTitle("");
    setEvStart("");
    setEvEnd("");
  }

  async function enforce(id: string) {
    setBusy(true);
    setError(null);
    setEnforcement(null);
    try {
      const res = await fetch(`/api/wfh/focus/${id}/enforce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          events: events.map((e) => ({
            id: e.id,
            title: e.title,
            startAt: new Date(e.startAt).toISOString(),
            endAt: new Date(e.endAt).toISOString(),
          })),
          provider: "google",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Enforce failed");
      setEnforcement({ blockId: id, result: data.enforcement });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enforce failed");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: string, status: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/wfh/focus/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function grantConsent() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/calendar/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Consent failed");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Consent failed");
    } finally {
      setBusy(false);
    }
  }

  function statusChip(status: string) {
    if (status === "protected")
      return <span className={`${chip} border-emerald-200 bg-emerald-50 text-emerald-700`}>protected</span>;
    if (status === "overridden")
      return <span className={`${chip} border-amber-200 bg-amber-50 text-amber-700`}>overridden</span>;
    if (status === "completed")
      return <span className={`${chip} border-stone-200 bg-stone-100 text-stone-600`}>completed</span>;
    if (status === "cancelled")
      return <span className={`${chip} border-stone-200 bg-stone-100 text-stone-500`}>cancelled</span>;
    return <span className={`${chip} border-[var(--brand-600)]/20 bg-[var(--brand-50)] text-[var(--brand-700)]`}>scheduled</span>;
  }

  return (
    <div className="space-y-4">
      {/* Consent gate banner */}
      <div className="flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5">
        <p className="flex items-center gap-2 text-[13px] text-stone-600">
          {consented ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-600" />
          )}
          {consented
            ? "Auto-decline consent recorded. Hard-protected blocks may decline meetings on your behalf once a calendar is connected."
            : "Hard protection needs your one-time consent before the OS may decline meetings on your behalf."}
        </p>
        {!consented && (
          <button type="button" onClick={grantConsent} disabled={busy} className={btnGhost}>
            Grant auto-decline consent
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Create form */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
          <Plus className="h-4 w-4" /> New focus block
        </h2>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="md:col-span-3">
            <label className={labelCls}>Title</label>
            <input className={`${inputCls} mt-1 w-full`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deep work — Q3 plan" />
          </div>
          <div>
            <label className={labelCls}>Date</label>
            <input type="date" className={`${inputCls} mt-1 w-full`} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Start</label>
            <input type="time" className={`${inputCls} mt-1 w-full`} value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>End</label>
            <input type="time" className={`${inputCls} mt-1 w-full`} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Repeats</label>
            <select className={`${inputCls} mt-1 w-full`} value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Protection</label>
            <select className={`${inputCls} mt-1 w-full`} value={protection} onChange={(e) => setProtection(e.target.value)}>
              <option value="soft">Soft — suggest new times</option>
              <option value="hard">Hard — auto-decline (consent-gated)</option>
            </select>
          </div>
        </div>
        <button type="button" onClick={createBlock} disabled={busy || !title.trim()} className={`${btnPrimary} mt-3`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Create block
        </button>
      </div>

      {/* Manual event list (calendar-lite conflict source) */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
          <CalendarClock className="h-4 w-4" /> Calendar events (manual)
        </h2>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Live calendar sync arrives with the calendar integration. Until then, add the events
          on your calendar to preview conflicts.
        </p>
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <input className={inputCls} value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="Event title" />
          <input type="datetime-local" className={inputCls} value={evStart} onChange={(e) => setEvStart(e.target.value)} />
          <input type="datetime-local" className={inputCls} value={evEnd} onChange={(e) => setEvEnd(e.target.value)} />
          <button type="button" onClick={addEvent} className={btnGhost}>Add event</button>
        </div>
        {events.length > 0 && (
          <ul className="mt-2 space-y-1">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between text-[13px] text-stone-700">
                <span>{e.title} · {fmtDT(new Date(e.startAt).toISOString())} → {fmtDT(new Date(e.endAt).toISOString())}</span>
                <button type="button" onClick={() => setEvents((evs) => evs.filter((x) => x.id !== e.id))} className="text-stone-400 hover:text-stone-600">Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Blocks table */}
      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold text-stone-900">
            Focus blocks <span className="font-normal text-stone-500">({blocks.length})</span>
          </h2>
        </div>
        {blocks.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-stone-500">
            No focus blocks yet. Create one above — the OS will defend it.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[12px] text-stone-500">
                <th className="px-4 py-2 font-medium">Block</th>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Protection</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <tr key={b.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-4 py-2 font-medium text-stone-900">
                    {b.title}
                    {b.recurrence !== "none" && <span className="ml-2 text-[11px] font-normal text-stone-500">· {b.recurrence}</span>}
                  </td>
                  <td className="px-4 py-2 text-stone-600">{fmtDT(b.startAt)} → {fmtDT(b.endAt)}</td>
                  <td className="px-4 py-2">
                    <span className={`${chip} ${b.protection === "hard" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-stone-200 bg-stone-100 text-stone-600"}`}>
                      {b.protection}
                    </span>
                  </td>
                  <td className="px-4 py-2">{statusChip(b.status)}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {(b.status === "scheduled" || b.status === "overridden") && (
                        <button type="button" onClick={() => enforce(b.id)} disabled={busy} className={btnGhost}>Enforce</button>
                      )}
                      {b.status === "protected" && (
                        <button type="button" onClick={() => setStatus(b.id, "overridden")} disabled={busy} className={btnGhost}>Override</button>
                      )}
                      {(b.status === "scheduled" || b.status === "protected" || b.status === "overridden") && (
                        <button type="button" onClick={() => setStatus(b.id, "cancelled")} disabled={busy} className={btnGhost}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Enforcement result */}
      {enforcement && (
        <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
          <h2 className="text-[15px] font-semibold text-stone-900">Enforcement result</h2>
          <p className="mt-1 text-[13px] text-stone-600">{enforcement.result.note}</p>
          {enforcement.result.conflicts.length > 0 && (
            <div className="mt-2">
              <p className="text-[12px] font-medium text-stone-600">Conflicts</p>
              <ul className="mt-1 space-y-1 text-[13px] text-stone-700">
                {enforcement.result.conflicts.map((c) => (
                  <li key={c.eventId}>· {c.title} ({c.overlapMin} min overlap)</li>
                ))}
              </ul>
            </div>
          )}
          {enforcement.result.suggestions.length > 0 && (
            <div className="mt-2">
              <p className="text-[12px] font-medium text-stone-600">Suggested new times (soft protection)</p>
              <ul className="mt-1 space-y-1 text-[13px] text-stone-700">
                {enforcement.result.suggestions.map((s) => (
                  <li key={s.eventId}>· {s.title} → {fmtDT(s.suggestedStartAt)} – {fmtDT(s.suggestedEndAt)}</li>
                ))}
              </ul>
            </div>
          )}
          {enforcement.result.autoDeclined.length > 0 && (
            <p className="mt-2 text-[13px] text-amber-700">
              {enforcement.result.autoDeclined.length} event(s) marked pending auto-decline — the
              live decline sends when the calendar rail connects.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
