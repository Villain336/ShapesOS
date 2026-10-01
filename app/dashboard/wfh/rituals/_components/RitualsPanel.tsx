// Marketr — Wave 2 WFH mode slice 5: rituals panel (client).
// Ritual cards with subscribe/participate, dead-ritual warnings with retire,
// and a create form seeded from the ritual-type presets.

"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, AlertTriangle } from "lucide-react";

interface RitualHealth {
  dead: boolean;
  reason: string | null;
  suggestion: string | null;
}

interface Ritual {
  id: string;
  type: string;
  meta: { name: string; description: string; prompt: string } | null;
  title: string;
  description: string;
  cadence: string;
  anchorDate: string;
  active: boolean;
  subscriberCount: number;
  subscribed: boolean;
  nextOccurrence: string;
  participations: { userId: string; note: string | null; occurredAt: string }[];
  health: RitualHealth;
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

const PRESETS = [
  { type: "wins", label: "Wins" },
  { type: "kudos", label: "Kudos" },
  { type: "virtual-coffee", label: "Virtual coffee" },
  { type: "demo-friday", label: "Demo Friday" },
];

export default function RitualsPanel() {
  const [rituals, setRituals] = useState<Ritual[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [newType, setNewType] = useState("wins");
  const [newCadence, setNewCadence] = useState("weekly");
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});

  async function reload() {
    const res = await fetch("/api/wfh/rituals");
    if (res.ok) {
      const data = await res.json();
      setRituals(data.rituals);
    }
    setLoaded(true);
  }

  useEffect(() => {
    reload();
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/wfh/rituals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType, cadence: newCadence }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.details?.length ? data.details.join(" ") : (data.error ?? "Create failed"));
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleSubscribe(r: Ritual) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/rituals/${r.id}/subscribe`, {
        method: r.subscribed ? "DELETE" : "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Subscription failed");
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Subscription failed");
    } finally {
      setBusy(false);
    }
  }

  async function participate(r: Ritual) {
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/rituals/${r.id}/participate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: noteDrafts[r.id] || null }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Participation failed");
      }
      setNoteDrafts((d) => ({ ...d, [r.id]: "" }));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Participation failed");
    } finally {
      setBusy(false);
    }
  }

  async function retire(r: Ritual) {
    if (!window.confirm(`Retire "${r.title}"? The team can reactivate it later.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/wfh/rituals/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Retire failed");
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retire failed");
    } finally {
      setBusy(false);
    }
  }

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-stone-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading rituals…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* Create */}
      <div className="rounded-lg border border-stone-200 bg-white px-4 py-4">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-stone-900">
          <Plus className="h-4 w-4" /> Start a ritual
        </h2>
        <div className="mt-3 flex flex-wrap gap-2">
          <div>
            <label className={labelCls}>Type</label>
            <select className={`${inputCls} mt-1`} value={newType} onChange={(e) => setNewType(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.type} value={p.type}>{p.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Cadence</label>
            <select className={`${inputCls} mt-1`} value={newCadence} onChange={(e) => setNewCadence(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Every two weeks</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
        </div>
        <button type="button" onClick={create} disabled={busy} className={`${btnPrimary} mt-3`}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Start ritual
        </button>
      </div>

      {/* Rituals */}
      {rituals.length === 0 ? (
        <p className="rounded-lg border border-stone-200 bg-white px-4 py-6 text-center text-[13px] text-stone-500">
          No rituals yet. Start one above — wins and kudos are the cheapest culture wins there are.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {rituals.map((r) => (
            <div key={r.id} className={`rounded-lg border border-stone-200 bg-white px-4 py-4 ${r.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-[15px] font-semibold text-stone-900">{r.title}</h3>
                  <p className="mt-0.5 text-[13px] text-stone-500">{r.description}</p>
                </div>
                <span className={`${chip} ${r.active ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-stone-100 text-stone-500"}`}>
                  {r.active ? r.cadence : "retired"}
                </span>
              </div>

              {r.health.dead && r.active && (
                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                  <p className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle className="h-3.5 w-3.5" /> This ritual looks dead: {r.health.reason}
                  </p>
                  {r.health.suggestion && <p className="mt-0.5">{r.health.suggestion}</p>}
                </div>
              )}

              <div className="mt-2 flex items-center gap-3 text-[12px] text-stone-500">
                <span>{r.subscriberCount} subscribed</span>
                <span>{r.participations.length} recent participations</span>
                {r.active && <span>Next: {fmtDate(r.nextOccurrence)}</span>}
              </div>

              {r.meta?.prompt && (
                <p className="mt-2 text-[13px] italic text-stone-600">“{r.meta.prompt}”</p>
              )}

              {r.active && (
                <div className="mt-3">
                  <div className="flex gap-2">
                    <input
                      className={`${inputCls} flex-1`}
                      value={noteDrafts[r.id] ?? ""}
                      onChange={(e) => setNoteDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                      placeholder="What did you share? (optional)"
                    />
                    <button type="button" onClick={() => participate(r)} disabled={busy} className={btnPrimary}>
                      I joined
                    </button>
                    <button type="button" onClick={() => toggleSubscribe(r)} disabled={busy} className={btnGhost}>
                      {r.subscribed ? "Unsubscribe" : "Subscribe"}
                    </button>
                  </div>
                  {r.health.dead && (
                    <button type="button" onClick={() => retire(r)} disabled={busy} className={`${btnGhost} mt-2 text-red-700`}>
                      Retire this ritual
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
