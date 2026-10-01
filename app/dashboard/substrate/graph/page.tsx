// Marketr — Phase 8 G1: entity explorer.
//
// Entity explorer: type filter, search, node detail with edges / facts /
// provenance timeline. Agentic OS: black pill search, neutral chips, dense
// table, token inputs. Freshness is always labeled — the UI never implies
// real-time.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Search, Network, GitBranch, ScrollText, ArrowLeftRight, Table2, Share2 } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";
import { listFacts } from "@/lib/substrate/graph/facts";
import { ENTITY_TYPES } from "@/lib/substrate/graph/types";
import { GraphMindmap } from "./mindmap-client";
import {
  Chip,
  PageTitle,
  btnPrimary,
  infoNoteCls,
  inputCls,
  rowCls,
  tableShell,
  thCls,
  theadCls,
} from "../ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Business Graph — Marketr",
  description: "Per-client knowledge graph: entities, relationships, provenance, freshness.",
};

function bucketTone(bucket: string): "slate" | "amber" | "red" {
  if (bucket === "fresh") return "slate";
  if (bucket === "aging") return "amber";
  return "red";
}

async function searchNodes(workspaceId: string, type: string, q: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.graphNode.findMany({
      where: {
        workspaceId,
        mergedIntoId: null,
        ...(type && type !== "all" ? { entityType: type as (typeof ENTITY_TYPES)[number] } : {}),
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: "insensitive" } },
                { canonicalKey: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { lastSeen: "desc" },
      take: 60,
      select: {
        id: true,
        entityType: true,
        displayName: true,
        asOf: true,
        asOfSource: true,
      },
    }),
  );
}

