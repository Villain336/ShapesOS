// Marketr — Wave 2 Insurance slice 1: policy inventory, renewal alerts,
// declarations-page import. House pattern: StudioApp.tsx (AGENTS.md) — dense
// tables, brand buttons, Lucide icons, --brand-* vars (never hardcoded).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  CalendarClock,
  FileUp,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  DECLARATIONS_REVIEW_THRESHOLD,
  LINE_LABELS,
  parseDeclarationsText,
  type InsuranceLineOfBusiness,
  type ParsedDeclarations,
  type RenewalAlertLevel,
} from "@/lib/insurance/types";

// ── House atoms ──────────────────────────────────────────────────────────────

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";

const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";

const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function alertTone(level: RenewalAlertLevel): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (level) {
    case "critical": return "red";
    case "warning": return "amber";
    case "info": return "blue";
    default: return "slate";
  }
}

function alertLabel(level: RenewalAlertLevel): string {
  switch (level) {
    case "critical": return "Renews ≤ 30 days";
    case "warning": return "Renews ≤ 60 days";
    case "info": return "Renews ≤ 90 days";
    default: return "Current";
  }
}

function fmtMoney(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface PolicyRow {
  id: string;
  policyNumber: string;
  line: string;
  lineLabel: string;
  carrierName: string;
  amBestRating: string | null;
  namedInsured: string;
  effectiveAt: string;
  expiresAt: string;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  deductibleCents: number | null;
  annualPremiumCents: number | null;
  paymentSchedule: string | null;
  status: string;
  source: string;
  alertLevel: RenewalAlertLevel;
}

type Tab = "policies" | "renewals" | "quoting" | "import";

interface QuoteRow {
  id: string;
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  quoteExpiry: string;
  status: "quoted" | "declined" | "referred";
  declineReason?: string;
  premiumPerMillionAggregateCents: number | null;
  rank: number | null;
}

interface SubmissionRow {
  id: string;
  line: string;
  lineLabel: string;
  applicantName: string;
  state: string;
  status: string;
  vendorRef: string | null;
  createdAt: string;
  quotes: QuoteRow[];
}

// ── Component ────────────────────────────────────────────────────────────────

export function InsuranceApp() {
  const [tab, setTab] = useState<Tab>("policies");
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [declText, setDeclText] = useState("");
  const [parsed, setParsed] = useState<ParsedDeclarations | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [intake, setIntake] = useState({
    line: "gl",
    applicantName: "",
    operationsDescription: "",
    state: "",
    classCode: "",
    payrollCents: "",
    revenueCents: "",
  });
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/insurance/policies");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setPolicies(data.policies ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const active = policies.filter((p) => p.status === "active").length;
    const critical = policies.filter((p) => p.alertLevel === "critical").length;
    const premium = policies.reduce((s, p) => s + (p.annualPremiumCents ?? 0), 0);
    return { total: policies.length, active, critical, premium };
  }, [policies]);

  const renewals = useMemo(
    () =>
      policies
        .filter((p) => p.alertLevel !== "none")
        .sort((a, b) => +new Date(a.expiresAt) - +new Date(b.expiresAt)),
    [policies],
  );

  const loadSubmissions = useCallback(async () => {
    setSubsLoading(true);
    setQuoteError(null);
    try {
      const res = await fetch("/api/insurance/submissions");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setSubmissions(data.submissions ?? []);
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setSubsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "quoting") void loadSubmissions();
  }, [tab, loadSubmissions]);

  const handleQuote = useCallback(async () => {
    setQuoting(true);
    setQuoteError(null);
    try {
      const res = await fetch("/api/insurance/submissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line: intake.line,
          applicantName: intake.applicantName,
          operationsDescription: intake.operationsDescription || null,
          state: intake.state.toUpperCase(),
          classCode: intake.classCode || null,
          payrollCents: intake.payrollCents ? Math.round(Number(intake.payrollCents) * 100) : null,
          revenueCents: intake.revenueCents ? Math.round(Number(intake.revenueCents) * 100) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Quote failed (${res.status})`);
      await loadSubmissions();
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : "Quote failed");
    } finally {
      setQuoting(false);
    }
  }, [intake, loadSubmissions]);

  const handleParse = useCallback(() => {
    setSaveError(null);
    setParsed(parseDeclarationsText(declText));
  }, [declText]);

  const handleSave = useCallback(async () => {
    if (!parsed) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/insurance/policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policyNumber: parsed.policyNumber,
          carrierName: parsed.carrierName,
          line: parsed.line,
          namedInsured: parsed.namedInsured,
          effectiveAt: parsed.effectiveAt?.toISOString(),
          expiresAt: parsed.expiresAt?.toISOString(),
          limitPerOccurrenceCents: parsed.limitPerOccurrenceCents,
          limitAggregateCents: parsed.limitAggregateCents,
          deductibleCents: parsed.deductibleCents,
          annualPremiumCents: parsed.annualPremiumCents,
          declarationsText: declText,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setDeclText("");
      setParsed(null);
      setTab("policies");
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [parsed, declText, load]);

  const canSave =
    parsed != null &&
    parsed.policyNumber != null &&
    parsed.carrierName != null &&
    parsed.line != null &&
    parsed.namedInsured != null &&
    parsed.effectiveAt != null &&
    parsed.expiresAt != null &&
    !saving;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { label: "Policies", value: String(stats.total) },
          { label: "Active", value: String(stats.active) },
          { label: "Renewing ≤ 30 days", value: String(stats.critical) },
          { label: "Annual premium", value: fmtMoney(stats.premium) },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-stone-200 bg-white px-3 py-2.5 shadow-sm">
            <div className="text-[11px] font-medium text-stone-500">{s.label}</div>
            <div className="mt-0.5 text-lg font-bold tracking-tight text-stone-900">{s.value}</div>
          </div>
        ))}
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 border-b border-stone-200">
        {(
          [
            { key: "policies", label: "Policies", icon: ShieldCheck },
            { key: "renewals", label: "Renewals", icon: CalendarClock },
            { key: "quoting", label: "Quoting", icon: Plus },
            { key: "import", label: "Import declarations", icon: FileUp },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
              tab === key
                ? "border-[var(--brand-600)] text-[var(--brand-700)]"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
        <div className="ml-auto pb-1">
          <button className={btnGhost} onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-stone-500">
          <Loader2 size={16} className="animate-spin" />
          <span className="text-[13px]">Loading policies…</span>
        </div>
      ) : tab === "policies" ? (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2">Policy</th>
                <th className="px-3 py-2">Line</th>
                <th className="px-3 py-2">Carrier</th>
                <th className="px-3 py-2">Limits (occ / agg)</th>
                <th className="px-3 py-2">Premium</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-stone-500">
                    No policies yet — import a declarations page to get started.
                  </td>
                </tr>
              )}
              {policies.map((p) => (
                <tr key={p.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2">
                    <div className="font-medium text-stone-900">{p.policyNumber}</div>
                    <div className="text-[11px] text-stone-500">{p.namedInsured}</div>
                  </td>
                  <td className="px-3 py-2"><Chip tone="slate">{p.lineLabel}</Chip></td>
                  <td className="px-3 py-2">
                    <div className="text-stone-800">{p.carrierName}</div>
                    {p.amBestRating && (
                      <div className="text-[11px] text-stone-500">AM Best {p.amBestRating}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-700">
                    {fmtMoney(p.limitPerOccurrenceCents)} / {fmtMoney(p.limitAggregateCents)}
                  </td>
                  <td className="px-3 py-2 text-stone-700">{fmtMoney(p.annualPremiumCents)}</td>
                  <td className="px-3 py-2 text-stone-700">{fmtDate(p.expiresAt)}</td>
                  <td className="px-3 py-2">
                    <Chip tone={p.status === "active" ? "green" : p.status === "pending_renewal" ? "amber" : "slate"}>
                      {p.status.replace(/_/g, " ")}
                    </Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === "renewals" ? (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2">Policy</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2">Alert</th>
                <th className="px-3 py-2">Annual premium</th>
                <th className="px-3 py-2">Next step</th>
              </tr>
            </thead>
            <tbody>
              {renewals.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-stone-500">
                    <BellRing size={16} className="mx-auto mb-2 text-stone-400" />
                    No renewals inside the 90-day window.
                  </td>
                </tr>
              )}
              {renewals.map((p) => (
                <tr key={p.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="px-3 py-2">
                    <div className="font-medium text-stone-900">{p.policyNumber}</div>
                    <div className="text-[11px] text-stone-500">{p.carrierName} · {p.lineLabel}</div>
                  </td>
                  <td className="px-3 py-2 text-stone-700">{fmtDate(p.expiresAt)}</td>
                  <td className="px-3 py-2">
                    <Chip tone={alertTone(p.alertLevel)}>{alertLabel(p.alertLevel)}</Chip>
                  </td>
                  <td className="px-3 py-2 text-stone-700">{fmtMoney(p.annualPremiumCents)}</td>
                  <td className="px-3 py-2 text-[12px] text-stone-500">
                    Remarket in slice 2 · agent flags deltas before approval
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === "quoting" ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-[14px] font-semibold text-stone-900">New submission</h2>
            <p className="mt-0.5 text-[12px] text-stone-500">
              Submitting a risk discloses business data to carriers — quotes are
              non-binding. Fixture carrier data until CoverForce credentials exist.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                Line of business
                <select
                  value={intake.line}
                  onChange={(e) => setIntake({ ...intake, line: e.target.value })}
                  className={inputCls}
                >
                  {(Object.keys(LINE_LABELS) as Array<keyof typeof LINE_LABELS>).map((l) => (
                    <option key={l} value={l}>{LINE_LABELS[l]}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                Applicant name
                <input
                  value={intake.applicantName}
                  onChange={(e) => setIntake({ ...intake, applicantName: e.target.value })}
                  placeholder="Acme Landscaping LLC"
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                State (2-letter)
                <input
                  value={intake.state}
                  onChange={(e) => setIntake({ ...intake, state: e.target.value })}
                  placeholder="NC"
                  maxLength={2}
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                Operations description
                <input
                  value={intake.operationsDescription}
                  onChange={(e) => setIntake({ ...intake, operationsDescription: e.target.value })}
                  placeholder="Commercial landscaping, 12 employees"
                  className={inputCls}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                Class code
                <input
                  value={intake.classCode}
                  onChange={(e) => setIntake({ ...intake, classCode: e.target.value })}
                  placeholder="0042"
                  className={inputCls}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Payroll ($)
                  <input
                    value={intake.payrollCents}
                    onChange={(e) => setIntake({ ...intake, payrollCents: e.target.value })}
                    placeholder="1200000"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Revenue ($)
                  <input
                    value={intake.revenueCents}
                    onChange={(e) => setIntake({ ...intake, revenueCents: e.target.value })}
                    placeholder="2500000"
                    inputMode="decimal"
                    className={inputCls}
                  />
                </label>
              </div>
            </div>
            {quoteError && (
              <div className="mt-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                <AlertTriangle size={14} />
                {quoteError}
              </div>
            )}
            <button
              className={`${btnPrimary} mt-3`}
              onClick={() => void handleQuote()}
              disabled={quoting || !intake.applicantName.trim() || intake.state.trim().length !== 2}
            >
              {quoting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              {quoting ? "Requesting quotes…" : "Submit & get quotes"}
            </button>
          </div>

          {subsLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-stone-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-[13px]">Loading submissions…</span>
            </div>
          ) : (
            submissions.map((s) => (
              <div key={s.id} className="rounded-lg border border-stone-200 bg-white shadow-sm">
                <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
                  <span className="text-[13px] font-semibold text-stone-900">{s.applicantName}</span>
                  <Chip tone="slate">{s.lineLabel}</Chip>
                  <Chip tone={s.status === "quoted" ? "green" : s.status === "declined" ? "red" : "blue"}>
                    {s.status}
                  </Chip>
                  <span className="ml-auto text-[11px] text-stone-500">
                    {s.vendorRef} · {fmtDate(s.createdAt)}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-stone-100 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                        <th className="px-4 py-2">Carrier</th>
                        <th className="px-3 py-2">Premium</th>
                        <th className="px-3 py-2">Limits (occ / agg)</th>
                        <th className="px-3 py-2">$/ $1M agg</th>
                        <th className="px-3 py-2">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.quotes.map((q) => (
                        <tr key={q.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                          <td className="px-4 py-2">
                            <span className="font-medium text-stone-900">{q.carrierName}</span>
                            {q.rank === 1 && (
                              <span className="ml-2"><Chip tone="green">Best premium</Chip></span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-stone-700">{fmtMoney(q.quotedPremiumCents)}</td>
                          <td className="px-3 py-2 text-stone-700">
                            {fmtMoney(q.limitPerOccurrenceCents)} / {fmtMoney(q.limitAggregateCents)}
                          </td>
                          <td className="px-3 py-2 text-stone-700">
                            {q.premiumPerMillionAggregateCents != null
                              ? fmtMoney(q.premiumPerMillionAggregateCents)
                              : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {q.status === "quoted" ? (
                              <Chip tone="green">Quoted</Chip>
                            ) : q.status === "referred" ? (
                              <Chip tone="amber">Referred</Chip>
                            ) : (
                              <span className="flex flex-col gap-0.5">
                                <Chip tone="red">Declined</Chip>
                                {q.declineReason && (
                                  <span className="text-[11px] text-stone-500">{q.declineReason}</span>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
          {!subsLoading && submissions.length === 0 && (
            <p className="py-8 text-center text-[13px] text-stone-500">
              No submissions yet — submit a risk above to get carrier quotes.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-[14px] font-semibold text-stone-900">Paste a declarations page</h2>
            <p className="mt-0.5 text-[12px] text-stone-500">
              The parser extracts what it finds and leaves the rest blank — coverage is
              never invented. Low-confidence parses (&lt; {Math.round(DECLARATIONS_REVIEW_THRESHOLD * 100)}%) are flagged for review.
            </p>
            <textarea
              value={declText}
              onChange={(e) => setDeclText(e.target.value)}
              rows={14}
              placeholder="Paste declarations-page text (or OCR output) here…"
              className={`${inputCls} mt-3 w-full font-mono text-[12px]`}
            />
            <div className="mt-3 flex gap-2">
              <button className={btnPrimary} onClick={handleParse} disabled={!declText.trim()}>
                <FileUp size={14} />
                Parse
              </button>
              {parsed && (
                <button className={btnGhost} onClick={() => { setParsed(null); setSaveError(null); }}>
                  <X size={14} />
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
            <h2 className="text-[14px] font-semibold text-stone-900">Parse preview</h2>
            {!parsed ? (
              <p className="mt-2 text-[12px] text-stone-500">
                Nothing parsed yet. Paste declarations text and press Parse.
              </p>
            ) : (
              <>
                {parsed.confidence < DECLARATIONS_REVIEW_THRESHOLD && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                    <AlertTriangle size={14} />
                    Low confidence ({Math.round(parsed.confidence * 100)}%) — review every field before saving.
                  </div>
                )}
                <dl className="mt-3 space-y-1.5 text-[13px]">
                  {(
                    [
                      ["Policy number", parsed.policyNumber],
                      ["Carrier", parsed.carrierName],
                      ["Named insured", parsed.namedInsured],
                      ["Line", parsed.line ? LINE_LABELS[parsed.line as InsuranceLineOfBusiness] : null],
                      ["Effective", parsed.effectiveAt ? fmtDate(parsed.effectiveAt.toISOString()) : null],
                      ["Expires", parsed.expiresAt ? fmtDate(parsed.expiresAt.toISOString()) : null],
                      ["Per-occurrence limit", parsed.limitPerOccurrenceCents != null ? fmtMoney(parsed.limitPerOccurrenceCents) : null],
                      ["Aggregate limit", parsed.limitAggregateCents != null ? fmtMoney(parsed.limitAggregateCents) : null],
                      ["Deductible", parsed.deductibleCents != null ? fmtMoney(parsed.deductibleCents) : null],
                      ["Annual premium", parsed.annualPremiumCents != null ? fmtMoney(parsed.annualPremiumCents) : null],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k} className="flex justify-between gap-3 border-b border-stone-100 pb-1">
                      <dt className="text-stone-500">{k}</dt>
                      <dd className={`font-medium ${v == null ? "text-stone-400" : "text-stone-900"}`}>
                        {v ?? "not confirmed"}
                      </dd>
                    </div>
                  ))}
                </dl>
                {saveError && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                    <AlertTriangle size={14} />
                    {saveError}
                  </div>
                )}
                <button className={`${btnPrimary} mt-3`} onClick={() => void handleSave()} disabled={!canSave}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  {saving ? "Saving…" : "Save to inventory"}
                </button>
                {!canSave && !saving && parsed && (
                  <p className="mt-1.5 text-[11px] text-stone-500">
                    Policy number, carrier, line, named insured, and a valid term are required to save.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
