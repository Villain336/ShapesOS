// Marketr — Phase 8 G1: interactive mind-map view for the Business Graph explorer.
//
// Client component ("use client"). Renders the workspace's graph as a
// pan/zoom/drag node-link visualization (React Flow, already a dependency).
// Same data as the table view (existing /api/substrate/graph/* endpoints,
// same RLS) — no API changes.
//
// House style (locked): light mode, violet accents, Lucide icons per entity
// type, type pill badges, muted edge labels. Motion is restrained and serves
// comprehension; prefers-reduced-motion gets a static layout.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Handle,
  Position,
  useNodesState,
  useEdgesState,
  useReactFlow,
  useStoreApi,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
// NOTE: the @xyflow/react stylesheet is imported once in app/layout.tsx
// (Next.js only allows global CSS imports from the root layout).
import {
  User,
  Swords,
  Package,
  Wrench,
  Tag,
  Award,
  Briefcase,
  MapPin,
  Megaphone,
  Star,
  Globe,
  Database,
  Image as ImageIcon,
  KeyRound,
  FileText,
  Radio,
  Gift,
  Users,
  LayoutTemplate,
  MousePointerClick,
  Circle,
  Plus,
  Minus,
  Maximize,
  Loader2,
  type LucideIcon,
} from "lucide-react";

const TYPE_ICONS: Record<string, LucideIcon> = {
  customer: User,
  competitor: Swords,
  product: Package,
  service: Wrench,
  price: Tag,
  brand: Award,
  employee: Briefcase,
  location: MapPin,
  campaign_ref: Megaphone,
  review: Star,
  website: Globe,
  crm_record: Database,
  creative_asset: ImageIcon,
  keyword: KeyRound,
  content: FileText,
  channel: Radio,
  offer: Gift,
  audience: Users,
  landing_page: LayoutTemplate,
  form_cta: MousePointerClick,
};

interface ApiNode {
  id: string;
  entityType: string;
  displayName: string;
  canonicalKey: string;
}

interface ApiEdge {
  id: string;
  edgeType: string;
  from: { id: string; displayName: string; entityType: string };
  to: { id: string; displayName: string; entityType: string };
}

interface MindmapNodeData extends Record<string, unknown> {
  displayName: string;
  entityType: string;
}

type MindmapNode = Node<MindmapNodeData, "mindmap">;

function MindmapNodeView({ data, selected }: NodeProps<MindmapNode>) {
  const Icon = TYPE_ICONS[data.entityType] ?? Circle;
  return (
    <div
      className={`flex w-[168px] items-center gap-2 rounded-lg border bg-paper px-2.5 py-2 transition-shadow ${
        selected
          ? "border-ink shadow-raised"
          : "border-line hover:shadow-raised"
      }`}
    >
      {/* Invisible handles: React Flow needs at least one source + one target
          handle to compute edge geometry (isNodeInitialized). nodesConnectable
          is false so these are never interactive. */}
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: "none" }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: "none" }} />
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-key bg-ink">
        <Icon size={15} className="text-paper" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[0.75rem] font-semibold text-ink">
          {data.displayName}
        </span>
        <span className="mt-0.5 inline-block rounded-full bg-canvas px-1.5 py-px text-[0.6875rem] font-semibold text-muted">
          {data.entityType}
        </span>
      </span>
    </div>
  );
}

const nodeTypes = { mindmap: MindmapNodeView };

interface Pt {
  x: number;
  y: number;
}

