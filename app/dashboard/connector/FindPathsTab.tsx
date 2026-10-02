// Marketr — Connector Agent slice 3: "Find a path" tab (client).
// Pick a target person or company → ranked mutual paths
// (You → mutual → target) with warmth-product scores, freshness, and
// explanations composed from stored relationship data only.
// Slice 5: mode-scoped. LEADS filters the company picker to
// customer/prospect/partner; FUNDING filters to investor companies AND
// shows the Funding/VC investor CRM targets (thesis fit, check size,
// stage) with a warm-path shortcut when the investor matches a network
// person by email. The effective mode rides on every path query.
// Agentic OS design system: canvas page, white surfaces, black primary
// pills, Lucide only, tokens only. Scores render monochrome — status
// colors are reserved for agent states.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  HandCoins,
  Loader2,
  RefreshCw,
  Route,
  Search,
  ShieldAlert,
} from "lucide-react";
import type {
  ComputedIntroPath,
  IntroPathResult,
} from "@/lib/connector/intro-paths";
import type {
  ConnectorCompanyView,
  ConnectorPersonView,
} from "@/lib/connector/types";
import type {
  ConnectorMode,
  FundingInvestorTargetView,
} from "@/lib/connector/modes";

/** Mode-scoped company filter. Pure — mirrors companyRelationshipAllowedInMode. */
export function filterCompaniesByMode(
  companies: ConnectorCompanyView[],
  mode: ConnectorMode,
): ConnectorCompanyView[] {
  return companies.filter((c) =>
    mode === "funding"
      ? c.relationship === "investor"
      : c.relationship === "customer" ||
        c.relationship === "prospect" ||
        c.relationship === "partner",
  );
}

