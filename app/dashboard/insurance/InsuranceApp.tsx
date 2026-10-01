// Marketr — Wave 2 Insurance slice 1: policy inventory, renewal alerts,
// declarations-page import. House pattern: StudioApp.tsx (AGENTS.md) — dense
// tables, brand buttons, Lucide icons, --brand-* vars (never hardcoded).

"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  BellRing,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Eye,
  FileUp,
  Handshake,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  Stamp,
  X,
  XCircle,
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

type Tab = "policies" | "renewals" | "quoting" | "import" | "partners" | "approvals" | "certificates";

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

// ── Slice 3c: licensed partners + governed-action approvals ──────────────────

interface PartnerRow {
  id: string;
  name: string;
  contactEmail: string | null;
  licenseNumber: string | null;
  licensedStates: string[];
  appointmentPath: string;
  status: "active" | "suspended" | "revoked";
  appointedAt: string | null;
}

interface PendingApprovalRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  requestedBy: string | null;
  createdAt: string | null;
}

interface AppointedPartnerInfo {
  name: string;
  licenseNumber: string | null;
  licensedStates: string[];
  appointmentPath: string;
}

interface ApprovedBind {
  approvalId: string;
  quoteId: string;
  payload: Record<string, unknown>;
}

interface ExecutedBind {
  policyNumber: string;
  carrierName: string;
  carrierConfirmation: string | null;
  replayed: boolean;
}

const APPOINTMENT_PATH_LABELS: Record<string, string> = {
  direct: "Direct appointment",
  dais_market_access: "DAIS market access",
  subappointment: "Subappointment",
};

function actionLabel(kind: string): string {
  switch (kind) {
    case "insurance_bind_policy": return "Bind policy";
    case "insurance_request_quote": return "Request quote";
    case "insurance_issue_certificate": return "Issue certificate";
    default: return kind;
  }
}

function actionTone(kind: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (kind) {
    case "insurance_bind_policy": return "red";
    case "insurance_request_quote": return "blue";
    case "insurance_issue_certificate": return "amber";
    default: return "slate";
  }
}

function partnerTone(status: PartnerRow["status"]): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "active": return "green";
    case "suspended": return "amber";
    case "revoked": return "red";
    default: return "slate";
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function approvalSummary(a: PendingApprovalRow): string {
  const p = a.payload ?? {};
  const action = String(p.action ?? a.kind.replace(/^insurance_/, ""));
  const sid = String(p.subjectId ?? "");
  if (action === "bind_policy") {
    return `Quote ${shortId(sid)}${p.carrier ? ` · ${String(p.carrier)}` : ""}`;
  }
  return `${action.replace(/_/g, " ")} · ${shortId(sid)}`;
}

// ── Slice 4: renewal remarketing workflow ────────────────────────────────────

type RemarketStatus = "detected" | "remarketing" | "quoted" | "bound" | "auto_renew_surfaced";

interface RenewalQuoteRow {
  id: string;
  carrierName: string;
  quotedPremiumCents: number | null;
  limitPerOccurrenceCents: number | null;
  limitAggregateCents: number | null;
  status: string;
}

interface RenewalSubmissionRow {
  id: string;
  status: string;
  vendorRef: string | null;
  quotes: RenewalQuoteRow[];
}

interface RenewalRow {
  id: string;
  renewalDate: string;
  daysUntilRenewal: number;
  alertLevel: RenewalAlertLevel;
  remarketStatus: RemarketStatus;
  statusLabel: string;
  policyNumber: string | null;
  line: string | null;
  lineLabel: string | null;
  carrierName: string | null;
  namedInsured: string | null;
  expiresAt: string | null;
  priorPremiumCents: number | null;
  newPremiumCents: number | null;
  premiumDeltaPct: number | null;
  deltaFlagged: boolean;
  needsReview: boolean;
  autoRenewTerms: Record<string, unknown> | null;
  submission: RenewalSubmissionRow | null;
}

function remarketTone(status: RemarketStatus): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "detected": return "slate";
    case "remarketing": return "blue";
    case "quoted": return "violet";
    case "bound": return "green";
    case "auto_renew_surfaced": return "red";
    default: return "slate";
  }
}

function DeltaBadge({ deltaPct, flagged }: { deltaPct: number | null; flagged: boolean }) {
  if (deltaPct == null) return <span className="text-stone-400">—</span>;
  const sign = deltaPct > 0 ? "+" : "";
  return (
    <Chip tone={flagged ? "red" : "slate"}>
      {sign}{deltaPct.toFixed(1)}%
    </Chip>
  );
}

