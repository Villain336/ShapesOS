// Marketr — Legal/Compliance slice 5: digital-properties view (client).
// The Hullcheck synergy: Hullcheck's "don't get sued" engine — legal,
// compliance, and security scanning for apps and websites — is the digital
// side of the Legal surface (the physical/regulatory side is obligations,
// deadlines, documents, radar). v1 = property registry + plain-English
// findings from the tenant's self-assessment or manual entry, organized by
// Hullcheck's layer taxonomy. The finding SOURCE is always labeled — v1
// never claims an automated scan happened.
// Agentic OS: white cards radius-lg, pills for pressables, tokens only,
// Lucide icons only, sentence case. Severity is NOT a genuine agent state,
// so it gets monochrome pills — never the status color+shape language.

"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ClipboardCheck,
  EyeOff,
  FlaskConical,
  Globe,
  Info,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  HULLCHECK_LAYERS,
  SELF_ASSESSMENT_ANSWERS,
  findingSourceLabel,
  type DigitalFindingSeverity,
  type DigitalFindingSource,
  type DigitalFindingStatus,
  type DigitalPropertyKind,
  type HullcheckLayer,
  type SelfAssessmentAnswer,
} from "@/lib/legal/digital";
import { confirmAction } from "@/lib/ui/feedback";

export interface DigitalPropertyView {
  id: string;
  name: string;
  url: string | null;
  kind: DigitalPropertyKind;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  openFindingCount: number;
  criticalOpenCount: number;
}

