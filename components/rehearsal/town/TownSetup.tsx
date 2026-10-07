"use client";

// ShapesOS — Phase 19B (WS=engine): run setup for a town rehearsal — the town
// (generate or import from Figma), population and who lives there (panel
// personas + an "everyone else" slider), days, seeded runs N, scenario A vs
// B with interventions (simulated objects only), and the estimate with an
// explicit cap confirmation before anything is queued.

import { useMemo, useState } from "react";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { PersonaView } from "@/lib/panel/service.server";
import type { TownEstimate } from "@/lib/sim/estimate";
import type { Intervention, InterventionKind, Scenario } from "@/lib/sim/scenario";
import type { WorldView } from "@/lib/sim/service.server";
import { inputClass } from "../ui";

const labelClass = "flex flex-col gap-1.5 text-sm font-semibold text-ink";
const cardClass = "flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline";
const KINDS: InterventionKind[] = ["product_drop", "price_change", "ad_campaign", "opening_hours", "promotion", "new_location"];

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url, { cache: "no-store", ...init }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res || !res.ok) return { ok: false, error: body?.error ?? "Could not reach the server." };
  return { ok: true, data: body as T };
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function defaultIntervention(kind: InterventionKind, world: WorldView | null): Intervention {
  switch (kind) {
    case "product_drop":
      return { kind, day: 0 };
    case "price_change":
      return { kind, day: 1, priceCents: 2_500 };
    case "ad_campaign":
      return { kind, channel: "social", startDay: 0, endDay: 2, dailyBudgetCents: 2_000, creative: "Now open downtown" };
    case "opening_hours":
      return { kind, day: 0, openHour: 8, closeHour: 21 };
    case "promotion":
      return { kind, day: 1, endDay: 2, discountPct: 10, label: "Opening week", event: true };
    case "new_location":
      return { kind, day: 1, lotId: world?.layout.lots.find((l) => l.kind === "shop" && l.owner === "competitor")?.id ?? world?.layout.lots.find((l) => l.kind === "cafe")?.id ?? "" };
  }
}

