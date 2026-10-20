// Marketr — Knowledge Brain: systemized sources table (Agentic OS).
//
// The systematic counterpart to the visual brain: every corpus source in a
// dense, grouped table. Grouped by pillar, then tier, then chunks desc.
// Clicking a row flies the 3D camera to that bead and opens its dossier.
// Statuses follow the status color+shape law; categories (pillar, tier,
// mode) are neutrals only.

import { Crosshair } from "lucide-react";
import type { BrainGraph, BrainNode, BrainPillar } from "@/lib/intelligence/corpus/graph";
import { Chip, PILLAR_COLORS, PILLAR_LABEL } from "./brain-ui";
import { activateOnKey } from "@/lib/ui/keyboard";

const PILLAR_ORDER: BrainPillar[] = ["marketing", "growth", "design"];
const TIER_ORDER: Record<string, number> = { "1": 0, "2": 1, "1S": 2 };

function statusOf(n: BrainNode): { label: string; tone: "done" | "needs" | "neutral" | "deny" } {
  if (n.kind === "proposed") return { label: "Proposed", tone: "needs" };
  if (n.kind === "removal-flagged") return { label: "Flagged", tone: "deny" };
  if (n.catalogStatus === "rights-review-pending") return { label: "Rights review", tone: "needs" };
  if (n.catalogStatus === "acquisition-pending") return { label: "Acquisition", tone: "neutral" };
  if (n.catalogStatus === "segregated" || n.catalogStatus === "ingested")
    return { label: n.catalogStatus === "segregated" ? "Segregated" : "Ingested", tone: "done" };
  return { label: "Ingested", tone: "done" };
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
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <div className="border-b border-line px-3 py-2">
        <div className="text-sm font-semibold text-ink">Sources</div>
        <div className="text-[0.6875rem] text-subtle">
          The full corpus register — click any row to fly to its bead.
        </div>
      </div>
      <div className="max-h-[420px] overflow-y-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-paper">
            <tr className="text-xs font-semibold text-muted">
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Tier</th>
              <th className="px-3 py-2 text-right">Chunks</th>
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Status</th>
              <th className="hidden px-3 py-2 md:table-cell">License basis</th>
              <th className="hidden px-3 py-2 lg:table-cell">Updated</th>
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
                  <tr key={`hdr-${n.pillar}`} className="bg-canvas">
                    <td colSpan={8} className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-muted">
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
                  tabIndex={0}
                  onKeyDown={activateOnKey(() => onFlyTo(n.id))}
                  className={`cursor-pointer border-t border-line transition ${
                    selected ? "bg-canvas" : "hover:bg-hover-paper"
                  }`}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: PILLAR_COLORS[n.pillar] }}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink">{n.title}</span>
                        <span className="block truncate text-[0.6875rem] text-subtle">{n.author}</span>
                      </span>
                    </div>
                    <span className="mt-1 flex gap-1">
                      {n.kind === "proposed" && <Chip tone="needs">Proposed</Chip>}
                      {n.kind === "catalog" && <Chip tone="neutral">Cataloged</Chip>}
                      {n.kind === "removal-flagged" && <Chip tone="deny">Flagged</Chip>}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone="neutral">Tier {n.tier}</Chip>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-ink">
                    {n.chunks.toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={n.mode === "verbatim" ? "done" : "neutral"}>
                      {n.mode === "verbatim" ? "Verbatim" : "Synthesis"}
                    </Chip>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={st.tone}>{st.label}</Chip>
                  </td>
                  <td
                    className="hidden max-w-[220px] truncate px-3 py-2 text-muted md:table-cell"
                    title={n.licenseBasis}
                  >
                    {n.licenseBasis}
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-2 text-muted lg:table-cell">
                    {n.retrievedDate ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Crosshair className="h-3.5 w-3.5 text-subtle" />
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