export interface DigitalFindingView {
  id: string;
  propertyId: string;
  itemKey: string | null;
  hullcheckLayer: HullcheckLayer;
  title: string;
  plainEnglishSummary: string;
  severity: DigitalFindingSeverity;
  status: DigitalFindingStatus;
  source: DigitalFindingSource;
  sourceLabel: string;
  obligationKey: string | null;
  obligationTitle: string | null;
  confirmWithProfessional: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DigitalPropertyDetailView extends DigitalPropertyView {
  findings: DigitalFindingView[];
}

interface AssessmentItemView {
  key: string;
  layer: HullcheckLayer;
  question: string;
  gapSeverity: DigitalFindingSeverity;
  obligationKey: string | null;
  confirmWithProfessional: boolean;
}

const SEVERITY_LABELS: Record<DigitalFindingSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function SeverityPill({ severity }: { severity: DigitalFindingSeverity }) {
  const cls =
    severity === "critical"
      ? "bg-black text-white"
      : severity === "high"
        ? "bg-paper shadow-outline"
        : severity === "medium"
          ? "bg-canvas"
          : "text-muted";
  return (
    <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8125rem] font-semibold ${cls}`}>
      {severity === "critical" && <TriangleAlert size={13} />}
      {SEVERITY_LABELS[severity]}
    </span>
  );
}

const SOURCE_ICONS: Record<DigitalFindingSource, typeof ClipboardCheck> = {
  self_assessment: ClipboardCheck,
  manual_import: Pencil,
  hullcheck_engine: FlaskConical,
};

function SourcePill({ source }: { source: DigitalFindingSource }) {
  const Icon = SOURCE_ICONS[source];
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold">
      <Icon size={13} />
      {findingSourceLabel(source)}
    </span>
  );
}

const KIND_ICONS: Record<DigitalPropertyKind, typeof Globe> = {
  website: Globe,
  app: Smartphone,
};

function LayerLabel({ layer }: { layer: HullcheckLayer }) {
  return HULLCHECK_LAYERS.find((l) => l.value === layer)?.label ?? layer;
}

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error ?? `Request failed (${res.status})`);
  }
  return json;
}

export function DigitalView({
  properties,
  disclaimer,
  onChanged,
  onShowObligations,
}: {
  properties: DigitalPropertyView[];
  disclaimer: string;
  onChanged: () => void;
  onShowObligations: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DigitalPropertyDetailView | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function selectProperty(id: string) {
    setSelectedId(id);
    setLoadingDetail(true);
    setError(null);
    try {
      const json = await api(`/api/legal/digital-properties/${id}`, "GET");
      setDetail(json.property as DigitalPropertyDetailView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the property.");
    } finally {
      setLoadingDetail(false);
    }
  }

  async function refreshAll(id: string | null) {
    onChanged();
    if (id) await selectProperty(id);
  }

  async function removeProperty(id: string) {
    if (!await confirmAction("Remove this property and all its findings?")) return;
    try {
      await api(`/api/legal/digital-properties/${id}`, "DELETE");
      setSelectedId(null);
      setDetail(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the property.");
    }
  }

  const openTotal = properties.reduce((n, p) => n + p.openFindingCount, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Information-not-advice label — also on every API response. */}
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <Info size={16} className="mt-0.5 shrink-0" />
        <p className="text-[0.875rem]">{disclaimer}</p>
      </div>

      {/* Hullcheck framing: the digital side of "don't get sued". */}
      <div className="flex items-start gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" />
        <div className="text-[0.875rem]">
          <p className="font-semibold">Don&apos;t get sued — the digital side</p>
          <p className="mt-1 text-muted">
            Register your websites and apps, walk a plain-English self-assessment,
            and get back findings written for a non-technical builder: what the gap
            is, what it means for your business, and which layer of the problem it
            belongs to. This is information to act on — not legal advice, and not
            an automated scan.
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-lg bg-paper p-4 shadow-hairline">
          <TriangleAlert size={16} className="shrink-0" />
          <p className="text-[0.875rem]">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="aos-press ml-auto flex h-8 w-8 items-center justify-center rounded-full hover:bg-canvas"
            aria-label="Dismiss error"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[0.8125rem] text-muted">
          {properties.length} {properties.length === 1 ? "property" : "properties"} ·{" "}
          {openTotal} open {openTotal === 1 ? "finding" : "findings"}
        </p>
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white"
          >
            <Plus size={15} />
            Add property
          </button>
        </div>
      </div>

      {showAdd && (
        <AddPropertyForm
          onDone={(id) => {
            setShowAdd(false);
            void refreshAll(id);
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Property list — dense table, house pattern. */}
      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <table className="w-full text-left text-[0.875rem]">
          <thead>
            <tr className="border-b border-line text-[0.75rem] font-semibold text-muted">
              <th className="px-4 py-3">Property</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">URL</th>
              <th className="px-4 py-3">Open findings</th>
              <th className="px-4 py-3" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {properties.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  No digital properties yet. Add your website or app to walk the
                  self-assessment.
                </td>
              </tr>
            )}
            {properties.map((p) => {
              const KindIcon = KIND_ICONS[p.kind];
              const active = selectedId === p.id;
              return (
                <tr
                  key={p.id}
                  className={`border-b border-line last:border-0 hover:bg-canvas/60 ${active ? "bg-canvas/60" : ""}`}
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => void selectProperty(p.id)}
                      className="font-semibold hover:underline"
                    >
                      {p.name}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 text-muted">
                      <KindIcon size={13} />
                      {p.kind === "website" ? "Website" : "App"}
                    </span>
                  </td>
                  <td className="max-w-56 truncate px-4 py-3 text-muted">
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {p.url.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {p.openFindingCount > 0 ? (
                      <span className="font-mono text-[0.8125rem]">
                        {p.openFindingCount}
                        {p.criticalOpenCount > 0 && (
                          <span className="text-muted"> ({p.criticalOpenCount} critical)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => void removeProperty(p.id)}
                      className="aos-press inline-flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-canvas"
                      aria-label={`Remove ${p.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {loadingDetail && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" />
          Loading property
        </div>
      )}

      {detail && !loadingDetail && (
        <PropertyDetail
          key={detail.id}
          detail={detail}
          onChanged={() => void refreshAll(detail.id)}
          onShowObligations={onShowObligations}
          onError={setError}
        />
      )}
    </div>
  );
}

