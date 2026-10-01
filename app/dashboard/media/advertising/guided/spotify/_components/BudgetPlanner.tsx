// Marketr — Phase 18 slice 5: audience/geo/budget planner.
//
// The $250 Ad Studio minimum is enforced as a planner floor: plans below it
// are flagged, never silently accepted. Audience fields are a planning
// worksheet persisted locally; budget math comes from planSpotifyBudget().

"use client";

import { useEffect, useState } from "react";
import { Calculator, Loader2, TriangleAlert, CircleCheck } from "lucide-react";
import {
  SpotifyGuidedError,
  SPOTIFY_MIN_BUDGET_USD,
  planSpotifyBudget,
  type SpotifyBudgetPlan,
} from "@/lib/adplatforms/spotify/planning";

const STORAGE_PREFIX = "marketr-spotify-planner:";

const WORKSHEET_FIELDS = [
  { id: "locations", label: "Locations", placeholder: "e.g. United States — Southeast; Raleigh-Durham DMA" },
  { id: "demographics", label: "Age & gender", placeholder: "e.g. 25–44, all genders" },
  { id: "interests", label: "Interests & genres", placeholder: "e.g. indie rock, true-crime podcasts, fitness" },
  { id: "context", label: "Listening context", placeholder: "e.g. morning commute, workout, work-from-home focus" },
] as const;

export default function BudgetPlanner() {
  const [budget, setBudget] = useState("250");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [worksheet, setWorksheet] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<SpotifyBudgetPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + "worksheet");
      if (raw) setWorksheet(JSON.parse(raw) as Record<string, string>);
    } catch {
      // Corrupt storage is not worth an error UI.
    }
  }, []);

  function setField(id: string, value: string) {
    setWorksheet((prev) => {
      const next = { ...prev, [id]: value };
      try {
        localStorage.setItem(STORAGE_PREFIX + "worksheet", JSON.stringify(next));
      } catch {
        // Storage may be unavailable; the input still works.
      }
      return next;
    });
  }

  function check() {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      const budgetUsd = Number(budget);
      setPlan(
        planSpotifyBudget({
          budgetUsd,
          startDate: start.trim() || undefined,
          endDate: end.trim() || undefined,
        }),
      );
    } catch (e) {
      setError(
        e instanceof SpotifyGuidedError ? e.message : "Could not check the plan",
      );
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "rounded-md border border-stone-300 px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-3 py-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Lifetime budget (USD)
          <input
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="decimal"
            placeholder="250.00"
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Flight start (optional)
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-stone-600">
          Flight end (optional)
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {WORKSHEET_FIELDS.map((f) => (
          <label key={f.id} className="flex flex-col gap-1 text-[12px] text-stone-600">
            {f.label}
            <input
              value={worksheet[f.id] ?? ""}
              onChange={(e) => setField(f.id, e.target.value)}
              placeholder={f.placeholder}
              className={inputCls}
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={check}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
          {busy ? "Checking…" : "Check plan"}
        </button>
        <span className="text-[11px] text-stone-400">
          Ad Studio minimum: ${SPOTIFY_MIN_BUDGET_USD} lifetime budget
        </span>
      </div>
      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>
      )}
      {plan && (
        <div
          className={`rounded-lg border px-3 py-2 ${
            plan.ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
          }`}
        >
          <p
            className={`flex items-center gap-1.5 text-[13px] font-medium ${
              plan.ok ? "text-emerald-800" : "text-amber-800"
            }`}
          >
            {plan.ok ? <CircleCheck className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
            {plan.ok
              ? "Plan meets the Ad Studio minimum"
              : `Below the $${SPOTIFY_MIN_BUDGET_USD} minimum — this plan cannot launch as-is`}
          </p>
          <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[12px] text-stone-600">
            {plan.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
