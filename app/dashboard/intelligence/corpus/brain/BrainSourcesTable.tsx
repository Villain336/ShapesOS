// Marketr — Knowledge Brain: systemized sources table.
//
// The systematic counterpart to the visual brain: every corpus source in a
// dense, grouped table (house style per StudioApp.tsx — badge columns,
// hover:bg-violet-50/40). Grouped by pillar, then tier, then chunks desc.
// Clicking a row flies the 3D camera to that bead and opens its dossier.

import { Crosshair } from "lucide-react";
import type { BrainGraph, BrainNode, BrainPillar } from "@/lib/intelligence/corpus/graph";
import { Chip, PILLAR_COLORS, PILLAR_LABEL, PILLAR_TONE } from "./brain-ui";

const PILLAR_ORDER: BrainPillar[] = ["marketing", "growth", "design"];
const TIER_ORDER: Record<string, number> = { "1": 0, "2": 1, "1S": 2 };

function tierTone(tier: string): "amber" | "slate" | "violet" {
  return tier === "1" ? "amber" : tier === "1S" ? "violet" : "slate";
}

function statusOf(n: BrainNode): { label: string; tone: "green" | "amber" | "slate" | "violet" | "red" } {
  if (n.kind === "proposed") return { label: "Proposed", tone: "amber" };
  if (n.kind === "removal-flagged") return { label: "Flagged", tone: "red" };
  if (n.catalogStatus === "rights-review-pending") return { label: "Rights review", tone: "amber" };
  if (n.catalogStatus === "acquisition-pending") return { label: "Acquisition", tone: "slate" };
  if (n.catalogStatus === "segregated" || n.catalogStatus === "ingested")
    return { label: n.catalogStatus === "segregated" ? "Segregated" : "Ingested", tone: "green" };
  return { label: "Ingested", tone: "green" };
}

function sortedNodes(graph: BrainGraph): BrainNode[] {
  return [...graph.nodes].sort((a, b) => {
    const pg = PILLAR_ORDER.indexOf(a.pillar) - PILLAR_ORDER.indexOf(b.pillar);
    if (pg !== 0) return pg;
    // Proposed and catalog-only sources sink to the bottom of their pillar group.
    const ka = a.kind === "proposed" || a.kind === "catalog" ? 1 : 0;
    const kb = b.kind === "proposed" || b.kind === "catalog" ? 1 : 0;
    if (ka !== kb) return ka - kb;
    const tg = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (tg !== 0) return tg;
    return b.chunks - a.chunks;
  });
}

export function BrainSourcesTable({
  graph,
  selectedId,
  onFlyTo,
}: {
  graph: BrainGraph;
  selectedId: string | null;
  onFlyTo: (id: string) => void;
}) {
  const nodes = sortedNodes(graph);
  let lastPillar: BrainPillar | null = null;

  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="border-b border-stone-100 px-3 py-2">
        <div className="text-[13px] font-semibold text-stone-900">Sources</div>
        <div className="text-[11px] text-stone-400">
          The full corpus register — click any row to fly to its bead.
        </div>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="sticky top-0 bg-stone-50">
            <tr className="text-[11px] uppercase tracking-wide text-stone-400">
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 text-right font-medium">Chunks</th>
              <th className="px-3 py-2 font-medium">Mode</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="hidden px-3 py-2 font-medium md:table-cell">License basis</th>
              <th className="hidden px-3 py-2 font-medium lg:table-cell">Updated</th>
              <th className="w-8 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const header = n.pillar !== lastPillar;
              lastPillar = n.pillar;
              const selected = selectedId === n.id;
              const st = statusOf(n);
              return [
                header ? (
                  <tr key={`hdr-${n.pillar}`} className="bg-stone-50/70">
                    <td colSpan={8} className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-500">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ backgroundColor: PILLAR_COLORS[n.pillar] }}
                        />
                        {PILLAR_LABEL[n.pillar]}
                      </span>
                    </td>
                  </tr>
                ) : null,
                <tr
                  key={n.id}
                  onClick={() => onFlyTo(n.id)}
                  className={`cursor-pointer border-t border-stone-100 transition ${
                    selected ? "bg-violet-50/70" : "hover:bg-violet-50/40"
                  }`}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: PILLAR_COLORS[n.pillar] }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-stone-900">{n.title}</span>
                        <span className="block truncate text-[11px] text-stone-400">{n.author}</span>
                      </span>
                    </div>
                    <span className="mt-1 flex gap-1">
                      {n.kind === "proposed" && <Chip tone="amber">proposed</Chip>}
                      {n.kind === "catalog" && <Chip tone="slate">cataloged</Chip>}
                      {n.kind === "removal-flagged" && <Chip tone="red">flagged</Chip>}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={tierTone(n.tier)}>Tier {n.tier}</Chip>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-stone-700">
                    {n.chunks.toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={n.mode === "verbatim" ? "green" : "violet"}>
                      {n.mode === "verbatim" ? "verbatim" : "synthesis"}
                    </Chip>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={st.tone}>{st.label}</Chip>
                  </td>
                  <td
                    className="hidden max-w-[220px] truncate px-3 py-2 text-stone-500 md:table-cell"
                    title={n.licenseBasis}
                  >
                    {n.licenseBasis}
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-stone-500 lg:table-cell">
                    {n.retrievedDate ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Crosshair className="h-3.5 w-3.5 text-violet-300" />
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