async function nodeDetail(workspaceId: string, id: string) {
  const node = await withWorkspaceScope(workspaceId, (tx) =>
    tx.graphNode.findFirst({
      where: { workspaceId, id },
      include: {
        mergedInto: { select: { id: true, displayName: true } },
        absorbed: { select: { id: true, displayName: true, entityType: true } },
      },
    }),
  );
  if (!node) return null;
  const edges = await withWorkspaceScope(workspaceId, (tx) =>
    tx.graphEdge.findMany({
      where: { workspaceId, OR: [{ fromNodeId: id }, { toNodeId: id }] },
      include: {
        fromNode: { select: { id: true, displayName: true, entityType: true } },
        toNode: { select: { id: true, displayName: true, entityType: true } },
        // Edge freshness is derived from its asserting fact, never stored.
        sourceFact: { select: { observedAt: true, source: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
  const facts = await listFacts(workspaceId, { entityRef: node.canonicalKey, limit: 50 });
  return { node, edges, facts };
}

export default async function GraphExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string; node?: string; view?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const params = await searchParams;
  const type = params.type ?? "all";
  const q = params.q ?? "";
  const selectedId = params.node;
  const view: "table" | "graph" = params.view === "graph" ? "graph" : "table";

  const viewHref = (v: "table" | "graph") => {
    const p = new URLSearchParams();
    if (type && type !== "all") p.set("type", type);
    if (q) p.set("q", q);
    if (selectedId) p.set("node", selectedId);
    if (v === "graph") p.set("view", "graph");
    const qs = p.toString();
    return `/dashboard/substrate/graph${qs ? `?${qs}` : ""}`;
  };

  // Detail-panel links keep the current view so the graph view doesn't
  // bounce the user back to the table.
  const nodeHref = (id: string) => {
    const p = new URLSearchParams();
    if (view === "graph") p.set("view", "graph");
    p.set("node", id);
    return `/dashboard/substrate/graph?${p.toString()}`;
  };

  const [nodes, detail, typeCounts] = await Promise.all([
    searchNodes(workspace.id, type, q),
    selectedId ? nodeDetail(workspace.id, selectedId) : Promise.resolve(null),
    withWorkspaceScope(workspace.id, (tx) =>
      tx.graphNode.groupBy({
        by: ["entityType"],
        where: { workspaceId: workspace.id, mergedIntoId: null },
        _count: true,
      }),
    ).catch(() => [] as Array<{ entityType: string; _count: number }>),
  ]);
  const countByType = new Map(typeCounts.map((t) => [String(t.entityType), t._count]));

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageTitle
          title="Business Graph"
          subtitle="The per-client knowledge graph: every entity with provenance and honest freshness labels. The substrate reads and computes — it never touches spend."
        />
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Chip>{nodes.length} entities shown</Chip>
          <Chip>
            {countByType.size}/{ENTITY_TYPES.length} types covered
          </Chip>
          <span
            className="ml-1 inline-flex items-center rounded-md border border-line bg-paper p-0.5"
            role="tablist"
            aria-label="Explorer view"
          >
            {(
              [
                { v: "table", label: "Table", Icon: Table2 },
                { v: "graph", label: "Graph", Icon: Share2 },
              ] as const
            ).map(({ v, label, Icon }) => (
              <Link
                key={v}
                href={viewHref(v)}
                role="tab"
                aria-selected={view === v}
                className={`flex items-center gap-1.5 rounded-[5px] px-2.5 py-1.5 text-[12.5px] font-medium transition active:scale-[0.97] ${
                  view === v
                    ? "bg-ink text-white shadow-hairline"
                    : "text-muted hover:text-ink"
                }`}
              >
                <Icon size={14} />
                {label}
              </Link>
            ))}
          </span>
        </div>
      </div>

      <form
        action="/dashboard/substrate/graph"
        method="get"
        className="mb-3 mt-4 flex flex-wrap items-center gap-2"
      >
        {view === "graph" && <input type="hidden" name="view" value="graph" />}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <input
            name="q"
            defaultValue={q}
            placeholder="Search entities by name or key…"
            className={`${inputCls} w-64 pl-9`}
          />
        </div>
        <select name="type" defaultValue={type} className={inputCls} aria-label="Entity type">
          <option value="all">All types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t} ({countByType.get(t) ?? 0})
            </option>
          ))}
        </select>
        <button type="submit" className={btnPrimary}>
          <Search size={14} /> Search
        </button>
      </form>

      <div className="grid gap-4 lg:grid-cols-2">
        {view === "table" ? (
          <div className={tableShell}>
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className={theadCls}>
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Type</th>
                  <th className={thCls}>Freshness</th>
                  <th className={thCls}>Source</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => {
                  const f = freshnessLabel(n.asOf, n.asOfSource);
                  const selected = n.id === selectedId;
                  return (
                    <tr key={n.id} className={`${rowCls}${selected ? " bg-hover-paper" : ""}`}>
                      <td className="px-3 py-2 font-medium text-ink">
                        <Link
                          href={`/dashboard/substrate/graph?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}&node=${n.id}`}
                          className="hover:underline"
                        >
                          {n.displayName}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <Chip>{n.entityType}</Chip>
                      </td>
                      <td className="px-3 py-2 text-muted" title={f.label}>
                        {f.label}
                      </td>
                      <td className="px-3 py-2 text-muted">{n.asOfSource}</td>
                    </tr>
                  );
                })}
                {nodes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-[13px] text-subtle">
                      No entities yet. Seed the graph from the onboarding bootstrap or connect a
                      source — every fact lands here with provenance.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <GraphMindmap workspaceId={workspace.id} type={type} q={q} selectedId={selectedId} />
        )}

        <div>
          {!detail && (
            <div className={infoNoteCls}>
              <div className="flex items-center gap-2 font-medium text-ink">
                <Network size={14} /> Entity detail
              </div>
              <p className="mt-1">Select an entity to see its edges, facts, and provenance timeline.</p>
            </div>
          )}
          {detail && (
            <div className="space-y-4">
              <div className="rounded-lg border border-line bg-paper p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="aos-subheading">{detail.node.displayName}</h2>
                    <div className="mt-1 font-mono text-[11px] text-muted">{detail.node.canonicalKey}</div>
                  </div>
                  <Chip tone={bucketTone(freshnessLabel(detail.node.asOf, detail.node.asOfSource).bucket)}>
                    {freshnessLabel(detail.node.asOf, detail.node.asOfSource).label}
                  </Chip>
                </div>
                {detail.node.mergedInto && (
                  <p className="mt-2 text-xs text-muted">
                    Merged into{" "}
                    <Link
                      className="underline"
                      href={nodeHref(detail.node.mergedInto.id)}
                    >
                      {detail.node.mergedInto.displayName}
                    </Link>{" "}
                    (reversible via SAME_AS provenance)
                  </p>
                )}
                {detail.node.absorbed.length > 0 && (
                  <p className="mt-2 text-xs text-muted">
                    Absorbed {detail.node.absorbed.length} duplicate(s):{" "}
                    {detail.node.absorbed.map((a) => a.displayName).join(", ")}
                  </p>
                )}
                <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border border-line bg-paper px-2.5 py-2">
                    <dt className="font-medium text-muted">First seen</dt>
                    <dd className="text-muted">{detail.node.firstSeen.toLocaleString()}</dd>
                  </div>
                  <div className="rounded-md border border-line bg-paper px-2.5 py-2">
                    <dt className="font-medium text-muted">Last seen</dt>
                    <dd className="text-muted">{detail.node.lastSeen.toLocaleString()}</dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-lg border border-line bg-paper p-4">
                <h3 className="aos-subheading flex items-center gap-2">
                  <GitBranch size={14} /> Edges ({detail.edges.length})
                </h3>
                <ul className="mt-2">
                  {detail.edges.map((e) => {
                    const other = e.fromNodeId === detail.node.id ? e.toNode : e.fromNode;
                    const dir = e.fromNodeId === detail.node.id ? "→" : "←";
                    const dead = e.expiredAt !== null;
                    // sourceFactId is optional (onDelete: SetNull) — edges without an
                    // asserting fact fall back to the edge's own validAt.
                    const edgeFresh = freshnessLabel(
                      e.sourceFact?.observedAt ?? e.validAt,
                      e.sourceFact?.source ?? "unasserted",
                    );
                    return (
                      <li
                        key={e.id}
                        className={`flex items-center justify-between gap-2 border-b border-line py-2 text-xs last:border-0 ${dead ? "opacity-50" : ""}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ArrowLeftRight size={12} className="shrink-0 text-subtle" />
                          <span className="font-mono font-medium text-ink">{e.edgeType}</span>
                          <span className="text-subtle">{dir}</span>
                          <Link
                            href={nodeHref(other.id)}
                            className="truncate text-muted underline"
                          >
                            {other.displayName}
                          </Link>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span
                            className="text-muted"
                            title={
                              e.sourceFact
                                ? `asserted ${e.sourceFact.observedAt.toLocaleString()} via ${e.sourceFact.source}`
                                : `edge valid since ${e.validAt.toLocaleString()} · no asserting fact`
                            }
                          >
                            {edgeFresh.label}
                          </span>
                          <Chip tone={dead ? "red" : "slate"}>{dead ? "invalidated" : "current"}</Chip>
                        </div>
                      </li>
                    );
                  })}
                  {detail.edges.length === 0 && (
                    <li className="py-2 text-xs text-subtle">No relationships yet.</li>
                  )}
                </ul>
              </div>

              <div className="rounded-lg border border-line bg-paper p-4">
                <h3 className="aos-subheading flex items-center gap-2">
                  <ScrollText size={14} /> Provenance timeline ({detail.facts.length})
                </h3>
                <ul className="mt-2">
                  {detail.facts.map((f) => (
                    <li key={f.id} className="border-b border-line py-2 text-xs last:border-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-ink">{f.factType}</span>
                        <Chip>{f.source}</Chip>
                      </div>
                      <div className="mt-1 text-muted">
                        observed {f.observedAt.toLocaleString()} · ingested{" "}
                        {f.ingestedAt.toLocaleString()} · hash <span className="font-mono">{f.contentHash.slice(0, 12)}</span>
                      </div>
                      <div className="text-muted">record: {f.sourceRecordId}</div>
                    </li>
                  ))}
                  {detail.facts.length === 0 && (
                    <li className="py-2 text-xs text-subtle">No facts recorded.</li>
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
