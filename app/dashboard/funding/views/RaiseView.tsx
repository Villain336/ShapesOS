// Marketr — Funding/VC slice 1: raise view (client).
// The founder's own raise workflow entry — the FRONT DOOR of the funding
// feature: target investor profile capture (check size, stages, sectors,
// thesis). Boardy is the accelerant; this profile is what he matches
// intros against. Agentic OS design system: inputs h-control, radius-md,
// 1.5px control border; primary action black pill.

"use client";

import { useState } from "react";
import { Loader2, Save } from "lucide-react";

export interface RoundView {
  id: string;
  name: string;
  status: string;
  isActive: boolean;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisSummary: string | null;
  targetClose: string | null;
}

const inputCls =
  "h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-[0.9375rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

const labelCls = "text-[0.8125rem] font-semibold text-ink";

function toInput(round: RoundView | null) {
  return {
    name: round?.name ?? "",
    checkSizeMin: round?.checkSizeMin != null ? String(round.checkSizeMin) : "",
    checkSizeMax: round?.checkSizeMax != null ? String(round.checkSizeMax) : "",
    stages: (round?.stages ?? []).join(", "),
    sectors: (round?.sectors ?? []).join(", "),
    thesisSummary: round?.thesisSummary ?? "",
  };
}

export function RaiseView({
  round,
  onSaved,
}: {
  round: RoundView | null;
  onSaved: (round: RoundView) => void;
}) {
  const [draft, setDraft] = useState(() => toInput(round));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = (k: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/funding/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name || undefined,
          checkSizeMin: draft.checkSizeMin ? Number(draft.checkSizeMin) : null,
          checkSizeMax: draft.checkSizeMax ? Number(draft.checkSizeMax) : null,
          stages: draft.stages.split(",").map((s) => s.trim()).filter(Boolean),
          sectors: draft.sectors.split(",").map((s) => s.trim()).filter(Boolean),
          thesisSummary: draft.thesisSummary || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save your raise profile.");
      onSaved(json.round);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your raise profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5 rounded-lg bg-paper p-4 shadow-hairline md:p-6">
      <div>
        <h2 className="text-[1.125rem] font-bold text-ink" style={{ fontStretch: "115%" }}>
          Your raise
        </h2>
        <p className="mt-1 text-sm text-muted">
          The front door of your funding workflow. Capture your target investor
          profile — Boardy matches intros against exactly this.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="raise-name" className={labelCls}>
          Round name
        </label>
        <input
          id="raise-name"
          className={inputCls}
          placeholder="Seed round"
          value={draft.name}
          onChange={set("name")}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="raise-min" className={labelCls}>
            Min check size (USD)
          </label>
          <input
            id="raise-min"
            className={inputCls}
            inputMode="numeric"
            placeholder="25000"
            value={draft.checkSizeMin}
            onChange={set("checkSizeMin")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="raise-max" className={labelCls}>
            Max check size (USD)
          </label>
          <input
            id="raise-max"
            className={inputCls}
            inputMode="numeric"
            placeholder="250000"
            value={draft.checkSizeMax}
            onChange={set("checkSizeMax")}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="raise-stages" className={labelCls}>
            Stages
          </label>
          <input
            id="raise-stages"
            className={inputCls}
            placeholder="pre-seed, seed"
            value={draft.stages}
            onChange={set("stages")}
          />
          <p className="text-[0.8125rem] text-muted">Comma-separated.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="raise-sectors" className={labelCls}>
            Sectors / thesis areas
          </label>
          <input
            id="raise-sectors"
            className={inputCls}
            placeholder="fintech, dev-tools"
            value={draft.sectors}
            onChange={set("sectors")}
          />
          <p className="text-[0.8125rem] text-muted">Comma-separated.</p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="raise-thesis" className={labelCls}>
          Thesis summary
        </label>
        <textarea
          id="raise-thesis"
          className={`${inputCls} min-h-24 py-2.5`}
          placeholder="What you are building, for whom, and why now — in your own words."
          value={draft.thesisSummary}
          onChange={set("thesisSummary")}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
          <span aria-hidden className="mt-0.5 inline-block h-2.5 w-2.5 bg-failed" />
          {error}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="aos-press inline-flex h-control items-center gap-2 rounded-full bg-black px-6 text-[0.9375rem] font-semibold text-white disabled:opacity-40"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          {saving ? "Saving" : "Save raise profile"}
        </button>
      </div>
    </div>
  );
}