function ScenarioEditor({ variant, value, onChange, world }: { variant: "A" | "B"; value: Scenario; onChange: (s: Scenario) => void; world: WorldView | null }) {
  const { t } = useI18n();
  const [adding, setAdding] = useState<InterventionKind>("price_change");
  const set = (patch: Partial<Scenario>) => onChange({ ...value, ...patch });
  const setIv = (i: number, iv: Intervention) => set({ interventions: value.interventions.map((x, j) => (j === i ? iv : x)) });
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0));
  const lots = (world?.layout.lots ?? []).filter((l) => l.kind === "shop" || l.kind === "cafe" || l.kind === "work");
  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-semibold text-ink">{t("rehearsalTown.setup.scenario", { variant })}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          {t("rehearsalTown.setup.label")}
          <input className={inputClass} value={value.label} maxLength={60} onChange={(e) => set({ label: e.target.value })} />
        </label>
        <label className={labelClass}>
          {t("rehearsalTown.setup.productName")}
          <input className={inputClass} value={value.product.name} maxLength={80} onChange={(e) => set({ product: { ...value.product, name: e.target.value } })} />
        </label>
        <label className={labelClass}>
          {t("rehearsalTown.setup.category")}
          <input className={inputClass} value={value.product.category} maxLength={60} onChange={(e) => set({ product: { ...value.product, category: e.target.value } })} />
        </label>
        <label className={labelClass}>
          {t("rehearsalTown.setup.price")}
          <input className={inputClass} type="number" min={0.01} step={0.01} value={value.product.priceCents / 100} onChange={(e) => set({ product: { ...value.product, priceCents: Math.max(1, Math.round(Number(e.target.value) * 100) || 1) } })} />
        </label>
      </div>
      <label className={labelClass}>
        {t("rehearsalTown.setup.description")}
        <input className={inputClass} value={value.product.description} maxLength={500} onChange={(e) => set({ product: { ...value.product, description: e.target.value } })} />
      </label>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold text-ink">{t("rehearsalTown.setup.interventions")}</span>
        {value.interventions.map((iv, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2 rounded-sm bg-canvas p-2">
            <span className="min-w-36 text-sm font-semibold text-ink">{t(`rehearsalTown.setup.kinds.${iv.kind}` as MessageKey)}</span>
            {"day" in iv ? (
              <label className={labelClass}>
                {t("rehearsalTown.setup.day")}
                <input className={`${inputClass} w-20`} type="number" min={1} max={30} value={iv.day + 1} onChange={(e) => setIv(i, { ...iv, day: Math.max(0, num(e.target.value) - 1) } as Intervention)} />
              </label>
            ) : null}
            {iv.kind === "price_change" ? (
              <label className={labelClass}>
                {t("rehearsalTown.setup.newPrice")}
                <input className={`${inputClass} w-28`} type="number" min={0.01} step={0.01} value={iv.priceCents / 100} onChange={(e) => setIv(i, { ...iv, priceCents: Math.max(1, Math.round(Number(e.target.value) * 100) || 1) })} />
              </label>
            ) : null}
            {iv.kind === "ad_campaign" ? (
              <>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.channel")}
                  <select className={`${inputClass} w-36`} value={iv.channel} onChange={(e) => setIv(i, { ...iv, channel: e.target.value as typeof iv.channel })}>
                    {(["billboard", "social", "search"] as const).map((c) => (
                      <option key={c} value={c}>
                        {t(`rehearsalTown.setup.channels.${c}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.day")}
                  <input className={`${inputClass} w-20`} type="number" min={1} max={30} value={iv.startDay + 1} onChange={(e) => setIv(i, { ...iv, startDay: Math.max(0, num(e.target.value) - 1) })} />
                </label>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.endDay")}
                  <input className={`${inputClass} w-20`} type="number" min={1} max={30} value={iv.endDay + 1} onChange={(e) => setIv(i, { ...iv, endDay: Math.max(0, num(e.target.value) - 1) })} />
                </label>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.dailyBudget")}
                  <input className={`${inputClass} w-28`} type="number" min={0} value={iv.dailyBudgetCents / 100} onChange={(e) => setIv(i, { ...iv, dailyBudgetCents: num(e.target.value) * 100 })} />
                </label>
                <label className={`${labelClass} min-w-56 flex-1`}>
                  {t("rehearsalTown.setup.creative")}
                  <input className={inputClass} value={iv.creative} maxLength={280} onChange={(e) => setIv(i, { ...iv, creative: e.target.value })} />
                </label>
              </>
            ) : null}
            {iv.kind === "opening_hours" ? (
              <>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.openHour")}
                  <input className={`${inputClass} w-20`} type="number" min={0} max={23} value={iv.openHour} onChange={(e) => setIv(i, { ...iv, openHour: Math.min(23, num(e.target.value)) })} />
                </label>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.closeHour")}
                  <input className={`${inputClass} w-20`} type="number" min={1} max={24} value={iv.closeHour} onChange={(e) => setIv(i, { ...iv, closeHour: Math.min(24, Math.max(1, num(e.target.value))) })} />
                </label>
              </>
            ) : null}
            {iv.kind === "promotion" ? (
              <>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.endDay")}
                  <input className={`${inputClass} w-20`} type="number" min={1} max={30} value={iv.endDay + 1} onChange={(e) => setIv(i, { ...iv, endDay: Math.max(0, num(e.target.value) - 1) })} />
                </label>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.discount")}
                  <input className={`${inputClass} w-20`} type="number" min={0} max={90} value={iv.discountPct} onChange={(e) => setIv(i, { ...iv, discountPct: Math.min(90, num(e.target.value)) })} />
                </label>
                <label className={labelClass}>
                  {t("rehearsalTown.setup.promoLabel")}
                  <input className={`${inputClass} w-44`} value={iv.label} maxLength={80} onChange={(e) => setIv(i, { ...iv, label: e.target.value })} />
                </label>
                <label className="flex h-control items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={iv.event} onChange={(e) => setIv(i, { ...iv, event: e.target.checked })} />
                  {t("rehearsalTown.setup.event")}
                </label>
              </>
            ) : null}
            {iv.kind === "new_location" ? (
              <label className={labelClass}>
                {t("rehearsalTown.setup.lot")}
                <select className={`${inputClass} w-48`} value={iv.lotId} onChange={(e) => setIv(i, { ...iv, lotId: e.target.value })}>
                  {lots.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button type="button" className={aosButton({ variant: "quiet", size: "sm" })} onClick={() => set({ interventions: value.interventions.filter((_, j) => j !== i) })}>
              <Trash2 className="size-4" aria-hidden />
              {t("rehearsalTown.setup.remove")}
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <select className={`${inputClass} w-56`} value={adding} aria-label={t("rehearsalTown.setup.interventions")} onChange={(e) => setAdding(e.target.value as InterventionKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`rehearsalTown.setup.kinds.${k}` as MessageKey)}
              </option>
            ))}
          </select>
          <button type="button" className={aosButton({ variant: "secondary", size: "sm" })} onClick={() => set({ interventions: [...value.interventions, defaultIntervention(adding, world)] })}>
            <Plus className="size-4" aria-hidden />
            {t("rehearsalTown.setup.addIntervention")}
          </button>
        </div>
      </div>
    </fieldset>
  );
}

const baseScenario = (label: string): Scenario => ({
  label,
  product: { name: "Desk lamp", category: "home", priceCents: 4_000, description: "A warm desk lamp for late work" },
  storeHours: { openHour: 9, closeHour: 20 },
  interventions: [{ kind: "ad_campaign", channel: "social", startDay: 0, endDay: 2, dailyBudgetCents: 2_000, creative: "A desk lamp for late nights, downtown" }],
});

export function TownSetup({ worlds, personas, onWorlds, onStarted }: { worlds: WorldView[]; personas: PersonaView[]; onWorlds: (w: WorldView[], select?: string) => void; onStarted: (runId: string) => void }) {
  const { t } = useI18n();
  const active = useMemo(() => personas.filter((p) => p.status === "active"), [personas]);
  const [worldId, setWorldId] = useState(worlds[0]?.id ?? "");
  const [size, setSize] = useState<"small" | "medium">("small");
  const [seed, setSeed] = useState("");
  const [figmaUrl, setFigmaUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [population, setPopulation] = useState(50);
  const [shares, setShares] = useState<Record<string, number>>({});
  const [days, setDays] = useState(3);
  const [seeds, setSeeds] = useState(3);
  const [mode, setMode] = useState<"live" | "deep" | "rules">("live");
  const [scenarioA, setScenarioA] = useState<Scenario>(() => baseScenario("Launch at $40"));
  const [compare, setCompare] = useState(true);
  const [scenarioB, setScenarioB] = useState<Scenario>(() => ({ ...baseScenario("Launch at $25"), interventions: [...baseScenario("B").interventions, { kind: "price_change", day: 0, priceCents: 2_500 }] }));
  const [estimate, setEstimate] = useState<{ estimate: TownEstimate; modelKind: string } | null>(null);
  const [cap, setCap] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const world = worlds.find((w) => w.id === worldId) ?? worlds[0] ?? null;

  const segments = () => {
    const picked = active.filter((p) => (shares[p.id] ?? 0) > 0).map((p) => ({ key: p.id.slice(-12), label: p.name, share: (shares[p.id] ?? 0) / 100, personaId: p.id }));
    const used = picked.reduce((n, s) => n + s.share, 0);
    return used < 1 ? [...picked, { key: "everyone", label: t("rehearsalTown.setup.everyoneElse"), share: Math.max(0, 1 - used) }] : picked;
  };
  const input = () => ({ worldId: world?.id ?? "", population, segments: segments(), days, seeds, mode, scenarioA, scenarioB: compare ? scenarioB : null });
  const invalidate = () => {
    setEstimate(null);
    setConfirmed(false);
  };

  async function generate() {
    setBusy("generate");
    const r = await api<{ world: WorldView }>("/api/rehearsal/town/worlds", post({ kind: "generate", size, ...(seed.trim() ? { seed: Number(seed) } : {}) }));
    setBusy(null);
    if (!r.ok) return toastError(t("rehearsalTown.worlds.failed"), r.error);
    toast({ title: t("rehearsalTown.worlds.created"), status: "done" });
    setWorldId(r.data.world.id);
    onWorlds([r.data.world, ...worlds], r.data.world.id);
    invalidate();
  }
  async function importFigma() {
    setBusy("figma");
    const r = await api<{ world: WorldView }>("/api/rehearsal/town/worlds", post({ kind: "figma", url: figmaUrl }));
    setBusy(null);
    if (!r.ok) return toastError(t("rehearsalTown.worlds.failed"), r.error);
    toast({ title: t("rehearsalTown.worlds.created"), status: "done" });
    setWorldId(r.data.world.id);
    onWorlds([r.data.world, ...worlds], r.data.world.id);
    invalidate();
  }
  async function runEstimate() {
    setBusy("estimate");
    const r = await api<{ estimate: TownEstimate; modelKind: string }>("/api/rehearsal/town/estimate", post(input()));
    setBusy(null);
    if (!r.ok) return toastError(t("rehearsalTown.estimate.failed"), r.error);
    setEstimate(r.data);
    setCap(r.data.estimate.capCredits);
    setConfirmed(false);
  }
  async function start() {
    setBusy("start");
    const r = await api<{ run: { id: string } }>("/api/rehearsal/town/runs", post({ ...input(), capCredits: cap, confirmed: true }));
    setBusy(null);
    if (!r.ok) return toastError(t("rehearsalTown.estimate.failed"), r.error);
    toast({ title: t("rehearsalTown.estimate.started"), status: "done" });
    invalidate();
    onStarted(r.data.run.id);
  }

  const rules = mode === "rules";
  return (
    <section className={cardClass} aria-labelledby="town-setup-title">
      <h2 id="town-setup-title" className="aos-subheading">
        {t("rehearsalTown.setup.title")}
      </h2>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <label className={labelClass}>
          {t("rehearsalTown.worlds.pick")}
          <select className={inputClass} value={world?.id ?? ""} onChange={(e) => (setWorldId(e.target.value), invalidate())}>
            {worlds.length === 0 ? <option value="">{t("rehearsalTown.worlds.none")}</option> : null}
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} · {t(`rehearsalTown.worlds.source.${w.source}` as MessageKey)} · {t("rehearsalTown.worlds.homesFor", { count: w.homesFor })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3">
          <label className={labelClass}>
            {t("rehearsalTown.worlds.size")}
            <select className={`${inputClass} w-64`} value={size} onChange={(e) => setSize(e.target.value as "small" | "medium")}>
              <option value="small">{t("rehearsalTown.worlds.sizes.small")}</option>
              <option value="medium">{t("rehearsalTown.worlds.sizes.medium")}</option>
            </select>
          </label>
          <label className={labelClass}>
            {t("rehearsalTown.worlds.seed")}
            <input className={`${inputClass} w-32`} inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, "").slice(0, 9))} />
          </label>
          <button type="button" className={aosButton({ variant: "secondary" })} disabled={busy !== null} onClick={() => void generate()}>
            <Wand2 className="size-4" aria-hidden />
            {busy === "generate" ? t("rehearsalTown.worlds.generating") : t("rehearsalTown.worlds.generate")}
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-line p-3">
          <label className={`${labelClass} min-w-60 flex-1`}>
            {t("rehearsalTown.worlds.figmaUrl")}
            <input className={inputClass} type="url" value={figmaUrl} placeholder="https://www.figma.com/design/…?node-id=…" onChange={(e) => setFigmaUrl(e.target.value)} />
          </label>
          <button type="button" className={aosButton({ variant: "secondary" })} disabled={busy !== null || !figmaUrl} onClick={() => void importFigma()}>
            {busy === "figma" ? t("rehearsalTown.worlds.importing") : t("rehearsalTown.worlds.importFigma")}
          </button>
          <p className="w-full text-xs text-muted">{t("rehearsalTown.worlds.figmaHint")}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>
          {t("rehearsalTown.setup.population")}
          <input className={inputClass} type="number" min={50} max={500} step={10} value={population} onChange={(e) => (setPopulation(Math.min(500, Math.max(50, Number(e.target.value) || 50))), invalidate())} />
        </label>
        <label className={labelClass}>
          {t("rehearsalTown.setup.days")}
          <input className={inputClass} type="number" min={1} max={30} value={days} onChange={(e) => (setDays(Math.min(30, Math.max(1, Number(e.target.value) || 1))), invalidate())} />
        </label>
        <label className={labelClass}>
          {t("rehearsalTown.setup.seeds")}
          <input className={inputClass} type="number" min={1} max={10} value={seeds} aria-describedby="town-seeds-hint" onChange={(e) => (setSeeds(Math.min(10, Math.max(1, Number(e.target.value) || 1))), invalidate())} />
          <span id="town-seeds-hint" className="text-xs font-normal text-muted">
            {t("rehearsalTown.setup.seedsHint")}
          </span>
        </label>
        <label className={labelClass}>
          {t("rehearsalTown.setup.mode")}
          <select className={inputClass} value={mode} onChange={(e) => (setMode(e.target.value as typeof mode), invalidate())}>
            {(["live", "deep", "rules"] as const).map((m) => (
              <option key={m} value={m}>
                {t(`rehearsalTown.setup.modes.${m}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-semibold text-ink">{t("rehearsalTown.setup.segments")}</legend>
        <p className="text-xs text-muted">{t("rehearsalTown.setup.segmentsHint")}</p>
        {active.map((p) => (
          <label key={p.id} className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="min-w-40 font-semibold">{p.name}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={shares[p.id] ?? 0}
              aria-label={`${p.name}: ${t("rehearsalTown.setup.share")}`}
              onChange={(e) => (setShares({ ...shares, [p.id]: Number(e.target.value) }), invalidate())}
            />
            <span className="w-12 text-muted">{shares[p.id] ?? 0}%</span>
          </label>
        ))}
        <p className="text-sm text-muted">
          {t("rehearsalTown.setup.everyoneElse")}: {Math.max(0, 100 - Object.values(shares).reduce((n, v) => n + v, 0))}%
        </p>
      </fieldset>

      <ScenarioEditor variant="A" value={scenarioA} onChange={(s) => (setScenarioA(s), invalidate())} world={world} />
      <label className="flex items-center gap-2 text-sm font-semibold text-ink">
        <input type="checkbox" checked={compare} onChange={(e) => (setCompare(e.target.checked), invalidate())} />
        {t("rehearsalTown.setup.compare")}
      </label>
      {compare ? <ScenarioEditor variant="B" value={scenarioB} onChange={(s) => (setScenarioB(s), invalidate())} world={world} /> : null}

      <div className="flex flex-col gap-3 rounded-md bg-canvas p-3">
        <button type="button" className={aosButton({ variant: "secondary", className: "self-start" })} disabled={busy !== null || !world} onClick={() => void runEstimate()}>
          {busy === "estimate" ? t("rehearsalTown.estimate.estimating") : t("rehearsalTown.estimate.button")}
        </button>
        {estimate ? (
          <>
            <p className="text-sm text-ink" aria-live="polite">
              {rules
                ? t("rehearsalTown.estimate.rulesFree")
                : t("rehearsalTown.estimate.line", { calls: estimate.estimate.expectedCalls, perDay: estimate.estimate.perResidentDay.expectedCalls, expected: estimate.estimate.expectedCredits, max: estimate.estimate.capCredits })}
            </p>
            {!rules ? (
              <label className={`${labelClass} w-56`}>
                {t("rehearsalTown.estimate.cap")}
                <input className={inputClass} type="number" min={1} max={estimate.estimate.capCredits} value={cap} onChange={(e) => (setCap(Math.min(estimate.estimate.capCredits, Math.max(1, Math.round(Number(e.target.value) || 1)))), setConfirmed(false))} />
              </label>
            ) : null}
            <label className="flex items-center gap-2 text-sm font-semibold text-ink">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {t("rehearsalTown.estimate.confirm", { credits: rules ? 0 : cap })}
            </label>
            <button type="button" className={aosButton({ variant: "primary", className: "self-start" })} disabled={!confirmed || busy !== null} onClick={() => void start()}>
              {busy === "start" ? t("rehearsalTown.estimate.starting") : t("rehearsalTown.estimate.start")}
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