/** Small force-directed layout: repulsion + springs + gravity, 2D. */
function forceLayout(
  ids: string[],
  links: Array<[string, string]>,
  width: number,
  height: number,
): Map<string, Pt> {
  const pos = new Map<string, Pt>();
  const n = ids.length;
  ids.forEach((id, i) => {
    const a = (i / Math.max(n, 1)) * Math.PI * 2;
    const r = Math.min(width, height) * 0.32;
    pos.set(id, { x: width / 2 + Math.cos(a) * r, y: height / 2 + Math.sin(a) * r });
  });
  const adj = new Map<string, string[]>();
  ids.forEach((id) => adj.set(id, []));
  for (const [a, b] of links) {
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const cx = width / 2;
  const cy = height / 2;
  const ITER = 140;
  for (let k = 0; k < ITER; k++) {
    const force = new Map<string, Pt>();
    ids.forEach((id) => force.set(id, { x: 0, y: 0 }));
    // Repulsion (capped so it can't explode).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = ids[i];
        const b = ids[j];
        const pa = pos.get(a)!;
        const pb = pos.get(b)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = Math.min(9000 / d2, 12);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const fa = force.get(a)!;
        const fb = force.get(b)!;
        fa.x += fx;
        fa.y += fy;
        fb.x -= fx;
        fb.y -= fy;
      }
    }
    // Springs along edges.
    const rest = 150;
    for (const [a, b] of links) {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = ((d - rest) / d) * 0.045;
      const fa = force.get(a)!;
      const fb = force.get(b)!;
      fa.x += dx * f;
      fa.y += dy * f;
      fb.x -= dx * f;
      fb.y -= dy * f;
    }
    // Gravity toward center.
    for (const id of ids) {
      const p = pos.get(id)!;
      const f = force.get(id)!;
      f.x += (cx - p.x) * 0.012;
      f.y += (cy - p.y) * 0.012;
    }
    // Integrate with damping.
    const damp = 0.85;
    for (const id of ids) {
      const p = pos.get(id)!;
      const f = force.get(id)!;
      p.x += f.x * damp;
      p.y += f.y * damp;
      p.x = Math.max(90, Math.min(width - 90, p.x));
      p.y = Math.max(40, Math.min(height - 40, p.y));
    }
  }
  return pos;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function ZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const btn =
    "flex h-8 w-8 items-center justify-center rounded-full bg-paper text-ink shadow-control aos-press hover:shadow-outline";
  return (
    <div className="absolute bottom-3 right-3 z-10 flex gap-1.5">
      <button type="button" className={btn} onClick={() => zoomIn({ duration: 200 })} aria-label="Zoom in">
        <Plus size={15} />
      </button>
      <button type="button" className={btn} onClick={() => zoomOut({ duration: 200 })} aria-label="Zoom out">
        <Minus size={15} />
      </button>
      <button type="button" className={btn} onClick={() => fitView({ duration: 300, padding: 0.15 })} aria-label="Fit graph">
        <Maximize size={14} />
      </button>
    </div>
  );
}

const GRAPH_NODE_LIMIT = 150;

