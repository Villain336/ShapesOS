// Marketr — Creative Recycling client app (Phase 7, F2).
// Signals → briefs → human approval → studio routing. Nothing auto-publishes.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  GitBranch,
  Hash,
  Loader2,
  Recycle,
  ScanLine,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";
// Category chips are neutral by default (tone accepted for call-site compat).
function chip(text: React.ReactNode, cls?: string) {
  void cls;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-[10px] font-semibold leading-tight text-muted shadow-control">
      {text}
    </span>
  );
}
import {
  api,
  formatMetric,
  hashShort,
  SIGNAL_LABELS,
  SUPPORTED_TARGET_SUGGESTIONS,
  type ApiSignal,
  type BriefView,
} from "./api";

// Brief statuses carry the AOS status shape language: draft = neutral,
// approved = done, regenerating = running (agent actively working),
// ready = needs (awaits human review).
function statusChip(s: BriefView["status"]) {
  const base =
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold leading-tight";
  const shape = (extra: string) => (
    <span
      className={`aos-shape ${extra} [--aos-shape-size:9px]`}
      style={{ color: "inherit" }}
      aria-hidden
    />
  );
  switch (s) {
    case "draft":
      return <span className={`${base} bg-paper text-muted shadow-control`}>{s}</span>;
    case "approved":
      return (
        <span className={`${base} bg-done text-white`}>
          {shape("aos-shape--done")} {s}
        </span>
      );
    case "regenerating":
      return (
        <span className={`${base} bg-running text-white`}>
          {shape("aos-shape--running aos-is-live")} {s}
        </span>
      );
    case "ready":
      return (
        <span className={`${base} bg-needs text-ink`}>
          {shape("aos-shape--needs aos-shape--edged")} {s}
        </span>
      );
  }
}