function AddPropertyForm({
  onDone,
  onCancel,
}: {
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DigitalPropertyKind>("website");
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const json = await api("/api/legal/digital-properties", "POST", {
        name,
        kind,
        url: url.trim() === "" ? null : url.trim(),
        notes: notes.trim() === "" ? null : notes.trim(),
      });
      onDone((json.property as DigitalPropertyView).id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the property.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline"
    >
      <p className="text-[0.9375rem] font-semibold">Add a digital property</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-semibold">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. My store's website"
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
            required
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-semibold">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as DigitalPropertyKind)}
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
          >
            <option value="website">Website</option>
            <option value="app">App</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-semibold">URL (optional)</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            inputMode="url"
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-semibold">Notes (optional)</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What this property is for"
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
          />
        </label>
      </div>
      {error && <p className="text-[0.8125rem] text-failed-text">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[0.9375rem] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          {busy ? "Adding" : "Add property"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="aos-press flex h-11 items-center rounded-full bg-paper px-5 text-[0.9375rem] font-semibold shadow-outline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function PropertyDetail({
  detail,
  onChanged,
  onShowObligations,
  onError,
}: {
  detail: DigitalPropertyDetailView;
  onChanged: () => void;
  onShowObligations: () => void;
  onError: (msg: string | null) => void;
}) {
  const [showAssess, setShowAssess] = useState(false);
  const [showAddFinding, setShowAddFinding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function setStatus(finding: DigitalFindingView, status: DigitalFindingStatus) {
    setBusyId(finding.id);
    onError(null);
    try {
      await api(
        `/api/legal/digital-properties/${detail.id}/findings/${finding.id}`,
        "PATCH",
        { status },
      );
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update the finding.");
    } finally {
      setBusyId(null);
    }
  }

  const open = detail.findings.filter((f) => f.status === "open");
  const closed = detail.findings.filter((f) => f.status !== "open");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-[1.125rem] font-bold" style={{ fontStretch: "115%" }}>
          {detail.name}
        </h3>
        <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold">
          {detail.kind === "website" ? <Globe size={13} /> : <Smartphone size={13} />}
          {detail.kind === "website" ? "Website" : "App"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => {
              setShowAssess((v) => !v);
              setShowAddFinding(false);
            }}
            className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white"
          >
            <ClipboardCheck size={15} />
            Walk the self-assessment
          </button>
          <button
            type="button"
            onClick={() => {
              setShowAddFinding((v) => !v);
              setShowAssess(false);
            }}
            className="aos-press flex h-10 items-center gap-2 rounded-full bg-paper px-4 text-[0.875rem] font-semibold shadow-outline"
          >
            <Plus size={15} />
            Add finding
          </button>
        </div>
      </div>

      {showAssess && (
        <AssessmentPanel
          propertyId={detail.id}
          propertyKind={detail.kind}
          onDone={onChanged}
          onError={onError}
        />
      )}

      {showAddFinding && (
        <ManualFindingForm
          propertyId={detail.id}
          onDone={() => {
            setShowAddFinding(false);
            onChanged();
          }}
          onCancel={() => setShowAddFinding(false)}
          onError={onError}
        />
      )}

      {open.length === 0 && closed.length === 0 ? (
        <div className="rounded-lg bg-paper p-8 text-center shadow-hairline">
          <p className="text-[0.9375rem] font-semibold">No findings yet</p>
          <p className="mt-1 text-[0.875rem] text-muted">
            Walk the self-assessment to surface the gaps — in plain English, no
            scanner jargon.
          </p>
        </div>
      ) : (
        <>
          {HULLCHECK_LAYERS.map((layer) => {
            const items = open.filter((f) => f.hullcheckLayer === layer.value);
            if (items.length === 0) return null;
            return (
              <section key={layer.value} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <h4 className="text-[0.9375rem] font-bold" style={{ fontStretch: "110%" }}>
                    {layer.label}
                  </h4>
                  <span className="rounded-full bg-black px-2 py-0.5 font-mono text-[0.6875rem] text-white">
                    {items.length}
                  </span>
                  <p className="text-[0.8125rem] text-muted">{layer.whatItCovers}</p>
                </div>
                {items.map((f) => (
                  <FindingCard
                    key={f.id}
                    finding={f}
                    busy={busyId === f.id}
                    onSetStatus={(s) => void setStatus(f, s)}
                    onShowObligations={onShowObligations}
                  />
                ))}
              </section>
            );
          })}

          {closed.length > 0 && (
            <section className="flex flex-col gap-2">
              <h4 className="text-[0.9375rem] font-bold" style={{ fontStretch: "110%" }}>
                Closed ({closed.length})
              </h4>
              {closed.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  busy={busyId === f.id}
                  onSetStatus={(s) => void setStatus(f, s)}
                  onShowObligations={onShowObligations}
                />
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function FindingCard({
  finding,
  busy,
  onSetStatus,
  onShowObligations,
}: {
  finding: DigitalFindingView;
  busy: boolean;
  onSetStatus: (s: DigitalFindingStatus) => void;
  onShowObligations: () => void;
}) {
  const open = finding.status === "open";
  return (
    <article className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityPill severity={finding.severity} />
        <SourcePill source={finding.source} />
        <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold">
          {LayerLabel({ layer: finding.hullcheckLayer })} layer
        </span>
        {!open && (
          <span className="flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-[0.8125rem] font-semibold text-muted">
            {finding.status === "fixed" ? <CheckCircle2 size={13} /> : <EyeOff size={13} />}
            {finding.status === "fixed" ? "Fixed" : "Dismissed"}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {open ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSetStatus("fixed")}
                className="aos-press flex h-9 items-center gap-1.5 rounded-full bg-paper px-3.5 text-[0.8125rem] font-semibold shadow-outline disabled:opacity-50"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                Mark fixed
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSetStatus("dismissed")}
                className="aos-press flex h-9 items-center gap-1.5 rounded-full bg-paper px-3.5 text-[0.8125rem] font-semibold shadow-outline disabled:opacity-50"
              >
                <EyeOff size={13} />
                Dismiss
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSetStatus("open")}
              className="aos-press flex h-9 items-center gap-1.5 rounded-full bg-paper px-3.5 text-[0.8125rem] font-semibold shadow-outline disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
              Reopen
            </button>
          )}
        </div>
      </div>

      <div>
        <p className="text-[0.9375rem] font-semibold">{finding.title}</p>
        <p className="mt-1 text-[0.875rem] text-muted">{finding.plainEnglishSummary}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {finding.confirmWithProfessional && (
          <span className="flex items-center gap-1.5 text-[0.8125rem] text-muted">
            <Info size={13} />
            Have an attorney confirm the fix — this one is legal, not just technical.
          </span>
        )}
        {finding.obligationKey && (
          <button
            type="button"
            onClick={onShowObligations}
            className="aos-press flex h-8 items-center gap-1.5 rounded-full bg-canvas px-3 text-[0.8125rem] font-semibold"
          >
            <Link2 size={13} />
            Related obligation{finding.obligationTitle ? `: ${finding.obligationTitle}` : ""}
          </button>
        )}
      </div>
    </article>
  );
}

function AssessmentPanel({
  propertyId,
  propertyKind,
  onDone,
  onError,
}: {
  propertyId: string;
  propertyKind: DigitalPropertyKind;
  onDone: () => void;
  onError: (msg: string | null) => void;
}) {
  const [checklist, setChecklist] = useState<AssessmentItemView[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, SelfAssessmentAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const json = await api(
          `/api/legal/digital-properties/${propertyId}/assess`,
          "GET",
        );
        setChecklist(json.checklist as AssessmentItemView[]);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Could not load the checklist.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId]);

  const answered = checklist ? Object.keys(answers).length : 0;

  async function submit() {
    setBusy(true);
    onError(null);
    try {
      await api(`/api/legal/digital-properties/${propertyId}/assess`, "POST", {
        answers,
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save the assessment.");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !checklist) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-paper p-4 text-sm text-muted shadow-hairline">
        <Loader2 size={16} className="animate-spin" />
        Loading the self-assessment
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
      <div className="flex items-start gap-3">
        <ClipboardCheck size={16} className="mt-0.5 shrink-0" />
        <div className="text-[0.875rem]">
          <p className="font-semibold">Self-assessment — your answers, not a scan</p>
          <p className="mt-1 text-muted">
            Answer each question honestly. &ldquo;No&rdquo; creates a finding at full
            severity; &ldquo;Not sure&rdquo; flags it for you to check with your
            developer. Findings generated here are labeled{" "}
            <span className="font-semibold">Self-assessment</span> — this is not an
            automated Hullcheck scan.
          </p>
        </div>
      </div>

      {checklist.map((item) => {
        const current = answers[item.key];
        return (
          <div key={item.key} className="flex flex-col gap-2 rounded-md border border-line p-3">
            <p className="text-[0.875rem] font-medium">{item.question}</p>
            <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={item.question}>
              {SELF_ASSESSMENT_ANSWERS.map((a) => {
                const pressed = current === a.value;
                return (
                  <button
                    key={a.value}
                    type="button"
                    role="radio"
                    aria-checked={pressed}
                    onClick={() =>
                      setAnswers((prev) => ({ ...prev, [item.key]: a.value }))
                    }
                    className={`aos-press flex h-9 items-center rounded-full px-4 text-[0.8125rem] font-semibold ${
                      pressed ? "bg-black text-white" : "bg-paper shadow-outline"
                    }`}
                  >
                    {a.label}
                  </button>
                );
              })}
              <span className="ml-auto rounded-full bg-canvas px-2.5 py-1 text-[0.75rem] font-semibold text-muted">
                {LayerLabel({ layer: item.layer })}
              </span>
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || answered === 0}
          onClick={() => void submit()}
          className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[0.9375rem] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          {busy ? "Generating" : `Generate findings (${answered} answered)`}
        </button>
        <p className="text-[0.8125rem] text-muted">
          Re-running replaces open self-assessment findings — fixed or dismissed
          ones stay as you left them.
        </p>
      </div>
    </div>
  );
}

function ManualFindingForm({
  propertyId,
  onDone,
  onCancel,
  onError,
}: {
  propertyId: string;
  onDone: () => void;
  onCancel: () => void;
  onError: (msg: string | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [layer, setLayer] = useState<HullcheckLayer>("detect");
  const [severity, setSeverity] = useState<DigitalFindingSeverity>("medium");
  const [obligationKey, setObligationKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      await api(`/api/legal/digital-properties/${propertyId}/findings`, "POST", {
        finding: {
          title: title.trim(),
          plainEnglishSummary: summary.trim(),
          hullcheckLayer: layer,
          severity,
          obligationKey: obligationKey.trim() === "" ? null : obligationKey.trim(),
        },
      });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add the finding.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline"
    >
      <div className="flex items-start gap-3">
        <Pencil size={16} className="mt-0.5 shrink-0" />
        <p className="text-[0.875rem] text-muted">
          Add a finding by hand — e.g. something from a report you read elsewhere.
          It will be labeled <span className="font-semibold">Added manually</span>.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 md:col-span-2">
          <span className="text-[0.8125rem] font-semibold">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Login page has no rate limiting"
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
            required
          />
        </label>
        <label className="flex flex-col gap-1.5 md:col-span-2">
          <span className="text-[0.8125rem] font-semibold">
            What this means for the business (plain English)
          </span>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Explain the risk in plain words — no scanner jargon."
            rows={3}
            className="rounded-md border border-control bg-paper px-3 py-2 text-[0.9375rem]"
            required
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-semibold">Layer</span>
          <select
            value={layer}
            onChange={(e) => setLayer(e.target.value as HullcheckLayer)}
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
          >
            {HULLCHECK_LAYERS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label} — {l.whatItCovers.slice(0, 48)}…
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[0.8125rem] font-semibold">Severity</span>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value as DigitalFindingSeverity)}
            className="h-11 rounded-md border border-control bg-paper px-3 text-[0.9375rem]"
          >
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 md:col-span-2">
          <span className="text-[0.8125rem] font-semibold">
            Related obligation key (optional, from your obligation list)
          </span>
          <input
            value={obligationKey}
            onChange={(e) => setObligationKey(e.target.value)}
            placeholder="e.g. saas-terms-and-privacy"
            className="h-11 rounded-md border border-control bg-paper px-3 font-mono text-[0.875rem]"
          />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[0.9375rem] font-semibold text-white disabled:opacity-50"
        >
          {busy && <Loader2 size={15} className="animate-spin" />}
          {busy ? "Adding" : "Add finding"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="aos-press flex h-11 items-center rounded-full bg-paper px-5 text-[0.9375rem] font-semibold shadow-outline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
