// Marketr — Funding/VC slice 2: pipeline kanban view (client).
// Eight stage columns (target → contacted → meeting → diligence →
// term_sheet, then won/lost/passed outcomes). Cards open the investor
// detail drawer. Agentic OS design system: tokens only, black primary
// actions, Lucide icons only, sentence case. Pipeline stages are NOT agent
// states — no status colors or shapes anywhere here.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  CalendarClock,
  KanbanSquare,
  Loader2,
  Plus,
  X,
} from "lucide-react";
import { InvestorDrawer } from "./InvestorDrawer";

const STAGE_ORDER = [
  "target",
  "contacted",
  "meeting",
  "diligence",
  "term_sheet",
  "won",
  "lost",
  "passed",
] as const;

export const STAGE_LABELS: Record<string, string> = {
  target: "Target",
  contacted: "Contacted",
  meeting: "Meeting",
  diligence: "Diligence",
  term_sheet: "Term sheet",
  won: "Won",
  lost: "Lost",
  passed: "Passed",
};

export interface PipelineFollowUp {
  id: string;
  dueAt: string;
  note: string;
  done: boolean;
}

export interface PipelineInvestor {
  id: string;
  name: string;
  firm: string | null;
  title: string | null;
  email: string | null;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  enrichmentSource: string;
  stage: string;
  source: string | null;
  openFollowUps: PipelineFollowUp[];
}

function formatCheckBand(min: number | null, max: number | null): string | null {
  const fmt = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m` : `$${Math.round(n / 1000)}k`;
  if (min != null && max != null) return `${fmt(min)}–${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  if (max != null) return `up to ${fmt(max)}`;
  return null;
}

function InvestorCard({
  investor,
  onOpen,
}: {
  investor: PipelineInvestor;
  onOpen: () => void;
}) {
  const band = formatCheckBand(investor.checkSizeMin, investor.checkSizeMax);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="aos-press block w-full rounded-lg bg-paper p-3 text-left shadow-hairline"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-semibold text-ink">
            {investor.name}
          </div>
          {(investor.firm || investor.title) && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-[0.8125rem] text-muted">
              <Building2 size={12} className="shrink-0" />
              <span className="truncate">
                {[investor.firm, investor.title].filter(Boolean).join(" · ")}
              </span>
            </div>
          )}
        </div>
      </div>
      {band && <div className="mt-1 text-[0.8125rem] text-muted">{band}</div>}
      {investor.sectors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {investor.sectors.slice(0, 3).map((s) => (
            <span
              key={s}
              className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-muted"
            >
              {s}
            </span>
          ))}
        </div>
      )}
      {investor.openFollowUps.length > 0 && (
        <div className="mt-2 flex items-center gap-1 text-[0.75rem] font-semibold text-muted">
          <CalendarClock size={12} />
          {investor.openFollowUps.length} follow-up
          {investor.openFollowUps.length === 1 ? "" : "s"} open
        </div>
      )}
    </button>
  );
}

export function PipelineView() {
  const [investors, setInvestors] = useState<PipelineInvestor[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", firm: "", email: "", source: "" });
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/funding/investors");
    if (res.ok) {
      const json = await res.json();
      setInvestors(json.investors ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createInvestor = async () => {
    setError(null);
    const res = await fetch("/api/funding/investors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        firm: form.firm || null,
        email: form.email || null,
        source: form.source || null,
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error ?? "Could not add the investor. Try again.");
      return;
    }
    setForm({ name: "", firm: "", email: "", source: "" });
    setAdding(false);
    await refresh();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading your pipeline
      </div>
    );
  }

  const byStage = new Map<string, PipelineInvestor[]>();
  for (const s of STAGE_ORDER) byStage.set(s, []);
  for (const inv of investors) {
    const list = byStage.get(inv.stage) ?? byStage.get("target")!;
    list.push(inv);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KanbanSquare size={15} className="text-ink" />
          <h2
            className="text-[1.125rem] font-bold text-ink"
            style={{ fontStretch: "115%" }}
          >
            Pipeline
          </h2>
          <span className="rounded-full bg-paper px-2.5 py-1 text-[0.75rem] font-semibold text-muted shadow-control">
            {investors.length} investor{investors.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="aos-press flex h-10 items-center gap-2 rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white"
        >
          {adding ? <X size={15} /> : <Plus size={15} />}
          {adding ? "Close" : "Add investor"}
        </button>
      </div>

      {adding && (
        <div className="rounded-lg bg-paper p-4 shadow-hairline">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[0.8125rem] font-semibold text-ink">Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Jane Doe"
                className="h-11 rounded-md border-[1.5px] border-control bg-white px-3 text-[0.9375rem] text-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.8125rem] font-semibold text-ink">Firm</span>
              <input
                value={form.firm}
                onChange={(e) => setForm((f) => ({ ...f, firm: e.target.value }))}
                placeholder="Acme Ventures"
                className="h-11 rounded-md border-[1.5px] border-control bg-white px-3 text-[0.9375rem] text-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.8125rem] font-semibold text-ink">Email</span>
              <input
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="jane@acme.vc"
                className="h-11 rounded-md border-[1.5px] border-control bg-white px-3 text-[0.9375rem] text-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[0.8125rem] font-semibold text-ink">Source</span>
              <input
                value={form.source}
                onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
                placeholder="boardy_intro, crunchbase…"
                className="h-11 rounded-md border-[1.5px] border-control bg-white px-3 text-[0.9375rem] text-ink"
              />
            </label>
          </div>
          {error && (
            <p role="alert" className="mt-2 text-[0.8125rem] font-semibold text-failed-text">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void createInvestor()}
            className="aos-press mt-3 flex h-11 items-center rounded-full bg-black px-5 text-[0.875rem] font-semibold text-white"
          >
            Add to pipeline
          </button>
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGE_ORDER.map((stage) => {
          const list = byStage.get(stage) ?? [];
          return (
            <section
              key={stage}
              aria-label={`${STAGE_LABELS[stage]} stage`}
              className="flex w-[260px] shrink-0 flex-col gap-2"
            >
              <div className="flex items-center justify-between rounded-sm bg-canvas px-2 py-1.5">
                <h3 className="text-[0.8125rem] font-bold text-ink">
                  {STAGE_LABELS[stage]}
                </h3>
                <span className="rounded-full bg-paper px-2 py-0.5 text-[0.6875rem] font-semibold text-muted shadow-control">
                  {list.length}
                </span>
              </div>
              {list.length === 0 ? (
                <div className="rounded-lg border border-dashed border-control bg-canvas p-4 text-center text-[0.8125rem] text-muted">
                  No investors
                </div>
              ) : (
                list.map((inv) => (
                  <InvestorCard
                    key={inv.id}
                    investor={inv}
                    onOpen={() => setOpenId(inv.id)}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>

      {openId && (
        <InvestorDrawer
          investorId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