function fmtTermsValue(v: unknown): string {
  if (v == null) return "not confirmed";
  if (typeof v === "number" && Number.isInteger(v) && v >= 1000) return fmtMoney(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return fmtDate(v);
  return String(v);
}

// ── Slice 5: certificates (COI pipeline) ────────────────────────────────────

type CertificateStatus = "draft" | "issued" | "revoked";

interface CertificateRow {
  id: string;
  policyId: string;
  policyNumber: string | null;
  carrierName: string | null;
  lineLabel: string | null;
  holderName: string;
  holderAddress: string | null;
  additionalInsured: boolean;
  waiverOfSubrogation: boolean;
  operationsDescription: string | null;
  issueDate: string;
  validFrom: string;
  validTo: string;
  status: CertificateStatus;
  requestedBy: string | null;
  requestedFor: string | null;
  issuedBy: string | null;
  issuedAt: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  approvalPayload: Record<string, unknown> | null;
  pdfHash: string | null;
  revokedReason: string | null;
  revokedBy: string | null;
}

/**
 * The rendered certificate data a human reviews before approving: policy
 * truth on one side, the holder/endorsement input on the other. Unverified
 * fields read "not confirmed" — coverage is never invented.
 */
function CertificateReview({ payload }: { payload: Record<string, unknown> }) {
  const truth: Array<[string, unknown]> = [
    ["Policy number", payload.policyNumber],
    ["Carrier", payload.carrier],
    ["Named insured", payload.namedInsured],
    ["Line", payload.lineLabel],
    ["Per-occurrence limit", payload.limitPerOccurrenceCents],
    ["Aggregate limit", payload.limitAggregateCents],
    ["Deductible", payload.deductibleCents],
    ["Policy effective", payload.effectiveDate],
    ["Policy expiry", payload.expiryDate],
  ];
  const cert: Array<[string, unknown]> = [
    ["Holder", payload.holderName],
    ["Holder address", payload.holderAddress],
    ["Additional insured", payload.additionalInsured === true ? "YES" : payload.additionalInsured === false ? "NO" : null],
    ["Waiver of subrogation", payload.waiverOfSubrogation === true ? "YES" : payload.waiverOfSubrogation === false ? "NO" : null],
    ["Operations", payload.operationsDescription],
    ["Issue date", payload.issueDate],
    ["Valid from", payload.validFrom],
    ["Valid to", payload.validTo],
    ["Requested by", payload.requestedBy],
    ["Requested for", payload.requestedFor],
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">
          Policy truth — rendered from the in-force policy
        </h3>
        <dl className="mt-2 space-y-1.5 text-[13px]">
          {truth.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-stone-200/70 pb-1">
              <dt className="text-stone-500">{k}</dt>
              <dd className={`font-medium ${v == null ? "text-stone-400" : "text-stone-900"}`}>
                {fmtTermsValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-stone-500">
          Certificate — the reviewed input
        </h3>
        <dl className="mt-2 space-y-1.5 text-[13px]">
          {cert.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-stone-200/70 pb-1">
              <dt className="text-stone-500">{k}</dt>
              <dd className={`font-medium ${v == null ? "text-stone-400" : "text-stone-900"}`}>
                {fmtTermsValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

function certStatusTone(c: CertificateRow): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  if (c.status === "issued") return "green";
  if (c.status === "revoked") return "red";
  if (c.approvalStatus === "approved") return "blue";
  if (c.approvalStatus === "pending") return "amber";
  return "slate";
}

function certStatusLabel(c: CertificateRow): string {
  if (c.status === "issued") return "Issued";
  if (c.status === "revoked") return "Revoked";
  if (c.approvalStatus === "approved") return "Approved — ready to issue";
  if (c.approvalStatus === "pending") return "Pending review";
  return "Draft";
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

  // ── Partners tab (slice 3c) ────────────────────────────────────────────────

  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [partnersLoading, setPartnersLoading] = useState(false);
  const [partnersError, setPartnersError] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [reg, setReg] = useState({
    name: "",
    producerLicenseNumber: "",
    contactEmail: "",
    licensedStates: "",
    appointmentPath: "dais_market_access",
  });
  const [statusChanging, setStatusChanging] = useState<string | null>(null);

  const loadPartners = useCallback(async () => {
    setPartnersLoading(true);
    setPartnersError(null);
    try {
      const res = await fetch("/api/insurance/partners");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setPartners(data.partners ?? []);
    } catch (e) {
      setPartnersError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setPartnersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "partners") void loadPartners();
  }, [tab, loadPartners]);

  const handleRegister = useCallback(async () => {
    setRegistering(true);
    setRegisterError(null);
    try {
      const res = await fetch("/api/insurance/partners", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: reg.name,
          producerLicenseNumber: reg.producerLicenseNumber,
          contactEmail: reg.contactEmail || undefined,
          licensedStates: reg.licensedStates
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
          appointmentPath: reg.appointmentPath,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Registration failed (${res.status})`);
      setReg({
        name: "",
        producerLicenseNumber: "",
        contactEmail: "",
        licensedStates: "",
        appointmentPath: "dais_market_access",
      });
      setShowRegister(false);
      await loadPartners();
    } catch (e) {
      setRegisterError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  }, [reg, loadPartners]);

  const handleStatusChange = useCallback(
    async (p: PartnerRow, status: PartnerRow["status"]) => {
      const consequence =
        status === "active"
          ? "This partner will be able to satisfy the bind gate again."
          : "Binding will be blocked (PARTNER_NOT_APPOINTED) until an active partner is on file.";
      if (
        !window.confirm(
          `${status === "active" ? "Reactivate" : status === "suspended" ? "Suspend" : "Revoke"} "${p.name}"?\n\n${consequence}`,
        )
      ) {
        return;
      }
      setStatusChanging(p.id);
      setPartnersError(null);
      try {
        const res = await fetch(`/api/insurance/partners/${p.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Update failed (${res.status})`);
        await loadPartners();
      } catch (e) {
        setPartnersError(e instanceof Error ? e.message : "Update failed");
      } finally {
        setStatusChanging(null);
      }
    },
    [loadPartners],
  );

  // ── Approvals tab (slice 3c) ───────────────────────────────────────────────

  const [pending, setPending] = useState<PendingApprovalRow[]>([]);
  const [appointedPartner, setAppointedPartner] = useState<AppointedPartnerInfo | null>(null);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [denyNote, setDenyNote] = useState("");
  const [approvedBinds, setApprovedBinds] = useState<ApprovedBind[]>([]);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [executedBinds, setExecutedBinds] = useState<Record<string, ExecutedBind>>({});

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    setPendingError(null);
    try {
      const res = await fetch("/api/insurance/governance/pending");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setPending(data.approvals ?? []);
      setAppointedPartner(data.appointedPartner ?? null);
    } catch (e) {
      setPendingError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setPendingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "approvals") void loadPending();
  }, [tab, loadPending]);

  // ── Renewals tab (slice 4: remarketing workflow) ──────────────────────────
  const [renewalRows, setRenewalRows] = useState<RenewalRow[]>([]);
  const [renewalsLoading, setRenewalsLoading] = useState(false);
  const [renewalError, setRenewalError] = useState<string | null>(null);
  const [renewalForm, setRenewalForm] = useState<{
    id: string;
    kind: "remarket" | "surface" | "quotes" | "terms";
  } | null>(null);
  const [remarketState, setRemarketState] = useState("");
  const [surfacePremium, setSurfacePremium] = useState("");
  const [surfaceCarrier, setSurfaceCarrier] = useState("");
  const [renewalActingId, setRenewalActingId] = useState<string | null>(null);

  const loadRenewals = useCallback(async () => {
    setRenewalsLoading(true);
    setRenewalError(null);
    try {
      const res = await fetch("/api/insurance/renewals");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setRenewalRows(data.renewals ?? []);
    } catch (e) {
      setRenewalError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setRenewalsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "renewals") void loadRenewals();
  }, [tab, loadRenewals]);

  const handleStartRemarket = useCallback(
    async (id: string) => {
      setRenewalActingId(id);
      setRenewalError(null);
      try {
        const res = await fetch(`/api/insurance/renewals/${id}/remarket`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: remarketState.trim() || undefined }),
        });
        const data = await res.json();
        if (!res.ok) {
          const hint =
            data.code === "RENEWAL_STATE_REQUIRED"
              ? " Enter the risk's 2-letter state — the policy doesn't record one."
              : "";
          throw new Error(`${data.error ?? `Remarket failed (${res.status})`}${hint}`);
        }
        setRenewalForm(null);
        setRemarketState("");
        await loadRenewals();
        if (data.approval) {
          setRenewalError(
            `Remarket started — the request_quote approval is waiting in the Approvals tab.`,
          );
        }
      } catch (e) {
        setRenewalError(e instanceof Error ? e.message : "Remarket failed");
      } finally {
        setRenewalActingId(null);
      }
    },
    [remarketState, loadRenewals],
  );

  const handleFetchQuotes = useCallback(
    async (id: string) => {
      setRenewalActingId(id);
      setRenewalError(null);
      try {
        const res = await fetch(`/api/insurance/renewals/${id}/advance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toStatus: "quoted" }),
        });
        const data = await res.json();
        if (!res.ok) {
          const hint =
            data.code === "REQUEST_QUOTE_NOT_APPROVED"
              ? " Approve the request_quote in the Approvals tab first, then fetch again."
              : "";
          throw new Error(`${data.error ?? `Fetch failed (${res.status})`}${hint}`);
        }
        setRenewalForm({ id, kind: "quotes" });
        await loadRenewals();
      } catch (e) {
        setRenewalError(e instanceof Error ? e.message : "Fetch failed");
      } finally {
        setRenewalActingId(null);
      }
    },
    [loadRenewals],
  );

  const handleSurfaceAutoRenew = useCallback(
    async (id: string) => {
      setRenewalActingId(id);
      setRenewalError(null);
      try {
        const premiumDollars = Number(surfacePremium.replace(/[$,]/g, ""));
        const terms: Record<string, unknown> = {};
        if (surfaceCarrier.trim()) terms.carrierName = surfaceCarrier.trim();
        if (Number.isFinite(premiumDollars) && premiumDollars > 0) {
          terms.premiumCents = Math.round(premiumDollars * 100);
        }
        const res = await fetch(`/api/insurance/renewals/${id}/surface-auto-renew`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ carrierTerms: terms }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Surface failed (${res.status})`);
        setRenewalForm(null);
        setSurfacePremium("");
        setSurfaceCarrier("");
        await loadRenewals();
        if (data.deltaFlagged) {
          setRenewalError(
            `Auto-renewal surfaced — the premium moved above the flag threshold. Review before any approval.`,
          );
        }
      } catch (e) {
        setRenewalError(e instanceof Error ? e.message : "Surface failed");
      } finally {
        setRenewalActingId(null);
      }
    },
    [surfacePremium, surfaceCarrier, loadRenewals],
  );

  const handleDecide = useCallback(
    async (a: PendingApprovalRow, decision: "approve" | "reject") => {
      setDecidingId(a.id);
      setDecisionError(null);
      try {
        const res = await fetch(`/api/insurance/governance/${a.id}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            note: denyNote.trim() ? denyNote.trim() : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Decision failed (${res.status})`);
        if (decision === "approve" && a.kind === "insurance_bind_policy") {
          const quoteId = String(a.payload.subjectId ?? "");
          setApprovedBinds((prev) =>
            prev.some((b) => b.approvalId === a.id)
              ? prev
              : [...prev, { approvalId: a.id, quoteId, payload: a.payload }],
          );
        }
        setDenyNote("");
        setExpandedId(null);
        await loadPending();
      } catch (e) {
        setDecisionError(e instanceof Error ? e.message : "Decision failed");
      } finally {
        setDecidingId(null);
      }
    },
    [denyNote, loadPending],
  );

  const handleExecuteBind = useCallback(
    async (bind: ApprovedBind) => {
      if (!bind.quoteId) return;
      setExecutingId(bind.approvalId);
      setDecisionError(null);
      try {
        const res = await fetch(`/api/insurance/quotes/${bind.quoteId}/bind`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: bind.approvalId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Bind failed (${res.status})`);
        setExecutedBinds((prev) => ({
          ...prev,
          [bind.approvalId]: {
            policyNumber: data.policy.policyNumber,
            carrierName: data.policy.carrierName,
            carrierConfirmation: data.carrierConfirmation ?? null,
            replayed: data.replayed === true,
          },
        }));
        // If the bound quote belongs to a renewal remarket, mark the renewal
        // bound — the advance endpoint verifies the quote is actually bound.
        const match = renewalRows.find((r) =>
          r.submission?.quotes.some((q) => q.id === bind.quoteId),
        );
        if (match) {
          await fetch(`/api/insurance/renewals/${match.id}/advance`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toStatus: "bound" }),
          });
          await loadRenewals();
        }
      } catch (e) {
        setDecisionError(e instanceof Error ? e.message : "Bind failed");
      } finally {
        setExecutingId(null);
      }
    },
    [renewalRows, loadRenewals],
  );

  // ── Certificates tab (slice 5: COI pipeline) ─────────────────────────────
  const [certs, setCerts] = useState<CertificateRow[]>([]);
  const [certsLoading, setCertsLoading] = useState(false);
  const [certError, setCertError] = useState<string | null>(null);
  const [certNotice, setCertNotice] = useState<string | null>(null);
  const [showPrepare, setShowPrepare] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [prep, setPrep] = useState({
    policyId: "",
    holderName: "",
    holderAddress: "",
    additionalInsured: false,
    waiverOfSubrogation: false,
    operationsDescription: "",
    requestedFor: "",
  });
  const [certExpandedId, setCertExpandedId] = useState<string | null>(null);
  const [certDecidingId, setCertDecidingId] = useState<string | null>(null);
  const [certNote, setCertNote] = useState("");
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [revokeFormId, setRevokeFormId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const loadCerts = useCallback(async () => {
    setCertsLoading(true);
    setCertError(null);
    try {
      const res = await fetch("/api/insurance/certificates");
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setCerts(data.certificates ?? []);
    } catch (e) {
      setCertError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setCertsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "certificates") void loadCerts();
  }, [tab, loadCerts]);

  const inForcePolicies = useMemo(
    () => policies.filter((p) => p.status === "active"),
    [policies],
  );

  const handlePrepare = useCallback(async () => {
    setPreparing(true);
    setPrepareError(null);
    setCertNotice(null);
    try {
      const res = await fetch("/api/insurance/certificates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policyId: prep.policyId,
          holderName: prep.holderName,
          holderAddress: prep.holderAddress.trim() ? prep.holderAddress.trim() : null,
          additionalInsured: prep.additionalInsured,
          waiverOfSubrogation: prep.waiverOfSubrogation,
          operationsDescription: prep.operationsDescription.trim()
            ? prep.operationsDescription.trim()
            : null,
          requestedFor: prep.requestedFor.trim() ? prep.requestedFor.trim() : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        const hint =
          data.code === "CERT_POLICY_NOT_INFORCE"
            ? " Pick an in-force policy — only policies with verified limits can issue certificates."
            : "";
        throw new Error(`${data.error ?? `Prepare failed (${res.status})`}${hint}`);
      }
      setPrep({
        policyId: "",
        holderName: "",
        holderAddress: "",
        additionalInsured: false,
        waiverOfSubrogation: false,
        operationsDescription: "",
        requestedFor: "",
      });
      setShowPrepare(false);
      await loadCerts();
      setCertNotice(
        "Draft prepared from policy truth and sent for review — approve it below (or in the Approvals tab) before issuing.",
      );
    } catch (e) {
      setPrepareError(e instanceof Error ? e.message : "Prepare failed");
    } finally {
      setPreparing(false);
    }
  }, [prep, loadCerts]);

  const handleCertDecide = useCallback(
    async (cert: CertificateRow, decision: "approve" | "reject") => {
      if (!cert.approvalId) return;
      setCertDecidingId(cert.id);
      setCertError(null);
      try {
        const res = await fetch(`/api/insurance/governance/${cert.approvalId}/decide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            note: certNote.trim() ? certNote.trim() : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Decision failed (${res.status})`);
        setCertNote("");
        setCertExpandedId(null);
        await loadCerts();
        if (decision === "approve") {
          setCertNotice(
            "Approved — the certificate can now be issued. Issuance re-verifies the disclosure against the live policy before rendering the PDF.",
          );
        }
      } catch (e) {
        setCertError(e instanceof Error ? e.message : "Decision failed");
      } finally {
        setCertDecidingId(null);
      }
    },
    [certNote, loadCerts],
  );

  const handleIssue = useCallback(
    async (cert: CertificateRow) => {
      if (!cert.approvalId) return;
      setIssuingId(cert.id);
      setCertError(null);
      try {
        const res = await fetch(`/api/insurance/certificates/${cert.id}/issue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId: cert.approvalId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Issue failed (${res.status})`);
        await loadCerts();
        setCertNotice(
          `Certificate issued — PDF generated from the verified payload (sha256 ${String(data.pdfHash ?? "").slice(0, 12)}…).`,
        );
      } catch (e) {
        setCertError(e instanceof Error ? e.message : "Issue failed");
      } finally {
        setIssuingId(null);
      }
    },
    [loadCerts],
  );

  const handleRevoke = useCallback(
    async (cert: CertificateRow) => {
      setIssuingId(cert.id);
      setCertError(null);
      try {
        const res = await fetch(`/api/insurance/certificates/${cert.id}/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: revokeReason }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Revoke failed (${res.status})`);
        setRevokeFormId(null);
        setRevokeReason("");
        await loadCerts();
        setCertNotice("Certificate revoked — the download link is disabled and the revocation is in the audit trail.");
      } catch (e) {
        setCertError(e instanceof Error ? e.message : "Revoke failed");
      } finally {
        setIssuingId(null);
      }
    },
    [revokeReason, loadCerts],
  );

  const handleRefresh = useCallback(() => {
    if (tab === "partners") void loadPartners();
    else if (tab === "approvals") void loadPending();
    else if (tab === "quoting") void loadSubmissions();
    else if (tab === "renewals") void loadRenewals();
    else if (tab === "certificates") void loadCerts();
    else void load();
  }, [tab, load, loadPartners, loadPending, loadSubmissions, loadRenewals, loadCerts]);

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
            { key: "partners", label: "Partners", icon: Handshake },
            { key: "approvals", label: "Approvals", icon: Stamp },
            { key: "certificates", label: "Certificates", icon: ScrollText },
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
          <button className={btnGhost} onClick={handleRefresh} disabled={loading || partnersLoading || pendingLoading}>
            <RefreshCw size={13} className={loading || partnersLoading || pendingLoading ? "animate-spin" : ""} />
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
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              <strong className="text-stone-800">Renew: remarket → compare → approve → bind.</strong>{" "}
              Remarketed quotes show the premium delta against the prior term before any approval —
              deltas above the flag threshold are marked red. Auto-renewals are surfaced for review,
              never silently accepted.
            </span>
          </div>
          {renewalError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} />
              {renewalError}
            </div>
          )}
          {renewalsLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-stone-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-[13px]">Loading renewals…</span>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2">Policy</th>
                    <th className="px-3 py-2">Expires</th>
                    <th className="px-3 py-2">Alert</th>
                    <th className="px-3 py-2">Prior premium</th>
                    <th className="px-3 py-2">Delta</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Next step</th>
                  </tr>
                </thead>
                <tbody>
                  {renewalRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-10 text-center text-stone-500">
                        <BellRing size={16} className="mx-auto mb-2 text-stone-400" />
                        No renewals yet — they are created automatically when a policy is ingested.
                      </td>
                    </tr>
                  )}
                  {renewalRows.map((r) => (
                    <Fragment key={r.id}>
                      <tr className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                        <td className="px-3 py-2">
                          <div className="font-medium text-stone-900">{r.policyNumber ?? "—"}</div>
                          <div className="text-[11px] text-stone-500">
                            {r.carrierName ?? "not confirmed"}{r.lineLabel ? ` · ${r.lineLabel}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-stone-700">
                          {fmtDate(r.expiresAt)}
                          <div className="text-[11px] text-stone-500">
                            {r.daysUntilRenewal >= 0 ? `${r.daysUntilRenewal}d left` : "expired"}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Chip tone={alertTone(r.alertLevel)}>{alertLabel(r.alertLevel)}</Chip>
                        </td>
                        <td className="px-3 py-2 text-stone-700">
                          {fmtMoney(r.priorPremiumCents)}
                          {r.newPremiumCents != null && (
                            <div className="text-[11px] text-stone-500">→ {fmtMoney(r.newPremiumCents)} new</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <DeltaBadge deltaPct={r.premiumDeltaPct} flagged={r.deltaFlagged} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1">
                            <Chip tone={remarketTone(r.remarketStatus)}>{r.statusLabel}</Chip>
                            {r.needsReview && <Chip tone="red">Review</Chip>}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {r.remarketStatus === "detected" && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                className={btnGhost}
                                disabled={renewalActingId === r.id}
                                onClick={() =>
                                  setRenewalForm(
                                    renewalForm?.id === r.id && renewalForm.kind === "remarket"
                                      ? null
                                      : { id: r.id, kind: "remarket" },
                                  )
                                }
                              >
                                <RotateCcw size={13} />
                                Start remarket
                              </button>
                              <button
                                className={btnGhost}
                                disabled={renewalActingId === r.id}
                                onClick={() =>
                                  setRenewalForm(
                                    renewalForm?.id === r.id && renewalForm.kind === "surface"
                                      ? null
                                      : { id: r.id, kind: "surface" },
                                  )
                                }
                              >
                                <BellRing size={13} />
                                Surface auto-renew
                              </button>
                            </div>
                          )}
                          {r.remarketStatus === "remarketing" && (
                            <button
                              className={btnGhost}
                              disabled={renewalActingId === r.id}
                              onClick={() => void handleFetchQuotes(r.id)}
                            >
                              {renewalActingId === r.id ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <RefreshCw size={13} />
                              )}
                              Fetch quotes &amp; deltas
                            </button>
                          )}
                          {r.remarketStatus === "quoted" && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                className={btnGhost}
                                onClick={() =>
                                  setRenewalForm(
                                    renewalForm?.id === r.id && renewalForm.kind === "quotes"
                                      ? null
                                      : { id: r.id, kind: "quotes" },
                                  )
                                }
                              >
                                <Eye size={13} />
                                View quotes / deltas
                              </button>
                              <button className={btnPrimary} onClick={() => setTab("approvals")}>
                                <Handshake size={13} />
                                Bind
                              </button>
                            </div>
                          )}
                          {r.remarketStatus === "bound" && (
                            <span className="flex items-center gap-1 text-[12px] text-stone-500">
                              <CheckCircle2 size={13} className="text-emerald-600" />
                              Renewed
                            </span>
                          )}
                          {r.remarketStatus === "auto_renew_surfaced" && (
                            <button
                              className={btnGhost}
                              onClick={() =>
                                setRenewalForm(
                                  renewalForm?.id === r.id && renewalForm.kind === "terms"
                                    ? null
                                    : { id: r.id, kind: "terms" },
                                )
                              }
                            >
                              <Eye size={13} />
                              Review terms
                            </button>
                          )}
                        </td>
                      </tr>
                      {renewalForm?.id === r.id && (
                        <tr className="border-b border-stone-100 bg-stone-50/60">
                          <td colSpan={7} className="px-4 py-3">
                            {renewalForm.kind === "remarket" && (
                              <div>
                                <h3 className="text-[13px] font-semibold text-stone-900">Start remarket</h3>
                                <p className="mt-0.5 text-[12px] text-stone-500">
                                  Creates a draft submission pre-filled from the expiring policy and proposes the
                                  request_quote governed action (or honors the standing quote rule for this line).
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <label className="flex items-center gap-1.5 text-[12px] font-medium text-stone-600">
                                    Risk state (2-letter)
                                    <input
                                      value={remarketState}
                                      onChange={(e) => setRemarketState(e.target.value)}
                                      placeholder="NC"
                                      maxLength={2}
                                      className={`${inputCls} w-20 uppercase`}
                                    />
                                  </label>
                                  <button
                                    className={btnPrimary}
                                    disabled={renewalActingId === r.id}
                                    onClick={() => void handleStartRemarket(r.id)}
                                  >
                                    {renewalActingId === r.id ? (
                                      <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                      <RotateCcw size={14} />
                                    )}
                                    Confirm remarket
                                  </button>
                                  <button className={btnGhost} onClick={() => setRenewalForm(null)}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            {renewalForm.kind === "surface" && (
                              <div>
                                <h3 className="text-[13px] font-semibold text-stone-900">Surface auto-renewal</h3>
                                <p className="mt-0.5 text-[12px] text-stone-500">
                                  Enter the carrier&apos;s renewal terms exactly as quoted. Surfacing never
                                  auto-accepts — the terms go to review, and acceptance still needs a bind approval.
                                </p>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <label className="flex items-center gap-1.5 text-[12px] font-medium text-stone-600">
                                    Renewal premium ($)
                                    <input
                                      value={surfacePremium}
                                      onChange={(e) => setSurfacePremium(e.target.value)}
                                      placeholder="1250"
                                      inputMode="decimal"
                                      className={`${inputCls} w-28`}
                                    />
                                  </label>
                                  <label className="flex items-center gap-1.5 text-[12px] font-medium text-stone-600">
                                    Carrier
                                    <input
                                      value={surfaceCarrier}
                                      onChange={(e) => setSurfaceCarrier(e.target.value)}
                                      placeholder="AmTrust"
                                      className={`${inputCls} w-36`}
                                    />
                                  </label>
                                  <button
                                    className={btnPrimary}
                                    disabled={renewalActingId === r.id}
                                    onClick={() => void handleSurfaceAutoRenew(r.id)}
                                  >
                                    {renewalActingId === r.id ? (
                                      <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                      <BellRing size={14} />
                                    )}
                                    Surface for review
                                  </button>
                                  <button className={btnGhost} onClick={() => setRenewalForm(null)}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                            {renewalForm.kind === "quotes" && (
                              <div>
                                <div className="flex items-center gap-2">
                                  <h3 className="text-[13px] font-semibold text-stone-900">Renewal quotes</h3>
                                  <DeltaBadge deltaPct={r.premiumDeltaPct} flagged={r.deltaFlagged} />
                                  {r.deltaFlagged && (
                                    <span className="text-[12px] text-red-700">
                                      Above the flag threshold — review before approving any bind.
                                    </span>
                                  )}
                                </div>
                                {!r.submission || r.submission.quotes.length === 0 ? (
                                  <p className="mt-1 text-[12px] text-stone-500">No quotes recorded yet.</p>
                                ) : (
                                  <table className="mt-2 w-full text-left text-[12px]">
                                    <thead>
                                      <tr className="border-b border-stone-200 text-[10px] font-medium uppercase tracking-wide text-stone-500">
                                        <th className="px-2 py-1">Carrier</th>
                                        <th className="px-2 py-1">Premium</th>
                                        <th className="px-2 py-1">Limits (occ / agg)</th>
                                        <th className="px-2 py-1">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {r.submission.quotes.map((q) => (
                                        <tr key={q.id} className="border-b border-stone-100">
                                          <td className="px-2 py-1.5 font-medium text-stone-900">{q.carrierName}</td>
                                          <td className="px-2 py-1.5 text-stone-700">{fmtMoney(q.quotedPremiumCents)}</td>
                                          <td className="px-2 py-1.5 text-stone-700">
                                            {fmtMoney(q.limitPerOccurrenceCents)} / {fmtMoney(q.limitAggregateCents)}
                                          </td>
                                          <td className="px-2 py-1.5">
                                            <Chip tone={q.status === "quoted" ? "green" : "slate"}>
                                              {q.status}
                                            </Chip>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                                <p className="mt-2 text-[12px] text-stone-500">
                                  To bind a renewal quote, use the <strong className="text-stone-700">Bind</strong> button
                                  above — binding is proposed and approved in the Approvals tab, then executed on the
                                  licensed rail.
                                </p>
                              </div>
                            )}
                            {renewalForm.kind === "terms" && r.autoRenewTerms && (
                              <div>
                                <div className="flex items-center gap-2">
                                  <h3 className="text-[13px] font-semibold text-stone-900">
                                    Carrier auto-renewal terms
                                  </h3>
                                  <DeltaBadge deltaPct={r.premiumDeltaPct} flagged={r.deltaFlagged} />
                                  <Chip tone="red">Needs your decision</Chip>
                                </div>
                                <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] md:grid-cols-3">
                                  {Object.entries(r.autoRenewTerms).map(([k, v]) => (
                                    <div
                                      key={k}
                                      className="flex justify-between gap-3 border-b border-stone-200/70 pb-1"
                                    >
                                      <dt className="text-stone-500">{k}</dt>
                                      <dd className="font-medium text-stone-900">{fmtTermsValue(v)}</dd>
                                    </div>
                                  ))}
                                </dl>
                                <p className="mt-2 text-[12px] text-stone-500">
                                  This auto-renewal was surfaced, not accepted. Accepting means remarketing and
                                  binding through the governed flow — start a fresh remarket from the policy if the
                                  terms are wrong.
                                </p>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
      ) : tab === "import" ? (
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
      ) : tab === "partners" ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              The licensed partner is the <strong className="text-stone-800">producer of record</strong> —
              the partner holds the licenses, Marketr provides the software. Binding is blocked
              (PARTNER_NOT_APPOINTED) until an <strong className="text-stone-800">active, appointed</strong> partner
              with a producer license number and licensed states is on file. Status changes are admin-gated.
            </span>
          </div>
          {partnersError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} />
              {partnersError}
            </div>
          )}
          <div>
            <button className={btnPrimary} onClick={() => setShowRegister((v) => !v)}>
              <Plus size={14} />
              {showRegister ? "Hide registration" : "Register partner"}
            </button>
          </div>
          {showRegister && (
            <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
              <h2 className="text-[14px] font-semibold text-stone-900">Register licensed partner</h2>
              <p className="mt-0.5 text-[12px] text-stone-500">
                Registration is fail-closed: name, producer license number, and licensed states are all required.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Partner name
                  <input
                    value={reg.name}
                    onChange={(e) => setReg({ ...reg, name: e.target.value })}
                    placeholder="Amwins DAIS Partner LLC"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Producer license number
                  <input
                    value={reg.producerLicenseNumber}
                    onChange={(e) => setReg({ ...reg, producerLicenseNumber: e.target.value })}
                    placeholder="NC-123456"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Contact email (optional)
                  <input
                    value={reg.contactEmail}
                    onChange={(e) => setReg({ ...reg, contactEmail: e.target.value })}
                    placeholder="partners@example.com"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Licensed states (comma-separated, 2-letter)
                  <input
                    value={reg.licensedStates}
                    onChange={(e) => setReg({ ...reg, licensedStates: e.target.value })}
                    placeholder="NC, SC"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Appointment path
                  <select
                    value={reg.appointmentPath}
                    onChange={(e) => setReg({ ...reg, appointmentPath: e.target.value })}
                    className={inputCls}
                  >
                    {Object.entries(APPOINTMENT_PATH_LABELS).map(([v, label]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              {registerError && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                  <AlertTriangle size={14} />
                  {registerError}
                </div>
              )}
              <button
                className={`${btnPrimary} mt-3`}
                onClick={() => void handleRegister()}
                disabled={
                  registering ||
                  !reg.name.trim() ||
                  !reg.producerLicenseNumber.trim() ||
                  !reg.licensedStates.trim()
                }
              >
                {registering ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {registering ? "Registering…" : "Register"}
              </button>
            </div>
          )}
          {partnersLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-stone-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-[13px]">Loading partners…</span>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2">Partner</th>
                    <th className="px-3 py-2">License</th>
                    <th className="px-3 py-2">Licensed states</th>
                    <th className="px-3 py-2">Appointment path</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {partners.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-stone-500">
                        No licensed partners yet — register one to unblock binding.
                      </td>
                    </tr>
                  )}
                  {partners.map((p) => (
                    <tr key={p.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                      <td className="px-3 py-2">
                        <div className="font-medium text-stone-900">{p.name}</div>
                        {p.contactEmail && (
                          <div className="text-[11px] text-stone-500">{p.contactEmail}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px] text-stone-800">
                        {p.licenseNumber ?? <span className="font-sans text-stone-400">none</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {p.licensedStates.map((s) => (
                            <Chip key={s} tone="slate">{s}</Chip>
                          ))}
                          {p.licensedStates.length === 0 && (
                            <span className="text-[11px] text-stone-400">none</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-stone-700">
                        {APPOINTMENT_PATH_LABELS[p.appointmentPath] ?? p.appointmentPath}
                      </td>
                      <td className="px-3 py-2">
                        <Chip tone={partnerTone(p.status)}>{p.status}</Chip>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1.5">
                          {p.status === "active" ? (
                            <>
                              <button
                                className={btnGhost}
                                disabled={statusChanging === p.id}
                                onClick={() => void handleStatusChange(p, "suspended")}
                                title="Suspend — blocks the bind gate for the workspace"
                              >
                                <Ban size={13} />
                                Suspend
                              </button>
                              <button
                                className={btnGhost}
                                disabled={statusChanging === p.id}
                                onClick={() => void handleStatusChange(p, "revoked")}
                                title="Revoke — permanently cuts this partner from the bind gate"
                              >
                                <XCircle size={13} />
                                Revoke
                              </button>
                            </>
                          ) : (
                            <button
                              className={btnGhost}
                              disabled={statusChanging === p.id}
                              onClick={() => void handleStatusChange(p, "active")}
                              title="Reactivate — requires license identity on file"
                            >
                              <RotateCcw size={13} />
                              Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : tab === "certificates" ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              <strong className="text-stone-800">Agent prepares → you review → system issues.</strong>{" "}
              Certificates render <strong className="text-stone-800">only from in-force policy truth</strong> — the
              policy picker lists in-force policies only, and unverified fields read "not confirmed". Issuance
              re-verifies the approval disclosure against the live policy before any PDF is generated.
            </span>
          </div>
          {certNotice && (
            <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-[13px] text-blue-800">
              <Info size={14} />
              {certNotice}
            </div>
          )}
          {certError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} />
              {certError}
            </div>
          )}
          <div>
            <button className={btnPrimary} onClick={() => setShowPrepare((v) => !v)}>
              <Plus size={14} />
              {showPrepare ? "Hide prepare form" : "Prepare certificate"}
            </button>
          </div>
          {showPrepare && (
            <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
              <h2 className="text-[14px] font-semibold text-stone-900">Prepare certificate of insurance</h2>
              <p className="mt-0.5 text-[12px] text-stone-500">
                Prepare creates a draft and proposes the issue_certificate governed action — nothing is issued until
                you approve and press Issue. The validity window is clamped into the policy term.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Issuing policy (in-force only)
                  <select
                    value={prep.policyId}
                    onChange={(e) => setPrep({ ...prep, policyId: e.target.value })}
                    className={inputCls}
                  >
                    <option value="">Select a policy…</option>
                    {inForcePolicies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.policyNumber} · {p.carrierName} · {p.lineLabel}
                      </option>
                    ))}
                  </select>
                  {inForcePolicies.length === 0 && (
                    <span className="text-[11px] text-amber-700">
                      No in-force policies — certificates can only be issued from policies with status "active".
                    </span>
                  )}
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Certificate holder name
                  <input
                    value={prep.holderName}
                    onChange={(e) => setPrep({ ...prep, holderName: e.target.value })}
                    placeholder="City of Greensboro"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Holder address
                  <input
                    value={prep.holderAddress}
                    onChange={(e) => setPrep({ ...prep, holderAddress: e.target.value })}
                    placeholder="300 W Washington St, Greensboro, NC 27401"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Requested for (contract / client reference)
                  <input
                    value={prep.requestedFor}
                    onChange={(e) => setPrep({ ...prep, requestedFor: e.target.value })}
                    placeholder="Contract 2026-118 with the City of Greensboro"
                    className={inputCls}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12px] font-medium text-stone-600">
                  Description of operations
                  <input
                    value={prep.operationsDescription}
                    onChange={(e) => setPrep({ ...prep, operationsDescription: e.target.value })}
                    placeholder="Landscaping services per contract 2026-118"
                    className={inputCls}
                  />
                </label>
                <div className="flex items-end gap-5 pb-1">
                  <label className="flex items-center gap-2 text-[13px] text-stone-700">
                    <input
                      type="checkbox"
                      checked={prep.additionalInsured}
                      onChange={(e) => setPrep({ ...prep, additionalInsured: e.target.checked })}
                      className="h-4 w-4 accent-[var(--brand-600)]"
                    />
                    Additional insured
                  </label>
                  <label className="flex items-center gap-2 text-[13px] text-stone-700">
                    <input
                      type="checkbox"
                      checked={prep.waiverOfSubrogation}
                      onChange={(e) => setPrep({ ...prep, waiverOfSubrogation: e.target.checked })}
                      className="h-4 w-4 accent-[var(--brand-600)]"
                    />
                    Waiver of subrogation
                  </label>
                </div>
              </div>
              {prepareError && (
                <div className="mt-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
                  <AlertTriangle size={14} />
                  {prepareError}
                </div>
              )}
              <button
                className={`${btnPrimary} mt-3`}
                onClick={() => void handlePrepare()}
                disabled={preparing || !prep.policyId || !prep.holderName.trim()}
              >
                {preparing ? <Loader2 size={14} className="animate-spin" /> : <ScrollText size={14} />}
                {preparing ? "Preparing…" : "Prepare for review"}
              </button>
            </div>
          )}
          {certsLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-stone-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-[13px]">Loading certificates…</span>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2">Holder</th>
                    <th className="px-3 py-2">Policy</th>
                    <th className="px-3 py-2">Endorsements</th>
                    <th className="px-3 py-2">Validity</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {certs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-10 text-center text-stone-500">
                        <ScrollText size={16} className="mx-auto mb-2 text-stone-400" />
                        No certificates yet — prepare one from an in-force policy above.
                      </td>
                    </tr>
                  )}
                  {certs.map((c) => (
                    <Fragment key={c.id}>
                      <tr className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                        <td className="px-3 py-2">
                          <div className="font-medium text-stone-900">{c.holderName}</div>
                          {c.requestedFor && (
                            <div className="text-[11px] text-stone-500">for {c.requestedFor}</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-stone-800">{c.policyNumber ?? "—"}</div>
                          <div className="text-[11px] text-stone-500">
                            {c.carrierName ?? "not confirmed"}{c.lineLabel ? ` · ${c.lineLabel}` : ""}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {c.additionalInsured && <Chip tone="violet">AI</Chip>}
                            {c.waiverOfSubrogation && <Chip tone="blue">WoS</Chip>}
                            {!c.additionalInsured && !c.waiverOfSubrogation && (
                              <span className="text-[11px] text-stone-400">none</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-stone-700">
                          {fmtDate(c.validFrom)} → {fmtDate(c.validTo)}
                        </td>
                        <td className="px-3 py-2">
                          <Chip tone={certStatusTone(c)}>{certStatusLabel(c)}</Chip>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {c.status === "draft" && c.approvalStatus === "pending" && c.approvalPayload && (
                              <button
                                className={btnGhost}
                                onClick={() => setCertExpandedId(certExpandedId === c.id ? null : c.id)}
                              >
                                <Eye size={13} />
                                {certExpandedId === c.id ? "Hide" : "Review"}
                                <ChevronDown size={13} className={certExpandedId === c.id ? "rotate-180" : ""} />
                              </button>
                            )}
                            {c.status === "draft" && c.approvalStatus === "approved" && (
                              <button
                                className={btnPrimary}
                                disabled={issuingId === c.id}
                                onClick={() => void handleIssue(c)}
                              >
                                {issuingId === c.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <CheckCircle2 size={14} />
                                )}
                                {issuingId === c.id ? "Issuing…" : "Issue certificate"}
                              </button>
                            )}
                            {c.status === "issued" && (
                              <>
                                <a
                                  className={btnGhost}
                                  href={`/api/insurance/certificates/${c.id}/pdf`}
                                  download
                                >
                                  <FileUp size={13} />
                                  Download PDF
                                </a>
                                <button
                                  className={btnGhost}
                                  onClick={() =>
                                    setRevokeFormId(revokeFormId === c.id ? null : c.id)
                                  }
                                >
                                  <Ban size={13} />
                                  Revoke
                                </button>
                              </>
                            )}
                            {c.status === "revoked" && c.revokedReason && (
                              <span className="max-w-56 text-[11px] text-stone-500">
                                Revoked: {c.revokedReason}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                      {certExpandedId === c.id && c.approvalPayload && (
                        <tr className="border-b border-stone-100 bg-stone-50/60">
                          <td colSpan={6} className="px-4 py-3">
                            <CertificateReview payload={c.approvalPayload} />
                            <p className="mt-2 text-[11px] text-stone-500">
                              Fields the policy has not confirmed read "not confirmed" — coverage is never invented.
                              Issuance re-verifies this disclosure against the live policy row.
                            </p>
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <button
                                className={btnPrimary}
                                disabled={certDecidingId === c.id}
                                onClick={() => void handleCertDecide(c, "approve")}
                              >
                                {certDecidingId === c.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <CheckCircle2 size={14} />
                                )}
                                Approve
                              </button>
                              <button
                                className={btnGhost}
                                disabled={certDecidingId === c.id}
                                onClick={() => void handleCertDecide(c, "reject")}
                              >
                                <XCircle size={14} />
                                Deny
                              </button>
                              <input
                                value={certNote}
                                onChange={(e) => setCertNote(e.target.value)}
                                placeholder="Note (recorded on deny)"
                                className={`${inputCls} w-64`}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                      {revokeFormId === c.id && c.status === "issued" && (
                        <tr className="border-b border-stone-100 bg-stone-50/60">
                          <td colSpan={6} className="px-4 py-3">
                            <h3 className="text-[13px] font-semibold text-stone-900">
                              Revoke certificate for {c.holderName}
                            </h3>
                            <p className="mt-0.5 text-[12px] text-stone-500">
                              A reason is required — the revocation is written to the audit trail and the download
                              link is disabled.
                            </p>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <input
                                value={revokeReason}
                                onChange={(e) => setRevokeReason(e.target.value)}
                                placeholder="e.g. Policy cancelled mid-term"
                                className={`${inputCls} w-80`}
                              />
                              <button
                                className={btnPrimary}
                                disabled={issuingId === c.id || !revokeReason.trim()}
                                onClick={() => void handleRevoke(c)}
                              >
                                {issuingId === c.id ? (
                                  <Loader2 size={14} className="animate-spin" />
                                ) : (
                                  <Ban size={14} />
                                )}
                                {issuingId === c.id ? "Revoking…" : "Confirm revoke"}
                              </button>
                              <button
                                className={btnGhost}
                                onClick={() => {
                                  setRevokeFormId(null);
                                  setRevokeReason("");
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-600">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              <strong className="text-stone-800">Agent prepares → you approve → licensed rail executes.</strong>{" "}
              Premium moves carrier-direct; the OS never holds funds. Bind approvals show the full disclosure
              (carrier, premium, limits, effective dates) before you decide — no auto-bind in v1.
            </span>
          </div>
          {pendingError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} />
              {pendingError}
            </div>
          )}
          {decisionError && (
            <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} />
              {decisionError}
            </div>
          )}
          {pendingLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-stone-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-[13px]">Loading approvals…</span>
            </div>
          ) : pending.length === 0 && approvedBinds.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-stone-500">
              No pending governed actions.
            </p>
          ) : (
            pending.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white shadow-sm">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                      <th className="px-3 py-2">Action</th>
                      <th className="px-3 py-2">Subject</th>
                      <th className="px-3 py-2">Requested by</th>
                      <th className="px-3 py-2">Requested at</th>
                      <th className="px-3 py-2">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((a) => (
                      <Fragment key={a.id}>
                        <tr className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                          <td className="px-3 py-2">
                            <Chip tone={actionTone(a.kind)}>{actionLabel(a.kind)}</Chip>
                          </td>
                          <td className="px-3 py-2 text-stone-700">{approvalSummary(a)}</td>
                          <td className="px-3 py-2 text-[12px] text-stone-500">{a.requestedBy ?? "—"}</td>
                          <td className="px-3 py-2 text-[12px] text-stone-500">{fmtDate(a.createdAt)}</td>
                          <td className="px-3 py-2">
                            <button
                              className={btnGhost}
                              onClick={() => setExpandedId(expandedId === a.id ? null : a.id)}
                            >
                              <Eye size={13} />
                              {expandedId === a.id ? "Hide" : "Review"}
                              <ChevronDown size={13} className={expandedId === a.id ? "rotate-180" : ""} />
                            </button>
                          </td>
                        </tr>
                        {expandedId === a.id && (
                          <tr className="border-b border-stone-100 bg-stone-50/60">
                            <td colSpan={5} className="px-4 py-3">
                              {a.kind === "insurance_bind_policy" ? (
                                <>
                                  <h3 className="text-[13px] font-semibold text-stone-900">
                                    Full disclosure — review before approving
                                  </h3>
                                  <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] md:grid-cols-3">
                                    {(
                                      [
                                        ["Carrier", typeof a.payload.carrier === "string" ? a.payload.carrier : null],
                                        ["Premium", typeof a.payload.premiumCents === "number" ? fmtMoney(a.payload.premiumCents) : null],
                                        ["Per-occurrence limit", typeof a.payload.limitPerOccurrenceCents === "number" ? fmtMoney(a.payload.limitPerOccurrenceCents) : null],
                                        ["Aggregate limit", typeof a.payload.limitAggregateCents === "number" ? fmtMoney(a.payload.limitAggregateCents) : null],
                                        ["Effective date", typeof a.payload.effectiveDate === "string" ? fmtDate(a.payload.effectiveDate) : null],
                                        ["Expiry date", typeof a.payload.expiryDate === "string" ? fmtDate(a.payload.expiryDate) : null],
                                      ] as const
                                    ).map(([k, v]) => (
                                      <div key={k} className="flex justify-between gap-3 border-b border-stone-200/70 pb-1">
                                        <dt className="text-stone-500">{k}</dt>
                                        <dd className={`font-medium ${v == null ? "text-stone-400" : "text-stone-900"}`}>
                                          {v ?? "not confirmed"}
                                        </dd>
                                      </div>
                                    ))}
                                  </dl>
                                  <div className="mt-2 text-[12px] text-stone-600">
                                    <span className="font-medium text-stone-800">Producer of record: </span>
                                    {appointedPartner ? (
                                      <>
                                        {appointedPartner.name} · license{" "}
                                        <span className="font-mono">{appointedPartner.licenseNumber ?? "not confirmed"}</span> ·{" "}
                                        {appointedPartner.licensedStates.join(", ")}
                                      </>
                                    ) : (
                                      <span className="text-amber-700">
                                        No appointed partner — bind execution will be blocked until one is registered.
                                      </span>
                                    )}
                                  </div>
                                  <p className="mt-1.5 text-[11px] text-stone-500">
                                    Fields the carrier has not confirmed read "not confirmed" — coverage is never invented.
                                  </p>
                                </>
                              ) : a.kind === "insurance_issue_certificate" ? (
                                <>
                                  <h3 className="text-[13px] font-semibold text-stone-900">
                                    Certificate disclosure — review before approving
                                  </h3>
                                  <div className="mt-2">
                                    <CertificateReview payload={a.payload} />
                                  </div>
                                  <p className="mt-2 text-[12px] text-stone-600">
                                    After approval, issue the certificate from the{" "}
                                    <strong className="text-stone-800">Certificates</strong> tab — issuance re-verifies
                                    this disclosure against the live policy row before rendering the PDF.
                                  </p>
                                  <p className="mt-1.5 text-[11px] text-stone-500">
                                    Fields the policy has not confirmed read "not confirmed" — coverage is never invented.
                                  </p>
                                </>
                              ) : (
                                <div className="text-[12px] text-stone-600">
                                  <span className="font-medium text-stone-800">Subject:</span>{" "}
                                  {String(a.payload.subjectType ?? "")}{" "}
                                  <span className="font-mono">{String(a.payload.subjectId ?? "")}</span>
                                </div>
                              )}
                              <div className="mt-3 flex flex-wrap items-center gap-2">
                                <button
                                  className={btnPrimary}
                                  disabled={decidingId === a.id}
                                  onClick={() => void handleDecide(a, "approve")}
                                >
                                  {decidingId === a.id ? (
                                    <Loader2 size={14} className="animate-spin" />
                                  ) : (
                                    <CheckCircle2 size={14} />
                                  )}
                                  Approve
                                </button>
                                <button
                                  className={btnGhost}
                                  disabled={decidingId === a.id}
                                  onClick={() => void handleDecide(a, "reject")}
                                >
                                  <XCircle size={14} />
                                  Deny
                                </button>
                                <input
                                  value={denyNote}
                                  onChange={(e) => setDenyNote(e.target.value)}
                                  placeholder="Note (recorded on deny)"
                                  className={`${inputCls} w-64`}
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {approvedBinds.length > 0 && (
            <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
              <h2 className="text-[14px] font-semibold text-stone-900">Approved — ready to execute</h2>
              <p className="mt-0.5 text-[12px] text-stone-500">
                Approval is recorded with the full disclosure. Executing a bind calls the licensed rail with the
                approved terms — the producer of record binds at the carrier, premium moves carrier-direct.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {approvedBinds.map((b) => {
                  const exec = executedBinds[b.approvalId];
                  return (
                    <div
                      key={b.approvalId}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5"
                    >
                      <div className="text-[13px] text-stone-800">
                        <span className="font-medium">Quote {shortId(b.quoteId)}</span>
                        {typeof b.payload.carrier === "string" && (
                          <span className="text-stone-500"> · {b.payload.carrier}</span>
                        )}
                        {typeof b.payload.premiumCents === "number" && (
                          <span className="text-stone-500"> · {fmtMoney(b.payload.premiumCents)}</span>
                        )}
                      </div>
                      {exec ? (
                        <div className="ml-auto flex items-center gap-2 text-[12px]">
                          <Chip tone="green">{exec.replayed ? "Replayed" : "Bound"}</Chip>
                          <span className="font-mono font-medium text-stone-900">{exec.policyNumber}</span>
                          {exec.carrierConfirmation && (
                            <span className="text-stone-500">confirmation {exec.carrierConfirmation}</span>
                          )}
                        </div>
                      ) : (
                        <button
                          className={`${btnPrimary} ml-auto`}
                          onClick={() => void handleExecuteBind(b)}
                          disabled={executingId === b.approvalId}
                        >
                          {executingId === b.approvalId ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <CheckCircle2 size={14} />
                          )}
                          {executingId === b.approvalId ? "Binding…" : "Execute bind"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
