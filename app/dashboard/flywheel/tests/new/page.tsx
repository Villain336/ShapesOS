// Marketr — Test Lab: new experiment form.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import { ArrowLeft } from "lucide-react";

const F = "grid gap-1.5";

export default function NewExperimentPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "", hypothesis: "", potential: "7", importance: "7", ease: "7",
    channel: "web", audience: "all visitors", primaryMetric: "conversion_rate",
    statedMde: "0.2", baselineRate: "0.02", monthlyTraffic: "5000",
    minRuntimeDays: "14", treatmentName: "Treatment",
    margin: "", discount: "",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const pie = (Number(form.potential) + Number(form.importance) + Number(form.ease)) / 3;
      const res = await fetch("/api/flywheel/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          hypothesis: form.hypothesis,
          pieIceScore: Math.round(pie * 10) / 10,
          channel: form.channel,
          variants: [
            { id: "control", name: "Control", weight: 0.5, description: "Current experience" },
            { id: "treatment", name: form.treatmentName, weight: 0.5 },
          ],
          audience: form.audience,
          primaryMetric: form.primaryMetric,
          metricType: "binomial",
          guardrailMetrics: [{ name: "bounce_rate", tolerance: 0.05 }],
          profitGuardrail: form.margin !== "" ? {
            marginPerConversion: Number(form.margin),
            discountCostPerConversion: Number(form.discount || 0),
          } : undefined,
          minRuntimeDays: Number(form.minRuntimeDays),
          statedMde: Number(form.statedMde),
          baselineRate: Number(form.baselineRate),
          monthlyTraffic: Number(form.monthlyTraffic),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Create failed (${res.status})`);
        return;
      }
      if (data.trafficFloor?.decision === "refuse") {
        setError(`Traffic floor refused: ${data.trafficFloor.note}`);
        return;
      }
      router.push(`/dashboard/flywheel/tests/${data.experiment.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <nav className="flex items-center gap-1.5 text-xs text-muted">
        <Link href="/dashboard/flywheel/tests" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft className="h-3 w-3" /> Test Lab
        </Link>
        <span>/</span>
        <span className="font-medium text-ink">New experiment</span>
      </nav>
      <header>
        <h1 className="aos-heading">New experiment</h1>
        <p className="mt-0.5 text-[0.8125rem] text-muted">
          The traffic floor runs at creation — the lab refuses tests it cannot resolve.
        </p>
      </header>
      <form onSubmit={submit} className="mx-auto w-full max-w-2xl rounded-xl border border-line bg-white p-5">
        <div className="space-y-4">
        <div className={F}><Label htmlFor="name" className="text-[0.8125rem] font-medium text-muted">Name</Label><Input id="name" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" value={form.name} onChange={set("name")} required /></div>
        <div className={F}><Label htmlFor="hypothesis" className="text-[0.8125rem] font-medium text-muted">Hypothesis</Label><Input id="hypothesis" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" value={form.hypothesis} onChange={set("hypothesis")} required minLength={10} placeholder="We believe X will cause Y because Z" /></div>
        <div className="grid grid-cols-3 gap-3">
          <div className={F}><Label htmlFor="potential" className="text-[0.8125rem] font-medium text-muted">Potential (0–10)</Label><Input id="potential" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" min={0} max={10} value={form.potential} onChange={set("potential")} /></div>
          <div className={F}><Label htmlFor="importance" className="text-[0.8125rem] font-medium text-muted">Importance (0–10)</Label><Input id="importance" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" min={0} max={10} value={form.importance} onChange={set("importance")} /></div>
          <div className={F}><Label htmlFor="ease" className="text-[0.8125rem] font-medium text-muted">Ease (0–10)</Label><Input id="ease" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" min={0} max={10} value={form.ease} onChange={set("ease")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className={F}><Label htmlFor="channel" className="text-[0.8125rem] font-medium text-muted">Channel</Label>
            <select id="channel" value={form.channel} onChange={set("channel")} className="rounded-md border border-line bg-white px-3 py-2 text-[0.8125rem] text-ink focus-visible:border-ink focus-visible:outline-none">
              <option value="web">Web</option><option value="email">Email</option>
              <option value="ads">Ads (platform-native import)</option><option value="mail">Direct mail</option>
            </select>
          </div>
          <div className={F}><Label htmlFor="audience" className="text-[0.8125rem] font-medium text-muted">Audience</Label><Input id="audience" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" value={form.audience} onChange={set("audience")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className={F}><Label htmlFor="primaryMetric" className="text-[0.8125rem] font-medium text-muted">Primary metric</Label><Input id="primaryMetric" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" value={form.primaryMetric} onChange={set("primaryMetric")} /></div>
          <div className={F}><Label htmlFor="treatmentName" className="text-[0.8125rem] font-medium text-muted">Treatment name</Label><Input id="treatmentName" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" value={form.treatmentName} onChange={set("treatmentName")} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className={F}><Label htmlFor="statedMde" className="text-[0.8125rem] font-medium text-muted">Stated MDE (e.g. 0.2)</Label><Input id="statedMde" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" step="0.01" min={0.001} max={1} value={form.statedMde} onChange={set("statedMde")} /></div>
          <div className={F}><Label htmlFor="baselineRate" className="text-[0.8125rem] font-medium text-muted">Baseline rate (e.g. 0.02)</Label><Input id="baselineRate" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" step="0.001" min={0} max={1} value={form.baselineRate} onChange={set("baselineRate")} /></div>
          <div className={F}><Label htmlFor="monthlyTraffic" className="text-[0.8125rem] font-medium text-muted">Monthly traffic</Label><Input id="monthlyTraffic" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" min={0} value={form.monthlyTraffic} onChange={set("monthlyTraffic")} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className={F}><Label htmlFor="minRuntimeDays" className="text-[0.8125rem] font-medium text-muted">Min runtime (days, ≥7)</Label><Input id="minRuntimeDays" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" min={7} value={form.minRuntimeDays} onChange={set("minRuntimeDays")} /></div>
          <div className={F}><Label htmlFor="margin" className="text-[0.8125rem] font-medium text-muted">Margin/conv. $ (profit guardrail)</Label><Input id="margin" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" step="0.01" min={0} value={form.margin} onChange={set("margin")} placeholder="required for conversion tests" /></div>
          <div className={F}><Label htmlFor="discount" className="text-[0.8125rem] font-medium text-muted">Discount cost/conv. $</Label><Input id="discount" className="border-line bg-white text-[0.8125rem] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" type="number" step="0.01" min={0} value={form.discount} onChange={set("discount")} /></div>
        </div>
        {error && <p role="alert" className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint p-3 text-[0.8125rem] text-failed-text"><span className="size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />{error}</p>}
        <Button type="submit" disabled={busy} className="bg-ink text-white hover:bg-ink-hover">{busy ? "Creating…" : "Create experiment"}</Button>
        </div>
      </form>
    </div>
  );
}
