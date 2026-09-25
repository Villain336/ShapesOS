// Marketr — Test Lab client actions (lifecycle buttons + honesty read form).
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import type { Experiment } from "@/lib/flywheel/testlab/experiment";

export function TestLabActions({ experiment }: { experiment: Experiment }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<string[]>([]);

  // Honesty-read form (fake-mode arm data)
  const [aConv, setAConv] = useState("200");
  const [aN, setAN] = useState("10000");
  const [bConv, setBConv] = useState("230");
  const [bN, setBN] = useState("10000");
  const [days, setDays] = useState("14");

  async function call(path: string, opts: RequestInit = {}) {
    setBusy(path); setError(null); setBlockers([]);
    try {
      const res = await fetch(path, {
        ...opts,
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        if (Array.isArray(data.blockers)) setBlockers(data.blockers);
        return null;
      }
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
      router.refresh();
    }
  }

  const id = experiment.id;
  const paused = experiment.status === "paused";

  async function readResults() {
    const a = { successes: Number(aConv), trials: Number(aN) };
    const b = { successes: Number(bConv), trials: Number(bN) };
    await call(`/api/flywheel/tests/${id}/results`, {
      method: "POST",
      body: JSON.stringify({
        armA: a, armB: b,
        armCounts: [a.trials, b.trials],
        armWeights: experiment.variants.map((v) => v.weight),
        coverage: { randomizedUnits: a.trials + b.trials, unitsInAnalysis: a.trials + b.trials },
        daysRunning: Number(days),
        fullCycleCovered: Number(days) >= experiment.minRuntimeDays,
      }),
    });
  }

  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="text-base font-semibold">Lifecycle actions</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {experiment.status === "draft" && (
          <Button disabled={!!busy} onClick={() => call(`/api/flywheel/tests/${id}/qa`, { method: "POST", body: "{}" })}>
            {busy ? "Running…" : "Run QA"}
          </Button>
        )}
        {experiment.status === "qa" && (
          <Button disabled={!!busy} onClick={() => call(`/api/flywheel/tests/${id}/launch`, { method: "POST" })}>
            {busy ? "Launching…" : "Launch"}
          </Button>
        )}
        {(experiment.status === "running" || experiment.status === "paused") && (
          <Button variant="outline" disabled={!!busy}
            onClick={() => call(`/api/flywheel/tests/${id}/pause`, { method: "POST", body: JSON.stringify({ action: paused ? "resume" : "pause" }) })}>
            {paused ? "Resume" : "Pause"}
          </Button>
        )}
        {(experiment.status === "running" || experiment.status === "paused") && (
          <Button variant="outline" disabled={!!busy} onClick={readResults}>Read results</Button>
        )}
        {experiment.status === "complete" && (
          <Button disabled={!!busy} onClick={() => call(`/api/flywheel/tests/${id}/archive`, { method: "POST" })}>
            {busy ? "Archiving…" : "Archive to Growth Memory"}
          </Button>
        )}
      </div>

      {(experiment.status === "running" || experiment.status === "paused") && (
        <div className="mt-4 grid max-w-2xl grid-cols-2 gap-3 md:grid-cols-5">
          <div><Label htmlFor="aConv">Control conv.</Label><Input id="aConv" value={aConv} onChange={(e) => setAConv(e.target.value)} /></div>
          <div><Label htmlFor="aN">Control n</Label><Input id="aN" value={aN} onChange={(e) => setAN(e.target.value)} /></div>
          <div><Label htmlFor="bConv">Treatment conv.</Label><Input id="bConv" value={bConv} onChange={(e) => setBConv(e.target.value)} /></div>
          <div><Label htmlFor="bN">Treatment n</Label><Input id="bN" value={bN} onChange={(e) => setBN(e.target.value)} /></div>
          <div><Label htmlFor="days">Days running</Label><Input id="days" value={days} onChange={(e) => setDays(e.target.value)} /></div>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p className="font-medium">{error}</p>
          {blockers.length > 0 && (
            <ul className="mt-1 list-disc pl-5">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
          )}
        </div>
      )}
    </section>
  );
}