function SectionHead({ title, count, right }: { title: string; count?: number; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-ink">
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal text-subtle">({count})</span>}
      </h2>
      {right}
    </div>
  );
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
    <div className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-failed bg-failed-tint p-3 text-[13px] text-failed-text">
          <span className="mt-1 size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
          <span>{error}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* ── Trigger signals ── */}
      <section>
        <SectionHead
          title="Trigger signals"
          count={signals.length}
          right={
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={useFixtures}
                  onChange={(e) => setUseFixtures(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Fixture signals
              </label>
              <Button size="sm" className="bg-paper text-ink shadow-outline hover:bg-hover-paper" onClick={scan} disabled={scanning}>
                {scanning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 aos-spin" /> : <ScanLine className="mr-1.5 h-3.5 w-3.5" />}
                Scan now
              </Button>
            </div>
          }
        />

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-muted">
            <Loader2 className="h-4 w-4 aos-spin" /> Loading signals…
          </div>
        ) : signals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-white p-6 text-center">
            <p className="text-[13px] text-muted">
              No winning creative flagged by the current readers. Signals appear when attribution revenue,
              QR scan rates, AEO lift, or mail response rates cross their thresholds.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-medium">Signal</th>
                  <th className="px-3 py-2 font-medium">Source asset</th>
                  <th className="px-3 py-2 font-medium">Metric</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium text-ink">{SIGNAL_LABELS[s.kind] ?? s.kind}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-muted">{s.sourceAssetId}</td>
                    <td className="px-3 py-2">
                      <span className="font-bold text-ink">{formatMetric(s.kind, s.metricValue, s.metricUnit)}</span>
                      <span className="ml-1.5 text-[11px] text-muted">{s.sourceChannel} → recycle</span>
                    </td>
                    <td className="px-3 py-2">{chip(s.source === "fake" ? "fixture" : "live", "border-line bg-canvas text-muted")}</td>
                    <td className="px-3 py-2">
                      <Button
                        size="sm"
                        className="bg-ink text-white hover:bg-night-hover"
                        onClick={() => {
                          setComposerSignal(s);
                          setComposerTargets(SUPPORTED_TARGET_SUGGESTIONS[s.sourceChannel] ?? []);
                        }}
                      >
                        <Recycle className="mr-1.5 h-3.5 w-3.5" /> Generate brief
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {readers.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {readers.map((r) => (
              <span key={r.kind} title={r.description} className="cursor-help">
                {chip(`${SIGNAL_LABELS[r.kind] ?? r.kind} · ${r.source}`, "border-line bg-canvas text-muted")}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Brief composer ── */}
      {composerSignal && (
        <section className="rounded-xl border border-line bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-ink">
              New brief from {SIGNAL_LABELS[composerSignal.kind]}
            </h3>
            <Button variant="ghost" size="sm" onClick={() => setComposerSignal(null)} aria-label="Close composer">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-col gap-3">
            <div className="font-mono text-[11px] text-muted">
              {composerSignal.sourceAssetId} · {composerSignal.sourceChannel} ·{" "}
              {formatMetric(composerSignal.kind, composerSignal.metricValue, composerSignal.metricUnit)}
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-muted">Target channels</div>
              {suggestedTargets.length === 0 ? (
                <p className="text-[12px] text-muted">
                  No deterministic adaptation rules exist from “{composerSignal.sourceChannel}” yet — pick
                  another winner, or add the pair to the rule table (lib/flywheel/recycling/adaptation.ts).
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {suggestedTargets.map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant="outline"
                      className={composerTargets.includes(t) ? "border-ink bg-hover-paper text-ink" : undefined}
                      onClick={() => toggleTarget(t)}
                    >
                      {t}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={createBrief} disabled={creating || composerTargets.length === 0} className="inline-flex h-control-sm cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40">
                {creating ? <Loader2 className="mr-1.5 h-4 w-4 aos-spin" /> : <Recycle className="mr-1.5 h-4 w-4" />}
                Create draft brief
              </Button>
              <span className="text-[11px] text-muted">
                Deterministic variant specs only — headlines/CTAs get supervised rewrite after you approve.
              </span>
            </div>
          </div>
        </section>
      )}

      {/* ── Brief queue ── */}
      <section>
        <SectionHead title="Recycling briefs" count={briefs.length} />
        {briefs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-white p-6 text-center">
            <p className="text-[13px] text-muted">
              No briefs yet. Generate one from a trigger signal above.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Signal</th>
                  <th className="px-3 py-2 font-medium">Targets</th>
                  <th className="px-3 py-2 font-medium">Lineage</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {briefs.map((b) => (
                  <tr key={b.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <div className="font-mono text-[11px] text-muted">{b.sourceAssetId}</div>
                      <div className="text-[11px] text-muted">{b.sourceChannel}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-ink">{SIGNAL_LABELS[b.triggerSignal.kind] ?? b.triggerSignal.kind}</div>
                      <div className="text-[11px] text-muted">
                        {formatMetric(b.triggerSignal.kind, b.triggerSignal.metricValue, b.triggerSignal.metricUnit)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {b.targetChannels.map((t) => (
                          <span key={t}>{chip(t, "border-line bg-canvas text-muted")}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-muted">
                        <Hash className="h-3 w-3" />
                        {hashShort(b.creativeHashLineage[0]?.hash ?? "")} × {b.creativeHashLineage.length}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {statusChip(b.status)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" size="sm" onClick={() => openBrief(b.id)}>
                        Open <ChevronRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Detail drawer ── */}
      {selectedId && (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onClick={closeDetail}>
          <div
            className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-white p-5 shadow-overlay"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-ink">Recycling brief</h3>
              <Button variant="ghost" size="sm" onClick={closeDetail} aria-label="Close">
                <X className="h-5 w-5" />
              </Button>
            </div>
            {detailLoading || !selectedBrief ? (
              <div className="flex items-center gap-2 py-10 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 aos-spin" /> Loading brief…
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
        {statusChip(brief.status)}
        {chip(`${brief.triggerSignal.source} signal`, "border-line bg-canvas text-muted")}
        <span className="font-mono text-[11px] text-muted">{brief.sourceAssetId}</span>
      </div>

      {/* Variant specs */}
      <section>
        <h4 className="mb-2 text-[13px] font-semibold text-ink">Variant specs (deterministic rules)</h4>
        <div className="overflow-x-auto rounded-xl border border-line bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-medium">Variant</th>
                <th className="px-3 py-2 font-medium">Aspect</th>
                <th className="px-3 py-2 font-medium">Copy ceiling</th>
                <th className="px-3 py-2 font-medium">CTA</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(brief.variantSpecs).map((spec) => (
                <>
                  <tr key={spec.targetChannel} className="hover:bg-hover-paper">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-1.5 font-medium text-ink">
                        {brief.sourceChannel} <ArrowRight className="h-3.5 w-3.5 text-subtle" /> {spec.targetChannel}
                      </span>
                    </td>
                    <td className="px-3 py-2">{chip(spec.aspectRatio, "border-line bg-canvas text-muted")}</td>
                    <td className="px-3 py-2 text-[12px] text-muted">
                      ≤{spec.copyDensityCeiling.maxWords} words, ≤{spec.copyDensityCeiling.maxLines} lines
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted">{spec.ctaFormats.join(", ")}</td>
                  </tr>
                  <tr key={`${spec.targetChannel}-notes`} className="border-b border-line bg-hover-paper">
                    <td colSpan={4} className="px-3 py-2">
                      <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-muted">
                        {spec.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                        <Sparkles className="h-3.5 w-3.5" />
                        Supervised rewrite (human-approved only): headline + CTA · rules {spec.rulesVersion}
                      </div>
                    </td>
                  </tr>
                </>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Lineage */}
      <section>
        <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <GitBranch className="h-4 w-4" /> Creative-hash lineage
          {detail && (
            <span className="ml-1">
              {detail.lineage.ok ? (
                <span><span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink"><ShieldCheck className="mr-1 h-3 w-3" /> intact</span></span>
              ) : (
                <span><span className="inline-flex items-center gap-1 text-[11px] font-semibold text-failed-text"><XCircle className="mr-1 h-3 w-3" /> broken</span></span>
              )}
            </span>
          )}
        </h4>
        <div className="flex flex-col gap-1.5">
          {brief.creativeHashLineage.map((e, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2">
              <span>{chip(e.stage, "border-line bg-canvas text-muted")}</span>
              <span className="text-[12px] font-medium text-muted">{e.channel}</span>
              <span className="font-mono text-[11px] text-muted" title={e.hash}>
                {hashShort(e.hash)}
              </span>
              <span className="ml-auto text-[11px] text-subtle">
                {new Date(e.at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-muted">
          Every regenerated asset re-enters the studio approval flows and is bound to buys by its own
          per-buy creative-hash approval object.
        </p>
      </section>

      {/* Studio routing */}
      {brief.studioRouting.length > 0 && (
        <section>
          <h4 className="mb-2 text-[13px] font-semibold text-ink">Studio routing</h4>
          <div className="flex flex-col gap-1.5">
            {brief.studioRouting.map((r) => (
              <div key={r.receipt} className="rounded-lg border border-line bg-white px-3 py-2 text-[12px]">
                <span className="font-medium text-ink">{r.variantChannel}</span>
                <span className="ml-2 font-mono text-[11px] text-muted">{r.studioRef}</span>
                <span className="ml-2">{chip(r.provider, "border-line bg-canvas text-muted")}</span>
                <div className="mt-0.5 text-[11px] text-muted">
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
          <h4 className="mb-2 text-[13px] font-semibold text-ink">Human approval</h4>
          <div className="rounded-xl border border-line bg-white p-4">
            <p className="text-[12px] text-muted">
              Approving routes every variant into the studio approval flows for human review and
              regeneration. Nothing publishes. Nothing enters a buy without its own approval object.
            </p>
            <Textarea
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              placeholder="Approval note (optional)"
              rows={2}
              className="mt-2 border-line bg-white text-[13px] placeholder:text-subtle focus-visible:border-ink focus-visible:ring-[var(--aos-focus-halo)]"
            />
            <Button onClick={onApprove} disabled={approving} className="mt-2 bg-done text-white hover:brightness-110">
              {approving ? <Loader2 className="mr-1.5 h-4 w-4 aos-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
              Approve brief &amp; route to studio
            </Button>
          </div>
        </section>
      )}

      {/* Audit trail */}
      {detail && detail.audit.events.length > 0 && (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            <Clock className="h-4 w-4" /> Audit trail
            {detail.audit.chain.ok ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink"><ShieldCheck className="mr-1 h-3 w-3" /> chain intact</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-failed-text"><XCircle className="mr-1 h-3 w-3" /> chain broken</span>
            )}
          </h4>
          <div className="flex flex-col gap-1">
            {detail.audit.events.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-[12px] text-muted">
                <span className="font-mono text-[11px] text-subtle">
                  {new Date(e.ts).toLocaleString()}
                </span>
                <span>{chip(e.action, "border-line bg-canvas text-muted")}</span>
                <span className="text-muted">{e.actor}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
