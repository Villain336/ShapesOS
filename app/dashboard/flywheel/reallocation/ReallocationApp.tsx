// Marketr — F1 reallocation client app.
// Proposal queue + SRA envelopes + breakers + curves + audit, all API-driven.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardHeader } from "@/components/vault/Card";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { Badge } from "@/components/vault/shadcn/badge";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/vault/shadcn/tabs";
import { Textarea } from "@/components/vault/shadcn/textarea";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  PauseOctagon,
  Play,
  ShieldCheck,
  ShieldX,
  XCircle,
} from "lucide-react";

type Tab = "proposals" | "sras" | "breakers" | "curves" | "audit" | "run";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

function statusTone(s: string): "neutral" | "green" | "orange" | "red" | "accent" {
  if (s === "executed" || s === "human_approved" || s === "active") return "green";
  if (s === "policy_approved") return "accent";
  if (s === "policy_denied" || s === "revoked" || s === "expired") return "red";
  if (s === "proposed") return "neutral";
  return "orange";
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

/** Deterministic-ish 2-channel fixture so "Trigger run" works out of the box. */
function fixtureChannelsJson(): string {
  const now = Date.now();
  const DAY = 86_400_000;
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const mk = (channel: string, campaignRef: string, baseSpend: number, roas: number) => {
    const dataPoints = [];
    for (let d = 35; d >= 4; d--) {
      // lagDays=3 → points older than 3d are matured; d>=4 keeps them usable
      const spend = baseSpend * (1 + 0.25 * Math.sin(d * 0.7));
      const revenue = spend * roas * (1 + (rnd() - 0.5) * 0.3);
      dataPoints.push({
        ts: new Date(now - d * DAY).toISOString(),
        spendCents: Math.round(spend * 100),
        revenueCents: Math.round(revenue * 100),
      });
    }
    return {
      channel,
      campaignRef,
      platform: "meta",
      currentDailyBudgetCents: Math.round(baseSpend * 100),
      targetCpaCents: 4500,
      isBrand: false,
      isExploration: false,
      floor: { channel, learningViableMinCentsDay: 5000, stabilizationHours: 72 },
      dataPoints,
      health: {
        eventVolume: 1000,
        expectedEventMean: 1000,
        expectedEventStd: 80,
        platformSpendCents: Math.round(baseSpend * 100 * 30),
        trackerSpendCents: Math.round(baseSpend * 100 * 30 * 1.02),
      },
    };
  };
  return JSON.stringify(
    [mk("meta_prospecting", "meta_camp_1", 120, 3.1), mk("tiktok_prospecting", "tt_camp_1", 80, 1.4)],
    null,
    2,
  );
}

export default function ReallocationApp({ isOwner }: { isOwner: boolean }) {
  const [tab, setTab] = useState<Tab>("proposals");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<any[]>([]);
  const [sras, setSras] = useState<any[]>([]);
  const [breakers, setBreakers] = useState<any[]>([]);
  const [frozenScopes, setFrozenScopes] = useState<string[]>([]);
  const [curves, setCurves] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [chainIntact, setChainIntact] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, s, b, c, a] = await Promise.all([
        api("/api/flywheel/reallocation/proposals").catch(() => ({ proposals: [] })),
        api("/api/flywheel/reallocation/sras").catch(() => ({ sras: [] })),
        api("/api/flywheel/reallocation/breakers").catch(() => ({ breakers: [], frozenScopes: [] })),
        api("/api/flywheel/reallocation/curves").catch(() => ({ curves: [] })),
        api("/api/flywheel/reallocation/audit").catch(() => ({ events: [], chainIntact: null })),
      ]);
      setProposals(p.proposals ?? []);
      setSras(s.sras ?? []);
      setBreakers(b.breakers ?? []);
      setFrozenScopes(b.frozenScopes ?? []);
      setCurves(c.curves ?? []);
      setAudit(a.events ?? []);
      setChainIntact(a.chainIntact ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activeSra = useMemo(() => sras.find((s) => s.computedStatus === "active" || s.status === "active"), [sras]);

  // ---- SRA create form ----
  const [sraName, setSraName] = useState("Q4 reallocation envelope");
  const [sraChannels, setSraChannels] = useState("meta_prospecting, tiktok_prospecting");
  const [sraValidUntil, setSraValidUntil] = useState(() => new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10));
  const [sraPool, setSraPool] = useState("20000");
  const [sraSigners, setSraSigners] = useState("");
  const [sraResult, setSraResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const createSra = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api("/api/flywheel/reallocation/sras", {
        method: "POST",
        body: JSON.stringify({
          name: sraName,
          channels: sraChannels.split(",").map((s) => s.trim()).filter(Boolean),
          validUntil: new Date(sraValidUntil).toISOString(),
          poolDailyBudgetCents: Math.round(parseFloat(sraPool) * 100),
          signerIds: sraSigners.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      setSraResult(res);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeSra = async (id: string) => {
    if (!confirm("Revoke this SRA instantly? Mode (b) ceases to exist the moment this lands.")) return;
    setBusy(true);
    try {
      await api(`/api/flywheel/reallocation/sras/${id}/revoke`, { method: "POST", body: JSON.stringify({ reason: "manual revoke from UI" }) });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- proposal actions ----
  const approveProposal = async (id: string) => {
    const clientAdAccountId = prompt("Client ad account ID (zero custody — the client's own account):");
    if (!clientAdAccountId) return;
    const platform = prompt("Platform:", "meta");
    if (!platform) return;
    setBusy(true);
    try {
      await api(`/api/flywheel/reallocation/proposals/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ clientAdAccountId, platform }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const executeProposal = async (p: any) => {
    let body: any = {};
    if (p.mode === "b") {
      const raw = prompt("Channel baselines JSON (cents), e.g. {\"meta_prospecting\": 12000}:");
      if (!raw) return;
      try {
        body = { baselines: JSON.parse(raw) };
      } catch {
        setError("Invalid baselines JSON");
        return;
      }
    }
    if (!confirm(`Execute this ${money(p.amountCents)} shift from ${p.sourceChannel} to ${p.destChannel}?`)) return;
    setBusy(true);
    try {
      await api(`/api/flywheel/reallocation/proposals/${p.id}/execute`, { method: "POST", body: JSON.stringify(body) });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeBreaker = async (id: string) => {
    if (!confirm("Acknowledge this breaker? This STARTS the mandatory 72h cool-down — it does not end it.")) return;
    setBusy(true);
    try {
      await api(`/api/flywheel/reallocation/breakers/${id}/acknowledge`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- run trigger ----
  const [runMode, setRunMode] = useState<"a" | "b">("a");
  const [runChannels, setRunChannels] = useState<string>(() => fixtureChannelsJson());
  const [runSraId, setRunSraId] = useState("");
  const [runResult, setRunResult] = useState<any | null>(null);

  const triggerRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api("/api/flywheel/reallocation/runs", {
        method: "POST",
        body: JSON.stringify({
          mode: runMode,
          sraId: runMode === "b" ? runSraId || activeSra?.id : undefined,
          channels: JSON.parse(runChannels),
          autoExecute: false,
        }),
      });
      setRunResult(res);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-900">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {frozenScopes.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
          <PauseOctagon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Frozen scopes: {frozenScopes.join(", ")}. Breakers are one-way ratchets — they pause,
            never authorize. Acknowledge + 72h cool-down to resume.
          </span>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="proposals">Proposals ({proposals.length})</TabsTrigger>
          <TabsTrigger value="sras">SRA envelopes ({sras.length})</TabsTrigger>
          <TabsTrigger value="breakers">Breakers ({breakers.length})</TabsTrigger>
          <TabsTrigger value="curves">Curves ({curves.length})</TabsTrigger>
          <TabsTrigger value="run">Run optimizer</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="proposals" className="mt-4">
          <Card>
            <CardHeader
              title="Shift proposals"
              description="Each carries the full decision record: data window, curve params, R², model version."
              actions={<Button size="sm" variant="outline" onClick={refresh} disabled={loading}>Refresh</Button>}
            />
            <div className="divide-y divide-stone-100">
              {proposals.length === 0 && (
                <p className="p-4 text-[13px] text-stone-500">No proposals yet — trigger an optimizer run.</p>
              )}
              {proposals.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-stone-900">
                      <span>{money(p.amountCents)}</span>
                      <span className="text-stone-400">{p.sourceChannel}</span>
                      <ArrowRight className="h-3.5 w-3.5 text-stone-400" />
                      <span className="text-stone-400">{p.destChannel}</span>
                      <ValuePill tone={statusTone(p.status)}>{p.status}</ValuePill>
                      <Badge variant="outline">mode {p.mode}</Badge>
                    </div>
                    <p className="mt-1 text-[12px] text-stone-500">
                      Δ marginal ROAS {Number(p.marginalRoasDelta).toFixed(2)}x ·{" "}
                      {p.decisionRecord?.curveParams
                        ? Object.entries(p.decisionRecord.curveParams)
                            .map(([ch, c]: any) => `${ch}: ${c.curveType} R²=${Number(c.rSquared).toFixed(2)}`)
                            .join(" · ")
                        : "no curve record"}
                      {p.decisionRecord?.calibrationNote ? ` · ${p.decisionRecord.calibrationNote}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.mode === "a" && p.status === "proposed" && isOwner && (
                      <Button size="sm" onClick={() => approveProposal(p.id)} disabled={busy}>
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve → approval object
                      </Button>
                    )}
                    {(p.status === "human_approved" || p.status === "policy_approved") && isOwner && (
                      <Button size="sm" variant="outline" onClick={() => executeProposal(p)} disabled={busy}>
                        <Play className="mr-1 h-3.5 w-3.5" /> Execute
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="sras" className="mt-4 flex flex-col gap-4">
          <Card>
            <CardHeader
              title="Standing Reallocation Approvals"
              description="Pre-signed bounded envelopes — pool caps, not standing authority. Explicit opt-in; defaults to disabled; ≤30d expiry; instant revocation."
            />
            <div className="divide-y divide-stone-100">
              {sras.length === 0 && (
                <p className="p-4 text-[13px] text-stone-500">No SRA envelopes. Mode (b) is disabled until one is signed.</p>
              )}
              {sras.map((s) => (
                <div key={s.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-stone-900">{s.name}</span>
                    <ValuePill tone={statusTone(s.computedStatus ?? s.status)}>{s.computedStatus ?? s.status}</ValuePill>
                    <span className="text-[12px] text-stone-500">
                      {money(s.perShiftCapCents)}/shift · {money(s.dailyAggregateCapCents)}/day · {money(s.weeklyAggregateCapCents)}/wk · ±{s.perChannelBandPct}% band
                    </span>
                    {isOwner && (s.computedStatus ?? s.status) === "active" && (
                      <Button size="sm" variant="destructive" onClick={() => revokeSra(s.id)} disabled={busy}>
                        <ShieldX className="mr-1 h-3.5 w-3.5" /> Revoke instantly
                      </Button>
                    )}
                  </div>
                  <p className="mt-1 text-[12px] text-stone-500">
                    Allowlist: {Array.isArray(s.channels) ? s.channels.join(", ") : ""} · expires{" "}
                    {new Date(s.validUntil).toLocaleDateString()} · signers: {(s.signerIds ?? []).length}
                  </p>
                  {s.consequences && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-stone-600">
                      {s.consequences.map((c: string, i: number) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {isOwner && (
            <Card>
              <CardHeader title="Sign a new SRA" description="Deliberate act with plain-language consequences. Conservative defaults." />
              <div className="grid gap-3 p-4 md:grid-cols-2">
                <label className="text-[12px] text-stone-600">Name<Input value={sraName} onChange={(e) => setSraName(e.target.value)} className="mt-1" /></label>
                <label className="text-[12px] text-stone-600">Channels (comma-separated allowlist)<Input value={sraChannels} onChange={(e) => setSraChannels(e.target.value)} className="mt-1" /></label>
                <label className="text-[12px] text-stone-600">Valid until<Input type="date" value={sraValidUntil} onChange={(e) => setSraValidUntil(e.target.value)} className="mt-1" /></label>
                <label className="text-[12px] text-stone-600">Pool daily budget ($)<Input value={sraPool} onChange={(e) => setSraPool(e.target.value)} className="mt-1" /></label>
                <label className="text-[12px] text-stone-600 md:col-span-2">Signer IDs (comma-separated — 2 required when cumulative movement can reach $1k)<Input value={sraSigners} onChange={(e) => setSraSigners(e.target.value)} className="mt-1" placeholder="user_1, user_2" /></label>
              </div>
              <div className="flex items-center gap-3 border-t border-stone-100 p-4">
                <Button onClick={createSra} disabled={busy}>
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Sign envelope
                </Button>
                {sraResult && (
                  <p className="text-[12px] text-green-700">Signed. Mode (b) is now available inside this envelope only.</p>
                )}
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="breakers" className="mt-4">
          <Card>
            <CardHeader title="Circuit breakers" description="One-way ratchets: pause/freeze only, never authorize. Evaluated every run + 15-min watchdog." />
            <div className="divide-y divide-stone-100">
              {breakers.length === 0 && <p className="p-4 text-[13px] text-stone-500">No breaker events.</p>}
              {breakers.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-3 p-4">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-stone-900">
                      <span>{b.breakerType}</span>
                      <ValuePill tone="neutral">{b.scope}</ValuePill>
                      {b.acknowledgedBy ? (
                        <ValuePill tone="green">acknowledged — cool-down until {new Date(b.cooldownUntil).toLocaleString()}</ValuePill>
                      ) : (
                        <ValuePill tone="red">fired — awaiting acknowledgment</ValuePill>
                      )}
                    </div>
                    <p className="mt-1 text-[12px] text-stone-500">{b.reason}</p>
                  </div>
                  {!b.acknowledgedBy && isOwner && (
                    <Button size="sm" variant="outline" onClick={() => acknowledgeBreaker(b.id)} disabled={busy}>
                      Acknowledge
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="curves" className="mt-4">
          <Card>
            <CardHeader title="Marginal-ROAS curves" description="Best of Hill / power / log-log by R², with adstock + seasonality." />
            <div className="divide-y divide-stone-100">
              {curves.length === 0 && <p className="p-4 text-[13px] text-stone-500">No fitted curves yet.</p>}
              {curves.map((c) => (
                <div key={c.id} className="p-4 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-stone-900">{c.channel}</span>
                    <Badge variant="outline">{c.curveType}</Badge>
                    <ValuePill tone={c.rSquared >= 0.7 ? "green" : "orange"}>R² {Number(c.rSquared).toFixed(2)}</ValuePill>
                    <span className="text-[12px] text-stone-500">{c.dataWindow} · {c.modelVersion}</span>
                    {c.iroasCalibrationFactor && (
                      <ValuePill tone="accent">holdout-calibrated ×{Number(c.iroasCalibrationFactor).toFixed(2)}</ValuePill>
                    )}
                  </div>
                  <code className="mt-1 block truncate text-[11px] text-stone-500">{JSON.stringify(c.params)}</code>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="run" className="mt-4">
          <Card>
            <CardHeader
              title="Trigger optimizer run"
              description="Measurement-health pre-check runs first — degraded data freezes the run. Mode (b) additionally requires an active SRA."
            />
            <div className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[13px] text-stone-700">
                  Mode
                  <select
                    value={runMode}
                    onChange={(e) => setRunMode(e.target.value as "a" | "b")}
                    className="rounded-md border border-stone-200 bg-white px-2 py-1 text-[13px]"
                  >
                    <option value="a">(a) propose-only</option>
                    <option value="b" disabled={!activeSra}>(b) SRA guardrails{activeSra ? "" : " — no active SRA"}</option>
                  </select>
                </label>
                {runMode === "b" && activeSra && (
                  <span className="text-[12px] text-stone-500">Using SRA: {activeSra.name}</span>
                )}
                <Button onClick={triggerRun} disabled={busy}>
                  <Play className="mr-1 h-3.5 w-3.5" /> Run optimizer
                </Button>
              </div>
              <label className="text-[12px] text-stone-600">
                Channels JSON (lagged data points; the fixture below is pre-filled)
                <Textarea value={runChannels} onChange={(e) => setRunChannels(e.target.value)} rows={10} className="mt-1 font-mono text-[11px]" />
              </label>
              {runResult && (
                <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-[12px] text-stone-700">
                  Run {runResult.run?.id}: {runResult.proposals?.length ?? 0} proposals,{" "}
                  {runResult.run?.deniedCount ?? 0} denied, frozen={String(runResult.run?.frozen)}.{" "}
                  {runResult.run?.frozen ? "Frozen — see health snapshot / breaker trips." : ""}
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <Card>
            <CardHeader
              title="Audit log"
              description="Hash-chained, replayable. Every proposal, policy decision (allow and deny), execution, and breaker event."
              actions={
                chainIntact === null ? undefined : chainIntact ? (
                  <span className="flex items-center gap-1 text-[12px] text-green-700"><FileText className="h-3.5 w-3.5" /> chain intact</span>
                ) : (
                  <span className="flex items-center gap-1 text-[12px] text-red-700"><XCircle className="h-3.5 w-3.5" /> CHAIN BROKEN</span>
                )
              }
            />
            <div className="divide-y divide-stone-100">
              {audit.length === 0 && <p className="p-4 text-[13px] text-stone-500">No audit events yet.</p>}
              {audit.map((e) => (
                <div key={e.id} className="p-3 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <ValuePill tone="neutral">{e.kind}</ValuePill>
                    <span className="text-stone-500">{new Date(e.ts).toLocaleString()}</span>
                    <span className="text-stone-400">actor {e.actor}</span>
                    <code className="text-[10px] text-stone-400">{e.correlationId}</code>
                  </div>
                  <code className="mt-1 block truncate text-[11px] text-stone-500">{JSON.stringify(e.payload)}</code>
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
