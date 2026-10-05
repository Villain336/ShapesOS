// ShapesOS — Phase 16: Settings → Automation → Automatic delegation.
// The switch that lets the lead split big work across sub-agents running in
// parallel, and the limits that bound it (enforced in code; the server
// bounds every value). Agentic OS kit: SwitchRow, Field, black pill save.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Info, Loader2, Save } from "lucide-react";
import { Field, SwitchRow } from "@/components/aos/Controls";
import { aosButton } from "@/components/aos/button";

type LimitKey = "maxParallelPerRun" | "maxLivePerWorkspace" | "maxWidth" | "maxDepth";

interface Payload {
  autoDelegation: boolean;
  limits: Record<LimitKey, number>;
  stored: Record<LimitKey, number | null>;
  defaults: Record<LimitKey, number>;
  bounds: Record<LimitKey, [number, number]>;
}

const FIELDS: Array<{ key: LimitKey; label: string; helper: string }> = [
  { key: "maxParallelPerRun", label: "Sub-agents at once per task", helper: "How many sub-agents one task may run side by side." },
  { key: "maxLivePerWorkspace", label: "Sub-agents at once in this workspace", helper: "Across every task; the rest wait for a free slot." },
  { key: "maxWidth", label: "Sub-agents per plan", helper: "The most tasks one plan may hand out." },
  { key: "maxDepth", label: "Levels of hand-off", helper: "2 lets a sub-agent hand work down once more, only when given that tool." },
];

export default function DelegationSettingsForm() {
  const [data, setData] = useState<Payload | null>(null);
  const [auto, setAuto] = useState(true);
  const [values, setValues] = useState<Record<LimitKey, string>>({ maxParallelPerRun: "", maxLivePerWorkspace: "", maxWidth: "", maxDepth: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((p: Payload) => {
    setData(p);
    setAuto(p.autoDelegation);
    setValues({
      maxParallelPerRun: p.stored.maxParallelPerRun === null ? "" : String(p.stored.maxParallelPerRun),
      maxLivePerWorkspace: p.stored.maxLivePerWorkspace === null ? "" : String(p.stored.maxLivePerWorkspace),
      maxWidth: p.stored.maxWidth === null ? "" : String(p.stored.maxWidth),
      maxDepth: p.stored.maxDepth === null ? "" : String(p.stored.maxDepth),
    });
  }, []);

  useEffect(() => {
    void fetch("/api/agents/delegation-settings", { cache: "no-store" })
      .then(async (r) => (r.ok ? apply((await r.json()) as Payload) : setError("Couldn't load the delegation settings.")))
      .catch(() => setError("Couldn't load the delegation settings."));
  }, [apply]);

  const fieldError = (k: LimitKey): string | null => {
    const v = values[k].trim();
    if (!v || !data) return null;
    const n = Number(v);
    const [lo, hi] = data.bounds[k];
    return Number.isInteger(n) && n >= lo && n <= hi ? null : `Use a whole number from ${lo} to ${hi}.`;
  };
  const invalid = FIELDS.some((f) => fieldError(f.key));

  const save = async () => {
    if (!data || invalid) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    const body: Record<string, unknown> = { autoDelegation: auto };
    for (const f of FIELDS) body[f.key] = values[f.key].trim() ? Number(values[f.key]) : null;
    try {
      const res = await fetch("/api/agents/delegation-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Payload & { error?: string };
      if (!res.ok) setError(json.error ?? "Couldn't save the delegation settings.");
      else {
        apply(json);
        setSaved(true);
      }
    } catch {
      setError("Couldn't save the delegation settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="delegation-settings-heading">
      <div>
        <h2 id="delegation-settings-heading" className="aos-subheading">
          Automatic delegation
        </h2>
        <p className="mt-0.5 text-sm text-muted">
          The lead can split big work into tasks for sub-agents that run in parallel, each with its own brief, tools and share of the budget.
        </p>
      </div>
      {!data && !error ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="aos-spin" aria-hidden />
          Loading delegation settings…
        </div>
      ) : null}
      {data ? (
        <div className="overflow-hidden rounded-lg border border-line bg-paper">
          <SwitchRow
            title="Automatic delegation"
            description={auto ? "On: the lead decides when work is big enough to split." : "Off: the lead hands work over only one task at a time."}
            checked={auto}
            onChange={(v) => {
              setAuto(v);
              setSaved(false);
            }}
          />
          <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                type="number"
                inputMode="numeric"
                min={data.bounds[f.key][0]}
                max={data.bounds[f.key][1]}
                placeholder={`Default ${data.defaults[f.key]}`}
                value={values[f.key]}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [f.key]: e.target.value }));
                  setSaved(false);
                }}
                helper={`${f.helper} In force: ${data.limits[f.key]}.`}
                error={fieldError(f.key)}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
            <div className="flex min-w-0 flex-1 items-start gap-2 text-sm text-muted">
              <Info size={16} className="mt-0.5 shrink-0 text-subtle" aria-hidden />
              Every sub-agent follows your auto-approve rules for its own agent. Money and irreversible actions always ask, in every sub-agent.
            </div>
            {saved ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted">
                <Check size={15} className="text-ink" aria-hidden />
                Saved
              </span>
            ) : null}
            <button type="button" onClick={() => void save()} disabled={saving || invalid} className={aosButton({ variant: "primary", size: "sm" })}>
              {saving ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <Save size={15} aria-hidden />}
              Save
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-2 text-sm font-semibold text-failed-text">
          <span aria-hidden className="size-2 shrink-0 bg-failed" />
          {error}
        </p>
      ) : null}
    </section>
  );
}