function formatCheckSize(min: number | null, max: number | null): string {
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `$${Math.round(n / 1000)}k`;
  if (min != null && max != null) return `${fmt(min)}–${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  if (max != null) return `up to ${fmt(max)}`;
  return "—";
}

function StrengthMeter({ strength }: { strength: number }) {
  const pct = Math.round(strength * 100);
  return (
    <span className="flex items-center gap-2" title={`Path strength ${pct}%`}>
      <span className="h-2 w-24 overflow-hidden rounded-full bg-canvas">
        <span className="block h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[13px] font-semibold text-ink">{pct}%</span>
    </span>
  );
}

function PathCard({ path, rank }: { path: ComputedIntroPath; rank: number }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg bg-paper p-5 shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black text-[12px] text-white">
            {rank}
          </span>
          {path.hops.map((h, i) => (
            <span key={`${h.kind}-${h.id ?? "tenant"}`} className="flex items-center gap-1.5">
              {i > 0 && <ArrowRight size={14} className="text-muted" />}
              <span className={i === 0 ? "text-muted" : ""}>{h.name}</span>
            </span>
          ))}
        </div>
        <StrengthMeter strength={path.strength} />
      </div>

      <p className="text-[14px] leading-relaxed text-ink">{path.explanation.text}</p>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span>
          Your warmth with {path.mutual.name}:{" "}
          <span className="font-semibold text-ink">{path.components.tenantWarmth}/100</span>
        </span>
        <span>
          Their link:{" "}
          <span className="font-semibold text-ink">
            {Math.round(path.components.linkStrength * 100)}%
          </span>
        </span>
        <span>
          Freshness:{" "}
          <span className="font-semibold text-ink">
            {Math.round(path.components.freshness * 100)}%
          </span>
        </span>
        <span>
          Last touch:{" "}
          <span className="font-semibold text-ink">
            {path.explanation.facts.lastTouchText}
          </span>
        </span>
      </div>
    </div>
  );
}

export function FindPathsTab({
  persons,
  companies,
  mode,
}: {
  persons: ConnectorPersonView[];
  companies: ConnectorCompanyView[];
  mode: ConnectorMode;
}) {
  const [targetPersonId, setTargetPersonId] = useState("");
  const [targetCompanyId, setTargetCompanyId] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(IntroPathResult & { cached: boolean }) | null>(null);
  // Slice 5: FUNDING-mode investor CRM targets (read-only).
  const [investors, setInvestors] = useState<FundingInvestorTargetView[] | null>(null);

  const modeCompanies = filterCompaniesByMode(companies, mode);

  useEffect(() => {
    if (mode !== "funding") {
      setInvestors(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/connector/targets?mode=funding");
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled) setInvestors(json.investors ?? []);
      } catch {
        if (!cancelled) setInvestors([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Reset the target pickers when the mode changes — a buyer company is
  // not a legal FUNDING-mode target and vice versa.
  useEffect(() => {
    setTargetPersonId("");
    setTargetCompanyId("");
    setResult(null);
    setError(null);
  }, [mode]);

  /** Network person matching an investor by email handle (warm-path shortcut). */
  const matchPersonForInvestor = useCallback(
    (investor: FundingInvestorTargetView): ConnectorPersonView | null => {
      if (!investor.email) return null;
      const email = investor.email.trim().toLowerCase();
      return (
        persons.find((p) => p.handles.some((h) => h.trim().toLowerCase() === email)) ?? null
      );
    },
    [persons],
  );

  const findPaths = useCallback(
    async (recompute: boolean) => {
      if (!targetPersonId && !targetCompanyId) {
        setError("Pick a person or a company first.");
        return;
      }
      if (recompute) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/connector/paths", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(targetPersonId ? { targetPersonId } : { targetCompanyId }),
            mode,
            recompute,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not find paths.");
        setResult(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not find paths.");
        setResult(null);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [targetPersonId, targetCompanyId, mode],
  );

  const pickPerson = (id: string) => {
    setTargetPersonId(id);
    if (id) setTargetCompanyId("");
  };
  const pickCompany = (id: string) => {
    setTargetCompanyId(id);
    if (id) setTargetPersonId("");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">Target person</span>
            <select
              value={targetPersonId}
              onChange={(e) => pickPerson(e.target.value)}
              className="h-control rounded-md border border-control bg-paper px-3 text-[15px] text-ink"
            >
              <option value="">— choose a person —</option>
              {persons.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.roles[0] ? ` — ${p.roles[0]}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">
              Target company{mode === "funding" ? " (investors)" : " (customers / partners)"}
            </span>
            <select
              value={targetCompanyId}
              onChange={(e) => pickCompany(e.target.value)}
              className="h-control rounded-md border border-control bg-paper px-3 text-[15px] text-ink"
            >
              <option value="">— choose a company —</option>
              {modeCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={loading || refreshing || (!targetPersonId && !targetCompanyId)}
            onClick={() => findPaths(false)}
            className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[15px] font-semibold text-white disabled:opacity-50"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {loading ? "Finding" : "Find a path"}
          </button>
          <button
            type="button"
            disabled={loading || refreshing || (!targetPersonId && !targetCompanyId)}
            onClick={() => findPaths(true)}
            className="aos-press flex h-11 items-center gap-2 rounded-full bg-paper px-5 text-[15px] font-semibold text-ink shadow-outline disabled:opacity-50"
            title="Recompute paths fresh instead of using the cache"
          >
            {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {refreshing ? "Recomputing" : "Recompute"}
          </button>
        </div>
      </div>

      {/* Slice 5: FUNDING-mode investor CRM targets (read-only). A
          proposal to an investor rides mode: "funding" +
          fundingInvestorId — and writes back to the raise workflow when
          made. */}
      {mode === "funding" && (
        <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
          <div className="flex items-center gap-2">
            <HandCoins size={15} className="text-ink" />
            <p className="aos-subheading">Investor targets — your raise CRM</p>
          </div>
          {investors == null ? (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading investor targets
            </p>
          ) : investors.length === 0 ? (
            <p className="text-[13px] text-muted">
              No investors in the CRM yet. Add them in the Funding module, then
              target them here.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {investors.map((inv) => {
                const match = matchPersonForInvestor(inv);
                return (
                  <div
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-canvas px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-ink">
                        {inv.name}
                        {inv.firm ? <span className="font-normal text-muted"> · {inv.firm}</span> : null}
                      </p>
                      <p className="mt-0.5 text-[12px] text-muted">
                        {inv.stage} · check {formatCheckSize(inv.checkSizeMin, inv.checkSizeMax)}
                        {inv.stages.length > 0 ? ` · ${inv.stages.join(", ")}` : ""}
                        {inv.thesisFit ? ` · ${inv.thesisFit}` : ""}
                      </p>
                    </div>
                    {match ? (
                      <button
                        type="button"
                        onClick={() => {
                          pickPerson(match.id);
                          setTargetCompanyId("");
                        }}
                        className="aos-press flex h-9 shrink-0 items-center gap-2 rounded-full bg-black px-4 text-[13px] font-semibold text-white"
                        title={`Find a warm path to ${match.name} (matched by email)`}
                      >
                        <Route size={14} />
                        Path to {match.name}
                      </button>
                    ) : (
                      <span className="shrink-0 text-[12px] text-muted">
                        No network contact yet — add them to find a path
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {result && result.blocked === "target_excluded" && (
        <div className="flex items-start gap-2 rounded-lg bg-paper p-5 text-[14px] text-muted shadow-hairline">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          This target is on your exclusion list — no paths are computed through or
          to excluded contacts.
        </div>
      )}

      {result && !result.blocked && result.paths.length === 0 && (
        <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
          No warm path to <span className="font-semibold text-ink">{result.target.name}</span>{" "}
          yet. Paths need a mutual contact who shares a company with the target —
          and no boundary blocks on the way. Import more of your network or link
          people to their employers.
        </div>
      )}

      {result && result.paths.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted">
            {result.paths.length} {result.paths.length === 1 ? "path" : "paths"} to{" "}
            <span className="font-semibold text-ink">{result.target.name}</span>
            {result.cached ? " · from cache" : " · freshly computed"} — ranked by
            path strength (your warmth × their link × freshness).
          </p>
          {result.paths.map((p, i) => (
            <PathCard key={`${p.mutual.id}-${i}`} path={p} rank={i + 1} />
          ))}
        </div>
      )}

      {!result && !loading && (
        <div className="flex items-center gap-2 rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
          <Route size={16} className="shrink-0" />
          Your connector finds the warmest route: who you know, how well you know
          them, and how they connect to the person or company you want to reach.
        </div>
      )}
    </div>
  );
}
