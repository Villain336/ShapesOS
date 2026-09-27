// Marketr — Knowledge Brain: corpus health strip.
//
// Audit-center metrics, every one of them real:
//   sources · chunks · manifest version · corpus eval score · pending
//   proposals · removal flags · per-pillar chunk distribution.
// No fabricated health — when the eval never ran, it says "not run".

import { BrainCircuit, Database, FlaskConical, Inbox, Flag, Tag } from "lucide-react";
import type { BrainGraph, BrainPillar } from "@/lib/intelligence/corpus/graph";
import { PILLAR_COLORS, PILLAR_LABEL } from "./brain-ui";

function Metric({
  icon,
  label,
  value,
  sub,
  alert,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg border p-3 ${
        alert ? "border-red-200 bg-red-50/50" : "border-stone-200 bg-white"
      }`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-stone-400">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div
        className={`mt-1 truncate text-[20px] font-semibold tabular-nums ${
          alert ? "text-red-700" : "text-stone-900"
        }`}
      >
        {value}
      </div>
      {sub && <div className="truncate text-[11px] text-stone-400">{sub}</div>}
    </div>
  );
}

export function BrainHealthStrip({ graph }: { graph: BrainGraph }) {
  const s = graph.stats;
  const evalBlock = s.eval;
  const totalPillarChunks = s.pillarChunks.marketing + s.pillarChunks.growth + s.pillarChunks.design;

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <Metric
          icon={<BrainCircuit className="h-3.5 w-3.5" />}
          label="Sources"
          value={s.sources.toLocaleString()}
          sub={`${s.pillars.marketing} marketing · ${s.pillars.growth} growth · ${s.pillars.design} design`}
        />
        <Metric
          icon={<Database className="h-3.5 w-3.5" />}
          label="Cataloged"
          value={s.cataloged.toLocaleString()}
          sub="metadata only · 0 chunks"
        />
        <Metric
          icon={<Database className="h-3.5 w-3.5" />}
          label="Chunks"
          value={s.chunks.toLocaleString()}
          sub={`${s.retrievalHitsTotal.toLocaleString()} agent retrievals logged`}
        />
        <Metric
          icon={<Tag className="h-3.5 w-3.5" />}
          label="Manifest"
          value={`v${graph.version}`}
          sub={new Date(graph.updatedAt).toLocaleDateString()}
        />
        <Metric
          icon={<FlaskConical className="h-3.5 w-3.5" />}
          label="Corpus eval"
          value={evalBlock ? `${evalBlock.correct}/${evalBlock.questions}` : "not run"}
          sub={
            evalBlock
              ? `precision ${evalBlock.precision.toFixed(2)} · ${new Date(evalBlock.runAt).toLocaleDateString()}`
              : "scripts/eval-corpus.mts"
          }
        />
        <Metric
          icon={<Inbox className="h-3.5 w-3.5" />}
          label="Proposals pending"
          value={s.proposed.toLocaleString()}
          sub="awaiting corpus rebuild"
        />
        <Metric
          icon={<Flag className="h-3.5 w-3.5" />}
          label="Flagged for removal"
          value={s.flagged.toLocaleString()}
          sub={s.flagged > 0 ? "take effect on next rebuild" : "nothing flagged"}
          alert={s.flagged > 0}
        />
      </div>

      {/* Per-pillar chunk distribution */}
      <div className="mt-2 rounded-lg border border-stone-200 bg-white p-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Chunk distribution by pillar
        </div>
        <div className="mt-2 flex h-2.5 overflow-hidden rounded-full bg-stone-100">
          {(Object.keys(s.pillarChunks) as BrainPillar[]).map((p) => {
            const pct = totalPillarChunks ? (s.pillarChunks[p] / totalPillarChunks) * 100 : 0;
            return (
              <div
                key={p}
                title={`${PILLAR_LABEL[p]}: ${s.pillarChunks[p].toLocaleString()} chunks`}
                style={{ width: `${pct}%`, backgroundColor: PILLAR_COLORS[p] }}
              />
            );
          })}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          {(Object.keys(s.pillarChunks) as BrainPillar[]).map((p) => (
            <div key={p} className="flex items-center gap-1.5 text-[12px] text-stone-600">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: PILLAR_COLORS[p] }}
              />
              {PILLAR_LABEL[p]}
              <span className="tabular-nums text-stone-400">
                {s.pillarChunks[p].toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
