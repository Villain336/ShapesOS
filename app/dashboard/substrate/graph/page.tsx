// Marketr — Phase 8 G1: entity explorer (SPEC-PHASE8.md §6).
//
// Entity explorer: type filter, search, node detail with edges / facts /
// provenance timeline. House pattern: sub-tab nav (layout), plain cards,
// badges top-right, light mode. Freshness is always labeled — the UI never
// implies real-time.

import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Badge } from "@/components/vault/shadcn/badge";
import { Input } from "@/components/vault/shadcn/input";
import { Button } from "@/components/vault/shadcn/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
import { Search, Network, GitBranch, ScrollText, ArrowLeftRight } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";
import { listFacts } from "@/lib/substrate/graph/facts";
import { ENTITY_TYPES } from "@/lib/substrate/graph/types";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Business Graph — Marketr",
  description: "Per-client knowledge graph: entities, relationships, provenance, freshness.",
};

function bucketVariant(bucket: string): "secondary" | "outline" | "destructive" {
  if (bucket === "fresh") return "secondary";
  if (bucket === "aging") return "outline";
  return "destructive";
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
  searchParams: Promise<{ type?: string; q?: string; node?: string }>;
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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Business Graph</h1>
          <p className="text-sm text-muted-foreground">
            The per-client knowledge graph: every entity with provenance and honest freshness
            labels. The substrate reads and computes — it never touches spend.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Badge variant="secondary">{nodes.length} entities shown</Badge>
          <Badge variant="outline">{countByType.size}/{ENTITY_TYPES.length} types covered</Badge>
        </div>
      </div>

      <form
        action="/dashboard/substrate/graph"
        method="get"
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search entities by name or key…"
            className="pl-9"
          />
        </div>
        <Select name="type" defaultValue={type}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Entity type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {ENTITY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {t} ({countByType.get(t) ?? 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit">Search</Button>
      </form>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          {nodes.length === 0 && (
            <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
              No entities yet. Seed the graph from the onboarding bootstrap or connect a
              source — every fact lands here with provenance.
            </div>
          )}
          {nodes.map((n) => {
            const f = freshnessLabel(n.asOf, n.asOfSource);
            const selected = n.id === selectedId;
            return (
              <Link
                key={n.id}
                href={`/dashboard/substrate/graph?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}&node=${n.id}`}
                className={`block rounded-xl border bg-card p-4 shadow-sm transition hover:shadow-md ${selected ? "ring-2 ring-primary" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{n.displayName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{f.label}</div>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {n.entityType}
                  </Badge>
                </div>
              </Link>
            );
          })}
        </div>

        <div>
          {!detail && (
            <div className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">
              <Network className="mb-2 h-5 w-5" />
              Select an entity to see its edges, facts, and provenance timeline.
            </div>
          )}
          {detail && (
            <div className="space-y-4">
              <div className="rounded-xl border bg-card p-5 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold">{detail.node.displayName}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {detail.node.canonicalKey}
                    </p>
                  </div>
                  <Badge variant={bucketVariant(freshnessLabel(detail.node.asOf, detail.node.asOfSource).bucket)}>
                    {freshnessLabel(detail.node.asOf, detail.node.asOfSource).label}
                  </Badge>
                </div>
                {detail.node.mergedInto && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Merged into{" "}
                    <Link
                      className="underline"
                      href={`/dashboard/substrate/graph?node=${detail.node.mergedInto.id}`}
                    >
                      {detail.node.mergedInto.displayName}
                    </Link>{" "}
                    (reversible via SAME_AS provenance)
                  </p>
                )}
                {detail.node.absorbed.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Absorbed {detail.node.absorbed.length} duplicate(s):{" "}
                    {detail.node.absorbed.map((a) => a.displayName).join(", ")}
                  </p>
                )}
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-muted p-2">
                    <div className="font-medium">First seen</div>
                    <div className="text-muted-foreground">
                      {detail.node.firstSeen.toLocaleString()}
                    </div>
                  </div>
                  <div className="rounded-md bg-muted p-2">
                    <div className="font-medium">Last seen</div>
                    <div className="text-muted-foreground">
                      {detail.node.lastSeen.toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border bg-card p-5 shadow-sm">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <GitBranch className="h-4 w-4" /> Edges ({detail.edges.length})
                </h3>
                <div className="space-y-2">
                  {detail.edges.map((e) => {
                    const other = e.fromNodeId === detail.node.id ? e.toNode : e.fromNode;
                    const dir = e.fromNodeId === detail.node.id ? "→" : "←";
                    const dead = e.expiredAt !== null;
                    // sourceFactId is a required FK — every edge has an asserting fact.
                    const sf = e.sourceFact!;
                    const edgeFresh = freshnessLabel(sf.observedAt, sf.source);
                    return (
                      <div
                        key={e.id}
                        className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs ${dead ? "opacity-50" : ""}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ArrowLeftRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="font-mono font-medium">{e.edgeType}</span>
                          <span className="text-muted-foreground">{dir}</span>
                          <Link
                            href={`/dashboard/substrate/graph?node=${other.id}`}
                            className="truncate underline"
                          >
                            {other.displayName}
                          </Link>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="text-muted-foreground" title={`asserted ${sf.observedAt.toLocaleString()} via ${sf.source}`}>
                            {edgeFresh.label}
                          </span>
                          <Badge variant={dead ? "destructive" : "outline"}>
                            {dead ? "invalidated" : "current"}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                  {detail.edges.length === 0 && (
                    <p className="text-xs text-muted-foreground">No relationships yet.</p>
                  )}
                </div>
              </div>

              <div className="rounded-xl border bg-card p-5 shadow-sm">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <ScrollText className="h-4 w-4" /> Provenance timeline ({detail.facts.length})
                </h3>
                <div className="space-y-2">
                  {detail.facts.map((f) => (
                    <div key={f.id} className="rounded-md border px-3 py-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium">{f.factType}</span>
                        <Badge variant="outline" className="shrink-0">
                          {f.source}
                        </Badge>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        observed {f.observedAt.toLocaleString()} · ingested{" "}
                        {f.ingestedAt.toLocaleString()} · hash {f.contentHash.slice(0, 12)}
                      </div>
                      <div className="text-muted-foreground">record: {f.sourceRecordId}</div>
                    </div>
                  ))}
                  {detail.facts.length === 0 && (
                    <p className="text-xs text-muted-foreground">No facts recorded.</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
