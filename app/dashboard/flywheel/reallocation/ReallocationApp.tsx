// Marketr — F1 reallocation client app.
// Proposal queue + SRA envelopes + breakers + curves + audit, all API-driven.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  FileText,
  Play,
  ShieldCheck,
  ShieldX,
  XCircle,
  BarChart3,
  ScrollText,
} from "lucide-react";

type Tab = "proposals" | "sras" | "breakers" | "curves" | "audit" | "run";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

// Category chips are neutral by default (tone accepted for call-site compat).
function chip(text: React.ReactNode, cls?: string) {
  void cls;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[10px] font-semibold leading-tight text-muted shadow-control">
      {text}
    </span>
  );
}

// Approval/execution states carry the AOS status shape language:
// proposed = needs (triangle), approved/executed = done, denied/revoked = neutral.
function statusChip(s: string) {
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight";
  const shape = (extra: string) => (
    <span
      className={`aos-shape ${extra} [--aos-shape-size:9px]`}
      style={{ color: "inherit" }}
      aria-hidden
    />
  );
  const label = s.replace(/_/g, " ");
  if (s === "proposed")
    return (
      <span className={`${base} bg-needs text-ink`}>
        {shape("aos-shape--needs aos-shape--edged")} {label}
      </span>
    );
  if (s === "executed" || s === "human_approved" || s === "policy_approved" || s === "active")
    return (
      <span className={`${base} bg-done text-white`}>
        {shape("aos-shape--done")} {label}
      </span>
    );
  if (s === "policy_denied" || s === "revoked" || s === "expired")
    return <span className={`${base} bg-paper text-muted shadow-control`}>{label}</span>;
  return (
    <span className={`${base} bg-needs text-ink`}>
      {shape("aos-shape--needs aos-shape--edged")} {label}
    </span>
  );
}

const HI = "mt-1 border-line bg-white text-[13px] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]";
const HSELECT = "rounded-md border border-line bg-white px-2 py-1 text-[13px] text-ink focus-visible:border-ink focus-visible:outline-none";

function DataTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Panel({ title, description, action, children }: {
  title: string; description?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
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

  const TABS: { id: Tab; label: string; icon: typeof FileText; count?: number }[] = [
    { id: "proposals", label: `Proposals (${proposals.length})`, icon: FileText, count: proposals.length },
    { id: "sras", label: `SRA envelopes (${sras.length})`, icon: ShieldCheck },
    { id: "breakers", label: `Breakers (${breakers.length})`, icon: AlertTriangle },
    { id: "curves", label: `Curves (${curves.length})`, icon: BarChart3 },
    { id: "run", label: "Run optimizer", icon: Play },
    { id: "audit", label: "Audit log", icon: ScrollText },
  ];

  return (
    <div className="flex h-full flex-col gap-4">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-failed bg-failed-tint p-3 text-[13px] text-failed-text">
          <span className="mt-1 size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
          <span>{error}</span>
        </div>
      )}
      {frozenScopes.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-needs p-3 text-[13px] text-ink">
          <span
            className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:14px]"
            style={{ color: "inherit" }}
            aria-hidden
          />
          <span>
            Frozen scopes: {frozenScopes.join(", ")}. Breakers are one-way ratchets — they pause,
            never authorize. Acknowledge + 72h cool-down to resume.
          </span>
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition ${
              tab === id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-1">
        {tab === "proposals" && (
          <Panel
            title="Shift proposals"
            description="Each carries the full decision record: data window, curve params, R², model version."
            action={<Button size="sm" className="bg-paper text-ink shadow-outline hover:bg-hover-paper" onClick={refresh} disabled={loading}>Refresh</Button>}
          >
            {proposals.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">No proposals yet — trigger an optimizer run.</p>
            ) : (
              <DataTable headers={["Amount", "Shift", "Status", "Δ marginal ROAS", "Decision record", "Action"]}>
                {proposals.map((p) => (
                  <tr key={p.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-semibold text-ink">{money(p.amountCents)}</td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 text-[12px] text-muted">
                        <span className="text-subtle">{p.sourceChannel}</span>
                        <ArrowRight className="h-3.5 w-3.5 text-subtle" />
                        <span className="text-subtle">{p.destChannel}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {statusChip(p.status)}
                        {chip(`mode ${p.mode}`, "border-line bg-canvas text-muted")}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium text-ink">{Number(p.marginalRoasDelta).toFixed(2)}x</td>
                    <td className="max-w-xs px-3 py-2 text-[12px] text-muted">
                      {p.decisionRecord?.curveParams
                        ? Object.entries(p.decisionRecord.curveParams)
                            .map(([ch, c]: any) => `${ch}: ${c.curveType} R²=${Number(c.rSquared).toFixed(2)}`)
                            .join(" · ")
                        : "no curve record"}
                      {p.decisionRecord?.calibrationNote ? ` · ${p.decisionRecord.calibrationNote}` : ""}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        {p.mode === "a" && p.status === "proposed" && isOwner && (
                          <Button size="sm" className="bg-done text-white hover:brightness-110" onClick={() => approveProposal(p.id)} disabled={busy}>
                            <CheckCircle2 className="mr-1 h-3.5 w-3.5" /> Approve → approval object
                          </Button>
                        )}
                        {(p.status === "human_approved" || p.status === "policy_approved") && isOwner && (
                          <Button size="sm" className="bg-running text-white hover:brightness-110" onClick={() => executeProposal(p)} disabled={busy}>
                            <Play className="mr-1 h-3.5 w-3.5" /> Execute
                          </Button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        )}

        {tab === "sras" && (
          <div className="flex flex-col gap-4">
            <Panel
              title="Standing Reallocation Approvals"
              description="Pre-signed bounded envelopes — pool caps, not standing authority. Explicit opt-in; defaults to disabled; ≤30d expiry; instant revocation."
            >
              {sras.length === 0 ? (
                <p className="py-2 text-[13px] text-muted">No SRA envelopes. Mode (b) is disabled until one is signed.</p>
              ) : (
                <DataTable headers={["Envelope", "Status", "Caps", "Allowlist / expiry", "Action"]}>
                  {sras.map((s) => (
                    <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-3 py-2">
                        <span className="font-medium text-ink">{s.name}</span>
                        {s.consequences && (
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[12px] text-muted">
                            {s.consequences.map((c: string, i: number) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-3 py-2">{statusChip(s.computedStatus ?? s.status)}</td>
                      <td className="px-3 py-2 text-[12px] text-muted">
                        {money(s.perShiftCapCents)}/shift · {money(s.dailyAggregateCapCents)}/day · {money(s.weeklyAggregateCapCents)}/wk · ±{s.perChannelBandPct}% band
                      </td>
                      <td className="px-3 py-2 text-[12px] text-muted">
                        {Array.isArray(s.channels) ? s.channels.join(", ") : ""} · expires{" "}
                        {new Date(s.validUntil).toLocaleDateString()} · signers: {(s.signerIds ?? []).length}
                      </td>
                      <td className="px-3 py-2">
                        {isOwner && (s.computedStatus ?? s.status) === "active" && (
                          <Button size="sm" className="bg-white text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint" onClick={() => revokeSra(s.id)} disabled={busy}>
                            <ShieldX className="mr-1 h-3.5 w-3.5" /> Revoke instantly
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </Panel>

            {isOwner && (
              <Panel title="Sign a new SRA" description="Deliberate act with plain-language consequences. Conservative defaults.">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-[13px] font-medium text-muted">Name<Input value={sraName} onChange={(e) => setSraName(e.target.value)} className={HI} /></label>
                  <label className="text-[13px] font-medium text-muted">Channels (comma-separated allowlist)<Input value={sraChannels} onChange={(e) => setSraChannels(e.target.value)} className={HI} /></label>
                  <label className="text-[13px] font-medium text-muted">Valid until<Input type="date" value={sraValidUntil} onChange={(e) => setSraValidUntil(e.target.value)} className={HI} /></label>
                  <label className="text-[13px] font-medium text-muted">Pool daily budget ($)<Input value={sraPool} onChange={(e) => setSraPool(e.target.value)} className={HI} /></label>
                  <label className="text-[13px] font-medium text-muted md:col-span-2">Signer IDs (comma-separated — 2 required when cumulative movement can reach $1k)<Input value={sraSigners} onChange={(e) => setSraSigners(e.target.value)} className={HI} placeholder="user_1, user_2" /></label>
                </div>
                <div className="mt-3 flex items-center gap-3 border-t border-line pt-4">
                  <Button className="bg-needs text-ink hover:brightness-95" onClick={createSra} disabled={busy}>
                    <ShieldCheck className="mr-1 h-3.5 w-3.5" /> Sign envelope
                  </Button>
                  {sraResult && (
                    <p className="text-[12px] text-ink">Signed. Mode (b) is now available inside this envelope only.</p>
                  )}
                </div>
              </Panel>
            )}
          </div>
        )}

        {tab === "breakers" && (
          <Panel title="Circuit breakers" description="One-way ratchets: pause/freeze only, never authorize. Evaluated every run + 15-min watchdog.">
            {breakers.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">No breaker events.</p>
            ) : (
              <DataTable headers={["Breaker", "Scope", "Status", "Reason", "Action"]}>
                {breakers.map((b) => (
                  <tr key={b.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2 font-medium text-ink">
                        <AlertTriangle className="h-4 w-4 text-ink" />
                        {b.breakerType}
                      </span>
                    </td>
                    <td className="px-3 py-2">{chip(b.scope, "border-line bg-hover text-muted")}</td>
                    <td className="px-3 py-2">
                      {b.acknowledgedBy
                        ? chip(`acknowledged — cool-down until ${new Date(b.cooldownUntil).toLocaleString()}`)
                        : (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-needs px-2 py-0.5 text-[10px] font-semibold leading-tight text-ink">
                            <span
                              className="aos-shape aos-shape--needs aos-shape--edged [--aos-shape-size:9px]"
                              style={{ color: "inherit" }}
                              aria-hidden
                            />
                            fired — awaiting acknowledgment
                          </span>
                        )}
                    </td>
                    <td className="max-w-xs px-3 py-2 text-[12px] text-muted">{b.reason}</td>
                    <td className="px-3 py-2">
                      {!b.acknowledgedBy && isOwner && (
                        <Button size="sm" className="bg-ink text-white hover:bg-night-hover" onClick={() => acknowledgeBreaker(b.id)} disabled={busy}>
                          Acknowledge
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        )}

        {tab === "curves" && (
          <Panel title="Marginal-ROAS curves" description="Best of Hill / power / log-log by R², with adstock + seasonality.">
            {curves.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">No fitted curves yet.</p>
            ) : (
              <DataTable headers={["Channel", "Curve", "R²", "Window / model", "Params"]}>
                {curves.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium text-ink">{c.channel}</td>
                    <td className="px-3 py-2">{chip(c.curveType, "border-line bg-canvas text-muted")}</td>
                    <td className="px-3 py-2">
                      {chip(`R² ${Number(c.rSquared).toFixed(2)}`)}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted">{c.dataWindow} · {c.modelVersion}</td>
                    <td className="px-3 py-2">
                      <code className="block max-w-xs truncate text-[11px] text-muted">{JSON.stringify(c.params)}</code>
                      {c.iroasCalibrationFactor && chip(`holdout-calibrated ×${Number(c.iroasCalibrationFactor).toFixed(2)}`, "border-line bg-hover-paper text-ink")}
                    </td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        )}

        {tab === "run" && (
          <Panel
            title="Trigger optimizer run"
            description="Measurement-health pre-check runs first — degraded data freezes the run. Mode (b) additionally requires an active SRA."
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[13px] font-medium text-muted">
                  Mode
                  <select
                    value={runMode}
                    onChange={(e) => setRunMode(e.target.value as "a" | "b")}
                    className={HSELECT}
                  >
                    <option value="a">(a) propose-only</option>
                    <option value="b" disabled={!activeSra}>(b) SRA guardrails{activeSra ? "" : " — no active SRA"}</option>
                  </select>
                </label>
                {runMode === "b" && activeSra && (
                  <span className="text-[12px] text-muted">Using SRA: {activeSra.name}</span>
                )}
                <Button className="bg-running text-white hover:brightness-110" onClick={triggerRun} disabled={busy}>
                  <Play className="mr-1 h-3.5 w-3.5" /> Run optimizer
                </Button>
              </div>
              <label className="text-[13px] font-medium text-muted">
                Channels JSON (lagged data points; the fixture below is pre-filled)
                <Textarea value={runChannels} onChange={(e) => setRunChannels(e.target.value)} rows={10} className="mt-1 border-line bg-white font-mono text-[11px] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]" />
              </label>
              {runResult && (
                <div className="rounded-lg border border-line bg-canvas p-3 text-[12px] text-muted">
                  Run {runResult.run?.id}: {runResult.proposals?.length ?? 0} proposals,{" "}
                  {runResult.run?.deniedCount ?? 0} denied, frozen={String(runResult.run?.frozen)}.{" "}
                  {runResult.run?.frozen ? "Frozen — see health snapshot / breaker trips." : ""}
                </div>
              )}
            </div>
          </Panel>
        )}

        {tab === "audit" && (
          <Panel
            title="Audit log"
            description="Hash-chained, replayable. Every proposal, policy decision (allow and deny), execution, and breaker event."
            action={
              chainIntact === null ? undefined : chainIntact ? (
                <span className="flex items-center gap-1 text-[12px] text-ink"><CheckCircle2 className="h-3.5 w-3.5" /> chain intact</span>
              ) : (
                <span className="flex items-center gap-1 text-[12px] text-failed-text"><XCircle className="h-3.5 w-3.5" /> CHAIN BROKEN</span>
              )
            }
          >
            {audit.length === 0 ? (
              <p className="py-2 text-[13px] text-muted">No audit events yet.</p>
            ) : (
              <DataTable headers={["Kind", "Time", "Actor", "Correlation", "Payload"]}>
                {audit.map((e) => (
                  <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2">{chip(e.kind, "border-line bg-hover text-muted")}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">{new Date(e.ts).toLocaleString()}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">{e.actor}</td>
                    <td className="px-3 py-2"><code className="text-[10px] text-subtle">{e.correlationId}</code></td>
                    <td className="px-3 py-2"><code className="block max-w-xs truncate text-[11px] text-muted">{JSON.stringify(e.payload)}</code></td>
                  </tr>
                ))}
              </DataTable>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}
