// Marketr — Legal/Compliance slice 1: legal profile capture step (client).
// Onboarding for the obligation map: industry + business model + jurisdictions.
// Agentic OS: pills for pressables, black pill primary action, tokens only,
// Lucide icons only, sentence case.

"use client";

import { useState } from "react";
import { Loader2, MapPinned, TriangleAlert } from "lucide-react";

export interface ProfileDraft {
  industry: string;
  businessModel: string;
  jurisdictions: string[];
}

const INDUSTRY_OPTIONS = [
  { value: "food", label: "Food & beverage" },
  { value: "drones", label: "Drones" },
  { value: "saas", label: "SaaS / software" },
  { value: "services", label: "Services" },
];

const BUSINESS_MODEL_OPTIONS = [
  { value: "sole_proprietor", label: "Sole proprietorship" },
  { value: "llc", label: "LLC" },
  { value: "corporation", label: "Corporation" },
  { value: "partnership", label: "Partnership" },
];

const JURISDICTION_OPTIONS = [{ value: "NC", label: "North Carolina" }];

export function ProfileStep({
  initial,
  onSaved,
}: {
  initial: ProfileDraft | null;
  onSaved: (profile: ProfileDraft) => void;
}) {
  const [industry, setIndustry] = useState(initial?.industry ?? "");
  const [businessModel, setBusinessModel] = useState(initial?.businessModel ?? "");
  const [jurisdictions, setJurisdictions] = useState<string[]>(
    initial?.jurisdictions ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleJurisdiction(value: string) {
    setJurisdictions((cur) =>
      cur.includes(value) ? cur.filter((j) => j !== value) : [...cur, value],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!industry) {
      setError("Pick your industry so the map covers the right obligations.");
      return;
    }
    if (!businessModel) {
      setError("Pick your business model so the map fits how you operate.");
      return;
    }
    if (jurisdictions.length === 0) {
      setError("Pick at least one jurisdiction.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/legal/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ industry, businessModel, jurisdictions }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error ?? `Save failed (${res.status}).`);
      onSaved(json.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const pill = (active: boolean) =>
    `aos-press flex h-11 items-center rounded-full px-5 text-[0.875rem] font-semibold ${
      active ? "bg-black text-white" : "bg-paper text-ink shadow-hairline"
    }`;

  return (
    <form
      onSubmit={submit}
      className="flex max-w-2xl flex-col gap-6 rounded-lg bg-paper p-4 shadow-hairline md:p-6"
    >
      <div>
        <h2 className="aos-subheading">
          {initial ? "Update your legal profile" : "Set up your obligation map"}
        </h2>
        <p className="mt-1 text-sm text-muted">
          Your industry, business model, and jurisdictions decide which
          obligations appear. The map is computed for your business — nothing
          generic.
        </p>
      </div>

      <div>
        <p className="mb-2 text-[0.8125rem] font-semibold">Industry</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Industry">
          {INDUSTRY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={industry === o.value}
              onClick={() => setIndustry(o.value)}
              className={pill(industry === o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 text-[0.8125rem] font-semibold">Business model</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Business model">
          {BUSINESS_MODEL_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={businessModel === o.value}
              onClick={() => setBusinessModel(o.value)}
              className={pill(businessModel === o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[0.8125rem] font-semibold">
          <MapPinned size={14} />
          Jurisdictions
        </p>
        <div className="flex flex-wrap gap-2">
          {JURISDICTION_OPTIONS.map((o) => {
            const active = jurisdictions.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleJurisdiction(o.value)}
                className={pill(active)}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[0.8125rem] text-muted">
          The national baseline always applies on top of your jurisdictions.
        </p>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-[0.875rem] text-failed-text">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={busy}
          className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-6 text-[0.9375rem] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          {busy
            ? "Generating"
            : initial
              ? "Regenerate my obligation map"
              : "Generate my obligation map"}
        </button>
      </div>
    </form>
  );
}
