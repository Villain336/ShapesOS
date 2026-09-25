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
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href="/dashboard/flywheel/tests" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Test Lab
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New experiment</h1>
        <p className="text-sm text-muted-foreground">
          The traffic floor runs at creation — the lab refuses tests it cannot resolve.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div className={F}><Label htmlFor="name">Name</Label><Input id="name" value={form.name} onChange={set("name")} required /></div>
        <div className={F}><Label htmlFor="hypothesis">Hypothesis</Label><Input id="hypothesis" value={form.hypothesis} onChange={set("hypothesis")} required minLength={10} placeholder="We believe X will cause Y because Z" /></div>
        <div className="grid grid-cols-3 gap-3">
          <div className={F}><Label htmlFor="potential">Potential (0–10)</Label><Input id="potential" type="number" min={0} max={10} value={form.potential} onChange={set("potential")} /></div>
          <div className={F}><Label htmlFor="importance">Importance (0–10)</Label><Input id="importance" type="number" min={0} max={10} value={form.importance} onChange={set("importance")} /></div>
          <div className={F}><Label htmlFor="ease">Ease (0–10)</Label><Input id="ease" type="number" min={0} max={10} value={form.ease} onChange={set("ease")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className={F}><Label htmlFor="channel">Channel</Label>
            <select id="channel" value={form.channel} onChange={set("channel")} className="rounded-md border bg-background px-3 py-2 text-sm">
              <option value="web">Web</option><option value="email">Email</option>
              <option value="ads">Ads (platform-native import)</option><option value="mail">Direct mail</option>
            </select>
          </div>
          <div className={F}><Label htmlFor="audience">Audience</Label><Input id="audience" value={form.audience} onChange={set("audience")} /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className={F}><Label htmlFor="primaryMetric">Primary metric</Label><Input id="primaryMetric" value={form.primaryMetric} onChange={set("primaryMetric")} /></div>
          <div className={F}><Label htmlFor="treatmentName">Treatment name</Label><Input id="treatmentName" value={form.treatmentName} onChange={set("treatmentName")} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className={F}><Label htmlFor="statedMde">Stated MDE (e.g. 0.2)</Label><Input id="statedMde" type="number" step="0.01" min={0.001} max={1} value={form.statedMde} onChange={set("statedMde")} /></div>
          <div className={F}><Label htmlFor="baselineRate">Baseline rate (e.g. 0.02)</Label><Input id="baselineRate" type="number" step="0.001" min={0} max={1} value={form.baselineRate} onChange={set("baselineRate")} /></div>
          <div className={F}><Label htmlFor="monthlyTraffic">Monthly traffic</Label><Input id="monthlyTraffic" type="number" min={0} value={form.monthlyTraffic} onChange={set("monthlyTraffic")} /></div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className={F}><Label htmlFor="minRuntimeDays">Min runtime (days, ≥7)</Label><Input id="minRuntimeDays" type="number" min={7} value={form.minRuntimeDays} onChange={set("minRuntimeDays")} /></div>
          <div className={F}><Label htmlFor="margin">Margin/conv. $ (profit guardrail)</Label><Input id="margin" type="number" step="0.01" min={0} value={form.margin} onChange={set("margin")} placeholder="required for conversion tests" /></div>
          <div className={F}><Label htmlFor="discount">Discount cost/conv. $</Label><Input id="discount" type="number" step="0.01" min={0} value={form.discount} onChange={set("discount")} /></div>
        </div>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create experiment"}</Button>
      </form>
    </div>
  );
}