function GraphCanvas({
  workspaceId,
  type,
  q,
  selectedId,
}: {
  workspaceId: string;
  type: string;
  q: string;
  selectedId?: string;
}) {
  const router = useRouter();
  const [nodes, setNodes, onNodesChange] = useNodesState<MindmapNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const animRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();
  const storeApi = useStoreApi();

  const selectNode = useCallback(
    (id: string) => {
      const params = new URLSearchParams();
      params.set("view", "graph");
      if (type && type !== "all") params.set("type", type);
      if (q) params.set("q", q);
      params.set("node", id);
      router.push(`/dashboard/substrate/graph?${params.toString()}`);
    },
    [router, type, q],
  );

  // Fetch nodes + edges (same endpoints, same RLS as the table view).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ workspaceId, limit: String(GRAPH_NODE_LIMIT) });
    if (type && type !== "all") params.set("type", type);
    if (q) params.set("q", q);
    Promise.all([
      fetch(`/api/substrate/graph/nodes?${params.toString()}`).then((r) => {
        if (!r.ok) throw new Error(`nodes ${r.status}`);
        return r.json();
      }),
      fetch(`/api/substrate/graph/edges?workspaceId=${encodeURIComponent(workspaceId)}`).then((r) => {
        if (!r.ok) throw new Error(`edges ${r.status}`);
        return r.json();
      }),
    ])
      .then(([nodeJson, edgeJson]) => {
        if (cancelled) return;
        const apiNodes = (nodeJson.nodes ?? []) as ApiNode[];
        const apiEdges = (edgeJson.edges ?? []) as ApiEdge[];
        const nodeIds = new Set(apiNodes.map((n) => n.id));
        // Keep only edges between visible nodes.
        const links = apiEdges.filter((e) => nodeIds.has(e.from.id) && nodeIds.has(e.to.id));

        const W = 900;
        const H = 560;
        const targets = forceLayout(
          apiNodes.map((n) => n.id),
          links.map((e) => [e.from.id, e.to.id]),
          W,
          H,
        );
        const reduceMotion =
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        const rfNodes: MindmapNode[] = apiNodes.map((n) => {
          const t = targets.get(n.id) ?? { x: W / 2, y: H / 2 };
          return {
            id: n.id,
            type: "mindmap",
            position: reduceMotion ? { x: t.x, y: t.y } : { x: W / 2, y: H / 2 },
            data: { displayName: n.displayName, entityType: n.entityType },
            selected: n.id === selectedId,
          };
        });
        const rfEdges = links.map((e) => ({
          id: e.id,
          source: e.from.id,
          target: e.to.id,
          label: e.edgeType,
          type: "smoothstep" as const,
          labelStyle: { fontSize: 10, fill: "var(--aos-text-muted)", fontFamily: "var(--aos-font-mono)" },
          labelBgStyle: { fill: "var(--aos-paper)", fillOpacity: 0.9 },
          labelBgPadding: [3, 5] as [number, number],
          style: { stroke: "var(--aos-line-strong)", strokeWidth: 1.5 },
        }));
        setNodes(rfNodes);
        setEdges(rfEdges);
        setLoading(false);

        // Gentle radial expansion: animate from center to layout targets,
        // then fit the viewport to the final layout.
        if (!reduceMotion && rfNodes.length > 0) {
          const start = performance.now();
          const DUR = 850;
          const from = new Map(rfNodes.map((nd) => [nd.id, { ...nd.position }]));
          const step = (now: number) => {
            if (cancelled) return;
            const t = Math.min((now - start) / DUR, 1);
            const e = easeOutCubic(t);
            setNodes((cur) =>
              cur.map((nd) => {
                const f = from.get(nd.id);
                const tgt = targets.get(nd.id);
                if (!f || !tgt) return nd;
                return {
                  ...nd,
                  position: { x: f.x + (tgt.x - f.x) * e, y: f.y + (tgt.y - f.y) * e },
                };
              }),
            );
            if (t < 1) animRef.current = requestAnimationFrame(step);
            else {
              animRef.current = null;
              // Settle the viewport on the final layout once nodes are placed.
              if (!cancelled) fitView({ padding: 0.18, duration: 350 });
            }
          };
          animRef.current = requestAnimationFrame(step);
        } else if (rfNodes.length > 0) {
          // Reduced motion (or empty): fit immediately, no animation.
          setTimeout(() => {
            if (!cancelled) fitView({ padding: 0.18 });
          }, 60);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load graph");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
    // Re-run when filters change; selectedId handled separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, type, q]);

  // Keep selection in sync when the ?node= param changes (detail panel is server-rendered).
  useEffect(() => {
    setNodes((cur) => cur.map((nd) => ({ ...nd, selected: nd.id === selectedId })));
  }, [selectedId, setNodes]);

  // React Flow v12 resets a node's measured dimensions + handle bounds
  // whenever setNodes() receives brand-new node objects (adoptUserNodes only
  // preserves internals when the object identity is unchanged or the new
  // objects carry `measured`). Our intro animation, selection sync and drags
  // all create new objects — without this, every animation frame unmounts
  // every edge (isNodeInitialized fails) and the ResizeObserver never
  // re-fires (node size doesn't change, only position), so edges
  // intermittently never render at all. Seed the DOM-measured dimensions
  // onto our node objects as soon as React Flow measures them; every later
  // setNodes then carries `measured` via object spread and node internals
  // (hence edges) survive.
  useEffect(() => {
    const seedMeasured = () => {
      const { nodeLookup } = storeApi.getState();
      setNodes((cur) => {
        if (cur.length === 0) return cur;
        let changed = false;
        const next = cur.map((nd) => {
          const m = nodeLookup.get(nd.id)?.measured;
          if (
            m?.width != null &&
            m?.height != null &&
            (nd.measured?.width !== m.width || nd.measured?.height !== m.height)
          ) {
            changed = true;
            return { ...nd, measured: { width: m.width, height: m.height } };
          }
          return nd;
        });
        return changed ? next : cur;
      });
    };
    seedMeasured();
    const unsub = storeApi.subscribe(seedMeasured);
    return unsub;
  }, [storeApi, setNodes]);

  // A user grab cancels the intro animation so it never fights the drag.
  const cancelIntro = useCallback(() => {
    if (animRef.current) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  }, []);

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: MindmapNode) => selectNode(node.id),
    [selectNode],
  );

  const nodeCount = nodes.length;

  return (
    <div ref={wrapRef} className="relative h-[560px] overflow-hidden rounded-lg bg-paper shadow-hairline">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDragStart={cancelIntro}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        minZoom={0.25}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        className="bg-canvas"
      >
        <Background color="var(--aos-line-strong)" gap={26} size={1} />
        <ZoomControls />
      </ReactFlow>

      {loading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/70">
          <span className="flex items-center gap-2 text-[0.8125rem] text-muted">
            <Loader2 size={15} className="animate-spin" /> Laying out the graph…
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="absolute inset-x-0 top-3 z-20 mx-auto w-fit rounded-md bg-failed-tint px-3 py-1.5 text-[0.8125rem] text-failed-text">
          Couldn&apos;t load the graph: {error}
        </div>
      )}
      {!loading && !error && nodeCount === 0 && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <p className="max-w-sm text-center text-[0.8125rem] text-muted">
            No entities yet. Seed the graph from the onboarding bootstrap or connect a source —
            every fact lands here with provenance.
          </p>
        </div>
      )}
      {!loading && !error && nodeCount > 0 && (
        <div className="absolute left-3 top-3 z-10 rounded-full bg-paper px-2.5 py-1 text-[0.75rem] font-semibold text-muted shadow-hairline">
          {nodeCount} nodes · {edges.length} edges · drag to move, scroll to zoom
        </div>
      )}
    </div>
  );
}

export function GraphMindmap({
  workspaceId,
  type,
  q,
  selectedId,
}: {
  workspaceId: string;
  type: string;
  q: string;
  selectedId?: string;
}) {
  const key = useMemo(() => `${workspaceId}|${type}|${q}`, [workspaceId, type, q]);
  return (
    <ReactFlowProvider>
      <GraphCanvas key={key} workspaceId={workspaceId} type={type} q={q} selectedId={selectedId} />
    </ReactFlowProvider>
  );
}
