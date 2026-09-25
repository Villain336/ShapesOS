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
import { Badge } from "@/components/vault/shadcn/badge";
import { Card, CardHeader } from "@/components/vault/Card";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import {
  api,
  formatMetric,
  hashShort,
  SIGNAL_LABELS,
  SUPPORTED_TARGET_SUGGESTIONS,
  type ApiSignal,
  type BriefView,
} from "./api";

function statusTone(s: BriefView["status"]): "neutral" | "accent" | "orange" | "green" {
  switch (s) {
    case "draft": return "neutral";
    case "approved": return "accent";
    case "regenerating": return "orange";
    case "ready": return "green";
  }
}

function SectionHead({ title, count, right }: { title: string; count?: number; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-sm font-semibold text-stone-900">
        {title}
        {count !== undefined && <span className="ml-1.5 font-normal text-stone-400">({count})</span>}
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
    <div className="flex flex-col gap-6">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
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
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-stone-500">
                <input
                  type="checkbox"
                  checked={useFixtures}
                  onChange={(e) => setUseFixtures(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Fixture signals
              </label>
              <Button variant="outline" size="sm" onClick={scan} disabled={scanning}>
                {scanning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ScanLine className="mr-1.5 h-3.5 w-3.5" />}
                Scan now
              </Button>
            </div>
          }
        />

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-[13px] text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading signals…
          </div>
        ) : signals.length === 0 ? (
          <Card>
            <p className="p-6 text-center text-[13px] text-stone-500">
              No winning creative flagged by the current readers. Signals appear when attribution revenue,
              QR scan rates, AEO lift, or mail response rates cross their thresholds.
            </p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {signals.map((s) => (
              <Card key={s.id}>
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-semibold text-stone-900">
                        {SIGNAL_LABELS[s.kind] ?? s.kind}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-stone-500">{s.sourceAssetId}</div>
                    </div>
                    <Badge variant="outline">{s.source === "fake" ? "fixture" : "live"}</Badge>
                  </div>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className="text-xl font-bold text-stone-900">
                      {formatMetric(s.kind, s.metricValue, s.metricUnit)}
                    </span>
                    <span className="text-[11px] text-stone-500">
                      {s.sourceChannel} → recycle
                    </span>
                  </div>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setComposerSignal(s);
                      setComposerTargets(SUPPORTED_TARGET_SUGGESTIONS[s.sourceChannel] ?? []);
                    }}
                  >
                    <Recycle className="mr-1.5 h-3.5 w-3.5" /> Generate brief
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}

        {readers.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {readers.map((r) => (
              <span key={r.kind} title={r.description} className="cursor-help">
                <Badge variant="outline">
                  {SIGNAL_LABELS[r.kind] ?? r.kind} · {r.source}
                </Badge>
              </span>
            ))}
          </div>
        )}
      </section>

      {/* ── Brief composer ── */}
      {composerSignal && (
        <Card>
          <CardHeader
            title={`New brief from ${SIGNAL_LABELS[composerSignal.kind]}`}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setComposerSignal(null)} aria-label="Close composer">
                <X className="h-4 w-4" />
              </Button>
            }
          />
          <div className="flex flex-col gap-3 p-4">
            <div className="font-mono text-[11px] text-stone-500">
              {composerSignal.sourceAssetId} · {composerSignal.sourceChannel} ·{" "}
              {formatMetric(composerSignal.kind, composerSignal.metricValue, composerSignal.metricUnit)}
            </div>
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-stone-700">Target channels</div>
              {suggestedTargets.length === 0 ? (
                <p className="text-[12px] text-stone-500">
                  No deterministic adaptation rules exist from “{composerSignal.sourceChannel}” yet — pick
                  another winner, or add the pair to the rule table (lib/flywheel/recycling/adaptation.ts).
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {suggestedTargets.map((t) => (
                    <Button
                      key={t}
                      size="sm"
                      variant={composerTargets.includes(t) ? "default" : "outline"}
                      onClick={() => toggleTarget(t)}
                    >
                      {t}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={createBrief} disabled={creating || composerTargets.length === 0}>
                {creating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Recycle className="mr-1.5 h-4 w-4" />}
                Create draft brief
              </Button>
              <span className="text-[11px] text-stone-500">
                Deterministic variant specs only — headlines/CTAs get supervised rewrite after you approve.
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* ── Brief queue ── */}
      <section>
        <SectionHead title="Recycling briefs" count={briefs.length} />
        {briefs.length === 0 ? (
          <Card>
            <p className="p-6 text-center text-[13px] text-stone-500">
              No briefs yet. Generate one from a trigger signal above.
            </p>
          </Card>
        ) : (
          <Card>
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
                          <Badge key={t} variant="outline">{t}</Badge>
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
                      <ValuePill tone={statusTone(b.status)}>{b.status}</ValuePill>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => openBrief(b.id)}>
                        Open <ChevronRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
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
            className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-stone-900">Recycling brief</h3>
              <Button variant="ghost" size="sm" onClick={closeDetail} aria-label="Close">
                <X className="h-5 w-5" />
              </Button>
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
        <ValuePill tone={statusTone(brief.status)}>{brief.status}</ValuePill>
        <Badge variant="outline">{brief.triggerSignal.source} signal</Badge>
        <span className="font-mono text-[11px] text-stone-500">{brief.sourceAssetId}</span>
      </div>

      {/* Variant specs */}
      <section>
        <h4 className="mb-2 text-[13px] font-semibold text-stone-800">Variant specs (deterministic rules)</h4>
        <div className="flex flex-col gap-2">
          {Object.values(brief.variantSpecs).map((spec) => (
            <Card key={spec.targetChannel}>
              <div className="p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-semibold text-stone-900">
                    {brief.sourceChannel} <ArrowRight className="inline h-3.5 w-3.5" /> {spec.targetChannel}
                  </span>
                  <Badge variant="outline">{spec.aspectRatio}</Badge>
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
                <Badge variant="outline" className="text-emerald-700"><ShieldCheck className="mr-1 h-3 w-3" /> intact</Badge>
              ) : (
                <Badge variant="destructive"><XCircle className="mr-1 h-3 w-3" /> broken</Badge>
              )}
            </span>
          )}
        </h4>
        <div className="flex flex-col gap-1.5">
          {brief.creativeHashLineage.map((e, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2">
              <Badge variant="outline">{e.stage}</Badge>
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
                <span className="ml-2"><Badge variant="outline">{r.provider}</Badge></span>
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
          <Card>
            <div className="p-3">
              <p className="text-[12px] text-stone-600">
                Approving routes every variant into the studio approval flows for human review and
                regeneration. Nothing publishes. Nothing enters a buy without its own approval object.
              </p>
              <Textarea
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                placeholder="Approval note (optional)"
                rows={2}
                className="mt-2"
              />
              <Button onClick={onApprove} disabled={approving} className="mt-2">
                {approving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
                Approve brief &amp; route to studio
              </Button>
            </div>
          </Card>
        </section>
      )}

      {/* Audit trail */}
      {detail && detail.audit.events.length > 0 && (
        <section>
          <h4 className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-stone-800">
            <Clock className="h-4 w-4" /> Audit trail
            {detail.audit.chain.ok ? (
              <Badge variant="outline" className="text-emerald-700"><ShieldCheck className="mr-1 h-3 w-3" /> chain intact</Badge>
            ) : (
              <Badge variant="destructive">chain broken</Badge>
            )}
          </h4>
          <div className="flex flex-col gap-1">
            {detail.audit.events.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-[12px] text-stone-600">
                <span className="font-mono text-[11px] text-stone-400">
                  {new Date(e.ts).toLocaleString()}
                </span>
                <Badge variant="outline">{e.action}</Badge>
                <span className="text-stone-500">{e.actor}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
