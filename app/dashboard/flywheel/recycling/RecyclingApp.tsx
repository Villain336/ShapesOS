// Marketr — Creative Recycling client app (Phase 7, F2).
// Signals → briefs → human approval → studio routing. Nothing auto-publishes.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  GitBranch,
  Hash,
  Loader2,
  Plus,
  Recycle,
  ScanLine,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import {
  api,
  formatMetric,
  hashShort,
  SIGNAL_LABELS,
  SUPPORTED_TARGET_SUGGESTIONS,
  type ApiSignal,
  type BriefView,
} from "./api";

// ── Small atoms (mirror the dashboard page conventions) ────────────────────

function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    slate: "bg-stone-100 text-stone-600 border-stone-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-stone-200 bg-white shadow-sm ${className}`}>{children}</div>
  );
}

function SectionTitle({ icon, children, right }: { icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-800">
        {icon}
        {children}
      </h2>
      {right}
    </div>
  );
}

function statusTone(s: BriefView["status"]): "slate" | "violet" | "green" | "amber" | "blue" {
  switch (s) {
    case "draft": return "slate";
    case "approved": return "blue";
    case "regenerating": return "amber";
    case "ready": return "green";
  }
}

// ── App ────────────────────────────────────────────────────────────────────

export function RecyclingApp() {
  const [signals, setSignals] = useState<ApiSignal[]>([]);
  const [readers, setReaders] = useState<Array<{ kind: string; source: string; description: string }>>([]);
  const [briefs, setBriefs] = useState<BriefView[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [useFixtures, setUseFixtures] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.getBrief>> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // brief composer
  const [composerSignal, setComposerSignal] = useState<ApiSignal | null>(null);
  const [composerTargets, setComposerTargets] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approveNote, setApproveNote] = useState("");

  const refresh = useCallback(async (fake: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const [s, b] = await Promise.all([
        api.signals(fake),
        api.listBriefs().catch((e) => {
          // Tables not provisioned yet (fragment not merged) — show signals only.
          if (/503|provisioned/i.test(String(e?.message ?? e))) return { briefs: [], tablesReady: false };
          throw e;
        }),
      ]);
      setSignals(s.signals);
      setReaders(s.readers);
      setBriefs(b.briefs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(useFixtures);
  }, [refresh, useFixtures]);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const s = await api.signals(useFixtures);
      setSignals(s.signals);
      setReaders(s.readers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, [useFixtures]);

  const openBrief = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const d = await api.getBrief(id);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
  }, []);

  const suggestedTargets = useMemo(
    () => (composerSignal ? SUPPORTED_TARGET_SUGGESTIONS[composerSignal.sourceChannel] ?? [] : []),
    [composerSignal],
  );

  const toggleTarget = (t: string) =>
    setComposerTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const createBrief = useCallback(async () => {
    if (!composerSignal || composerTargets.length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const { brief } = await api.createBrief(composerSignal, composerTargets);
      setBriefs((prev) => [brief, ...prev]);
      setComposerSignal(null);
      setComposerTargets([]);
      void openBrief(brief.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }, [composerSignal, composerTargets, openBrief]);

  const approveBrief = useCallback(async () => {
    if (!selectedId) return;
    setApproving(true);
    setError(null);
    try {
      const { brief } = await api.approveBrief(selectedId, approveNote || undefined);
      setBriefs((prev) => prev.map((b) => (b.id === brief.id ? brief : b)));
      setApproveNote("");
      await openBrief(brief.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  }, [selectedId, approveNote, openBrief]);

  const selectedBrief = useMemo(
    () => briefs.find((b) => b.id === selectedId) ?? detail?.brief ?? null,
    [briefs, selectedId, detail],
  );

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button className="ml-auto" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ── Trigger signals ── */}
      <section>
        <SectionTitle
          icon={<ScanLine className="h-4 w-4 text-violet-600" />}
          right={
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-stone-500">
                <input
                  type="checkbox"
                  checked={useFixtures}
                  onChange={(e) => setUseFixtures(e.target.checked)}
                  className="h-3.5 w-3.5 accent-violet-600"
                />
                Fixture signals
              </label>
              <button
                onClick={scan}
                disabled={scanning}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-[12px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanLine className="h-3.5 w-3.5" />}
                Scan now
              </button>
            </div>
          }
        >
          Trigger signals
          <span className="font-normal text-stone-400">({signals.length})</span>
        </SectionTitle>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading signals…
          </div>
        ) : signals.length === 0 ? (
          <Card className="p-6 text-center text-[13px] text-stone-500">
            No winning creative flagged by the current readers. Signals appear when attribution revenue,
            QR scan rates, AEO lift, or mail response rates cross their thresholds.
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {signals.map((s) => (
              <Card key={s.id} className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-semibold text-stone-900">
                      {SIGNAL_LABELS[s.kind] ?? s.kind}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-stone-500">{s.sourceAssetId}</div>
                  </div>
                  {s.source === "fake" ? <Chip tone="amber">fixture</Chip> : <Chip tone="green">live</Chip>}
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-xl font-bold text-stone-900">
                    {formatMetric(s.kind, s.metricValue, s.metricUnit)}
                  </span>
                  <span className="text-[11px] text-stone-500">
                    {s.sourceChannel} → recycle
                  </span>
                </div>
                <button
                  onClick={() => {
                    setComposerSignal(s);
                    setComposerTargets(SUPPORTED_TARGET_SUGGESTIONS[s.sourceChannel] ?? []);
                  }}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-violet-700"
                >
                  <Recycle className="h-3.5 w-3.5" /> Generate brief
                </button>
              </Card>
            ))}
          </div>
        )}

        {readers.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {readers.map((r) => (
              <span key={r.kind} title={r.description} className="cursor-help">
                <Chip tone={r.source === "fake" ? "amber" : "slate"}>
                  {SIGNAL_LABELS[r.kind] ?? r.kind} · {r.source}
                </Chip>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Brief composer ── */}
      {composerSignal && (
        <Card className="border-violet-200 p-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-stone-900">
              <Plus className="h-4 w-4 text-violet-600" />
              New brief from {SIGNAL_LABELS[composerSignal.kind]}
            </h3>
            <button onClick={() => setComposerSignal(null)} aria-label="Close composer">
              <X className="h-4 w-4 text-stone-400" />
            </button>
          </div>
          <div className="mt-2 font-mono text-[11px] text-stone-500">
            {composerSignal.sourceAssetId} · {composerSignal.sourceChannel} ·{" "}
            {formatMetric(composerSignal.kind, composerSignal.metricValue, composerSignal.metricUnit)}
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-[12px] font-medium text-stone-700">Target channels</div>
            {suggestedTargets.length === 0 ? (
              <p className="text-[12px] text-stone-500">
                No deterministic adaptation rules exist from “{composerSignal.sourceChannel}” yet — pick
                another winner, or add the pair to the rule table (lib/flywheel/recycling/adaptation.ts).
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {suggestedTargets.map((t) => (
                  <button
                    key={t}
                    onClick={() => toggleTarget(t)}
                    className={`rounded-full border px-3 py-1 text-[12px] font-medium ${
                      composerTargets.includes(t)
                        ? "border-violet-600 bg-violet-50 text-violet-700"
                        : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={createBrief}
              disabled={creating || composerTargets.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Recycle className="h-4 w-4" />}
              Create draft brief
            </button>
            <span className="text-[11px] text-stone-500">
              Deterministic variant specs only — headlines/CTAs get supervised rewrite after you approve.
            </span>
          </div>
        </Card>
      )}

      {/* ── Brief queue ── */}
      <section>
        <SectionTitle icon={<Recycle className="h-4 w-4 text-violet-600" />}>
          Recycling briefs
          <span className="font-normal text-stone-400">({briefs.length})</span>
        </SectionTitle>
        {briefs.length === 0 ? (
          <Card className="p-6 text-center text-[13px] text-stone-500">
            No briefs yet. Generate one from a trigger signal above.
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-4 py-2.5 font-medium">Source</th>
                  <th className="px-4 py-2.5 font-medium">Signal</th>
                  <th className="px-4 py-2.5 font-medium">Targets</th>
                  <th className="px-4 py-2.5 font-medium">Lineage</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {briefs.map((b) => (
                  <tr key={b.id} className="border-b border-stone-100 last:border-0 hover:bg-stone-50/50">
                    <td className="px-4 py-3">
                      <div className="font-mono text-[11px] text-stone-700">{b.sourceAssetId}</div>
                      <div className="text-[11px] text-stone-500">{b.sourceChannel}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-stone-800">{SIGNAL_LABELS[b.triggerSignal.kind] ?? b.triggerSignal.kind}</div>
                      <div className="text-[11px] text-stone-500">
                        {formatMetric(b.triggerSignal.kind, b.triggerSignal.metricValue, b.triggerSignal.metricUnit)}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {b.targetChannels.map((t) => (
                          <Chip key={t}>{t}</Chip>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500">
                        <Hash className="h-3 w-3" />
                        {hashShort(b.creativeHashLineage[0]?.hash ?? "")} × {b.creativeHashLineage.length}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Chip tone={statusTone(b.status)}>{b.status}</Chip>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => openBrief(b.id)}
                        className="inline-flex items-center gap-1 text-[12px] font-medium text-violet-700 hover:text-violet-900"
                      >
                        Open <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      {/* ── Detail drawer ── */}
      {selectedId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-stone-900/30" onClick={closeDetail}>
          <div
            className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-[#FAFAF7] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-stone-900">Recycling brief</h3>
              <button onClick={closeDetail} aria-label="Close">
                <X className="h-5 w-5 text-stone-400" />
              </button>
            </div>
            {detailLoading || !selectedBrief ? (
              <div className="flex items-center gap-2 py-10 text-[13px] text-stone-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading brief…
              </div>
            ) : (
              <BriefDetail
                brief={selectedBrief}
                detail={detail}
                approveNote={approveNote}
                setApproveNote={setApproveNote}
                approving={approving}
                onApprove={approveBrief}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Brief detail ─────────────────────────────────────────────────────────────

function BriefDetail({
  brief,
  detail,
  approveNote,
  setApproveNote,
  approving,
  onApprove,
}: {
  brief: BriefView;
  detail: Awaited<ReturnType<typeof api.getBrief>> | null;
  approveNote: string;
  setApproveNote: (v: string) => void;
  approving: boolean;
  onApprove: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={statusTone(brief.status)}>{brief.status}</Chip>
        <Chip tone={brief.triggerSignal.source === "fake" ? "amber" : "green"}>
          {brief.triggerSignal.source} signal
        </Chip>
        <span className="font-mono text-[11px] text-stone-500">{brief.sourceAssetId}</span>
      </div>

      {/* Variant specs */}
      <section>
        <h4 className="mb-2 text-[13px] font-semibold text-stone-800">Variant specs (deterministic rules)</h4>
        <div className="flex flex-col gap-2">
          {Object.values(brief.variantSpecs).map((spec) => (
            <Card key={spec.targetChannel} className="p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-semibold text-stone-900">
                  {brief.sourceChannel} <ArrowRight className="inline h-3.5 w-3.5" /> {spec.targetChannel}
                </span>
                <Chip tone="slate">{spec.aspectRatio}</Chip>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-stone-600">
                <div>
                  Copy ceiling: <span className="font-medium">≤{spec.copyDensityCeiling.maxWords} words</span>,
                  ≤{spec.copyDensityCeiling.maxLines} lines
                </div>
                <div>CTA: <span className="font-medium">{spec.ctaFormats.join(", ")}</span></div>
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[12px] text-stone-600">
                {spec.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-stone-500">
                <Sparkles className="h-3.5 w-3.5" />
                Supervised rewrite (human-approved only): headline + CTA · rules {spec.rulesVersion}
              </div>
            </Card>
          ))}
        </div>
      </section>

      {/* Lineage */}
      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-stone-800">
          <GitBranch className="h-4 w-4" /> Creative-hash lineage
          {detail && (
            <span className="ml-1">
              {detail.lineage.ok ? (
                <Chip tone="green"><ShieldCheck className="h-3 w-3" /> intact</Chip>
              ) : (
                <Chip tone="red"><XCircle className="h-3 w-3" /> broken</Chip>
              )}
            </span>
          )}
        </h4>
        <div className="flex flex-col gap-1.5">
          {brief.creativeHashLineage.map((e, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2">
              <Chip tone={e.stage === "source" ? "violet" : e.stage === "variant" ? "blue" : "green"}>
                {e.stage}
              </Chip>
              <span className="text-[12px] font-medium text-stone-700">{e.channel}</span>
              <span className="font-mono text-[11px] text-stone-500" title={e.hash}>
                {hashShort(e.hash)}
              </span>
              <span className="ml-auto text-[11px] text-stone-400">
                {new Date(e.at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-stone-500">
          Every regenerated asset re-enters the studio approval flows and is bound to buys by its own
          per-buy creative-hash approval object.
        </p>
      </section>

      {/* Studio routing */}
      {brief.studioRouting.length > 0 && (
        <section>
          <h4 className="mb-2 text-[13px] font-semibold text-stone-800">Studio routing</h4>
          <div className="flex flex-col gap-1.5">
            {brief.studioRouting.map((r) => (
              <div key={r.receipt} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-[12px]">
                <span className="font-medium text-stone-800">{r.variantChannel}</span>
                <span className="ml-2 font-mono text-[11px] text-stone-500">{r.studioRef}</span>
                <span className="ml-2"><Chip tone={r.provider === "fake" ? "amber" : "green"}>{r.provider}</Chip></span>
                <div className="mt-0.5 text-[11px] text-stone-500">
                  Routed {new Date(r.routedAt).toLocaleString()} — review-queue entry, not a publish.
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Approval */}
      {brief.status === "draft" && (
        <section>
          <h4 className="mb-2 text-[13px] font-semibold text-stone-800">Human approval</h4>
          <Card className="p-3">
            <p className="text-[12px] text-stone-600">
              Approving routes every variant into the studio approval flows for human review and
              regeneration. Nothing publishes. Nothing enters a buy without its own approval object.
            </p>
            <textarea
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              placeholder="Approval note (optional)"
              rows={2}
              className="mt-2 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-800 placeholder:text-stone-400"
            />
            <button
              onClick={onApprove}
              disabled={approving}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Approve brief &amp; route to studio
            </button>
          </Card>
        </section>
      )}

      {/* Audit trail */}
      {detail && detail.audit.events.length > 0 && (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-stone-800">
            <Clock className="h-4 w-4" /> Audit trail
            {detail.audit.chain.ok ? (
              <Chip tone="green"><ShieldCheck className="h-3 w-3" /> chain intact</Chip>
            ) : (
              <Chip tone="red">chain broken</Chip>
            )}
          </h4>
          <div className="flex flex-col gap-1">
            {detail.audit.events.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-[12px] text-stone-600">
                <span className="font-mono text-[11px] text-stone-400">
                  {new Date(e.ts).toLocaleString()}
                </span>
                <Chip>{e.action}</Chip>
                <span className="text-stone-500">{e.actor}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
