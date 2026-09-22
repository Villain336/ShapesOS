// Marketr — automation canvas: client island (redesign §2).
//
// Node-graph builder on React Flow v12: drag node types from the palette,
// connect edges, edit node config in the inspector, save the graph, run it,
// and review run history with per-node step statuses.
//
// Light theme from the start: white canvas, zinc-200 edges, orange accents
// for selected/running, red failed, green succeeded. Lucide icons only.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Background,
  Controls,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import {
  Play,
  Clock,
  TrendingDown,
  Radar,
  Leaf,
  Webhook,
  Sparkles,
  ScanSearch,
  Link2,
  Bell,
  FileBarChart,
  Rocket,
  ShieldCheck,
  GitFork,
  Timer,
  Plus,
  Save,
  Trash2,
  X,
  ChevronRight,
  AlertTriangle,
  Loader2,
  Workflow as WorkflowIcon,
  Settings2,
  History,
  MousePointer2,
} from "lucide-react";
import {
  NODE_CATALOG,
  NODE_KINDS,
  nodeTypeDef,
  type ConfigField,
  type WorkflowNodeKind,
} from "@/lib/workflow/catalog";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WfNodeData extends Record<string, unknown> {
  kind: string;
  type: string;
  label: string;
  config: Record<string, unknown>;
  status?: string | null;
}

type WfNode = Node<WfNodeData, "wf">;
type WfEdge = Edge<{ label?: string | null }>;

interface ServerNode {
  id: string;
  kind: string;
  type: string;
  label: string;
  config: unknown;
  positionX: number;
  positionY: number;
}

interface ServerEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label: string | null;
}

interface ServerWorkflow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  schedule: string | null;
  enabled: boolean;
  nodes: ServerNode[];
  edges: ServerEdge[];
  _count?: { runs: number };
  runs?: Array<{ id: string; status: string; startedAt: string; finishedAt: string | null }>;
}

interface ServerStep {
  id: string;
  nodeId: string;
  nodeKind: string;
  nodeLabel: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface ServerRun {
  id: string;
  workflowId: string;
  status: string;
  triggerKind: string;
  createdBy: string | null;
  error: string | null;
  pendingApprovalItemId: string | null;
  startedAt: string;
  finishedAt: string | null;
  workflow?: { id: string; name: string };
  steps?: ServerStep[];
  _count?: { steps: number };
}

const ICONS: Record<string, typeof Play> = {
  Play, Clock, TrendingDown, Radar, Leaf, Webhook, Sparkles, ScanSearch, Link2,
  Bell, FileBarChart, Rocket, ShieldCheck, GitFork, Timer,
};

const KIND_STYLES: Record<string, string> = {
  trigger: "bg-sky-50 text-sky-700 ring-sky-200",
  action: "bg-orange-50 text-orange-700 ring-orange-200",
  approval: "bg-amber-50 text-amber-700 ring-amber-200",
  logic: "bg-violet-50 text-violet-700 ring-violet-200",
};

const KIND_LABELS: Record<WorkflowNodeKind, string> = {
  trigger: "Triggers",
  action: "Actions",
  approval: "Approval",
  logic: "Logic",
};

const STATUS_STYLES: Record<string, string> = {
  running: "bg-orange-500",
  waiting_approval: "bg-amber-500",
  succeeded: "bg-green-500",
  failed: "bg-red-500",
  skipped: "bg-zinc-400",
  pending: "bg-zinc-300",
  queued: "bg-zinc-300",
  cancelled: "bg-zinc-500",
};

function statusDot(status?: string | null) {
  if (!status) return null;
  const cls = STATUS_STYLES[status] ?? "bg-zinc-300";
  const pulse = status === "running" ? " animate-pulse" : "";
  return <span className={`absolute -right-1 -top-1 h-3 w-3 rounded-full ring-2 ring-white ${cls}${pulse}`} title={status.replace(/_/g, " ")} />;
}

// ---------------------------------------------------------------------------
// Custom node
// ---------------------------------------------------------------------------

function WfNodeView({ data, selected }: NodeProps<WfNode>) {
  const def = nodeTypeDef(data.kind, data.type);
  const Icon = (def && ICONS[def.icon]) || WorkflowIcon;
  return (
    <div
      className={`relative min-w-[190px] max-w-[230px] rounded-xl border bg-white shadow-sm transition-shadow ${
        selected ? "border-orange-400 ring-2 ring-orange-500/40" : "border-zinc-200"
      }`}
    >
      {statusDot(data.status)}
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-zinc-400" />
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ${KIND_STYLES[data.kind] ?? "bg-zinc-100 text-zinc-600 ring-zinc-200"}`}>
          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-zinc-900">{data.label}</div>
          <div className="text-[11px] capitalize text-zinc-500">{def?.label ?? data.type}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-zinc-400" />
    </div>
  );
}

const nodeTypes = { wf: WfNodeView };

function toFlowNode(n: ServerNode, status?: string | null): WfNode {
  return {
    id: n.id,
    type: "wf",
    position: { x: n.positionX, y: n.positionY },
    data: {
      kind: n.kind,
      type: n.type,
      label: n.label,
      config: (n.config ?? {}) as Record<string, unknown>,
      status: status ?? null,
    },
  };
}

function toFlowEdge(e: ServerEdge): WfEdge {
  return {
    id: e.id,
    source: e.sourceNodeId,
    target: e.targetNodeId,
    label: e.label ?? undefined,
    data: { label: e.label },
  };
}

// ---------------------------------------------------------------------------
// Small UI atoms (plain Tailwind — matches existing studio components)
// ---------------------------------------------------------------------------

function Btn({
  children,
  onClick,
  disabled,
  variant = "default",
  className = "",
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "default" | "primary" | "danger" | "ghost";
  className?: string;
  title?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-all duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500";
  const variants: Record<string, string> = {
    default: "border border-zinc-300 bg-white px-3 py-1.5 text-zinc-700 hover:bg-zinc-50",
    primary: "bg-orange-600 px-3 py-1.5 text-white hover:bg-orange-700",
    danger: "border border-red-200 bg-white px-3 py-1.5 text-red-600 hover:bg-red-50",
    ghost: "px-2 py-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700",
  };
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} className={`${base} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-zinc-400">{hint}</span>}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/30";

// ---------------------------------------------------------------------------
// Config field editor (driven by the node catalog)
// ---------------------------------------------------------------------------

function ConfigEditor({
  fields,
  config,
  onChange,
  disabled,
}: {
  fields: ConfigField[];
  config: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled: boolean;
}) {
  if (fields.length === 0) {
    return <p className="text-xs text-zinc-400">No configuration for this node.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {fields.map((f) => {
        const v = config[f.key];
        return (
          <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}>
            {f.type === "textarea" ? (
              <textarea
                className={`${inputCls} min-h-[64px] resize-y`}
                value={typeof v === "string" ? v : ""}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            ) : f.type === "select" ? (
              <select
                className={inputCls}
                value={typeof v === "string" ? v : (f.options?.[0] ?? "")}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : f.type === "number" ? (
              <input
                type="number"
                className={inputCls}
                value={typeof v === "number" ? v : typeof v === "string" ? v : ""}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value === "" ? "" : Number(e.target.value))}
              />
            ) : f.type === "checkbox" ? (
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-zinc-300 accent-orange-600"
                checked={v === true}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.checked)}
              />
            ) : (
              <input
                type="text"
                className={inputCls}
                value={typeof v === "string" ? v : ""}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function Palette({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {NODE_KINDS.map((kind) => (
        <div key={kind}>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            {KIND_LABELS[kind]}
          </div>
          <div className="flex flex-col gap-1">
            {NODE_CATALOG[kind].map((def) => {
              const Icon = ICONS[def.icon] || WorkflowIcon;
              return (
                <div
                  key={def.type}
                  draggable={canEdit}
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/wf-node", JSON.stringify({ kind, type: def.type }));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  title={def.description}
                  className={`flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-[13px] text-zinc-700 shadow-sm transition-all duration-150 ${
                    canEdit ? "cursor-grab hover:border-orange-300 hover:shadow active:cursor-grabbing" : "opacity-60"
                  }`}
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ${KIND_STYLES[kind]}`}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                  </span>
                  <span className="truncate font-medium">{def.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-[11px] leading-snug text-zinc-400">
        Drag a node onto the canvas, then drag from a handle to connect it. Click a node to edit its
        config; click an edge to label it true/false for condition branches.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main island
// ---------------------------------------------------------------------------

function statusChip(status: string) {
  const dot = STATUS_STYLES[status] ?? "bg-zinc-300";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status.replace(/_/g, " ")}
    </span>
  );
}

function CanvasInner({
  projectId,
  canEdit,
  initialWorkflows,
  initialRuns,
}: {
  projectId: string;
  canEdit: boolean;
  initialWorkflows: ServerWorkflow[];
  initialRuns: ServerRun[];
}) {
  const [workflows, setWorkflows] = useState<ServerWorkflow[]>(initialWorkflows);
  const [selectedId, setSelectedId] = useState<string | null>(initialWorkflows[0]?.id ?? null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WfNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WfEdge>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [runs, setRuns] = useState<ServerRun[]>(initialRuns);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<ServerRun | null>(null);
  const [tab, setTab] = useState<"inspector" | "runs">("inspector");
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState({ name: "", description: "", status: "draft", schedule: "", enabled: true });
  const [savingSettings, setSavingSettings] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

  const wf = useMemo(() => workflows.find((w) => w.id === selectedId) ?? null, [workflows, selectedId]);

  const showError = (res: Response, data: { error?: string }, fallback: string) => {
    const msg = data?.error || fallback;
    setError(res.status === 423 ? `${msg} — release the kill switch in Content autopilot first.` : msg);
  };

  // --- load graph -----------------------------------------------------------
  const loadWorkflow = useCallback(
    async (id: string) => {
      setSelectedId(id);
      setSelectedRunId(null);
      setSelectedRun(null);
      setSelNodeId(null);
      setSelEdgeId(null);
      setDirty(false);
      setError(null);
      const res = await fetch(`/api/workflows/${id}`);
      if (!res.ok) {
        setError("Failed to load workflow");
        return;
      }
      const data = await res.json();
      const w: ServerWorkflow = data.workflow;
      setWorkflows((prev) => prev.map((x) => (x.id === id ? { ...x, ...w } : x)));
      setNodes(w.nodes.map((n) => toFlowNode(n)));
      setEdges(w.edges.map(toFlowEdge));
      setSettings({
        name: w.name,
        description: w.description ?? "",
        status: w.status,
        schedule: w.schedule ?? "",
        enabled: w.enabled,
      });
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    if (selectedId) loadWorkflow(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- change handlers (dirty tracking, selection) ---------------------------
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
      if (changes.some((c) => c.type !== "select")) setDirty(true);
    },
    [onNodesChange],
  );
  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChange>[0]) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type !== "select")) setDirty(true);
    },
    [onEdgesChange],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!canEdit) return;
      setEdges((eds) => addEdge({ ...conn }, eds));
      setDirty(true);
    },
    [canEdit, setEdges],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!canEdit) return;
      const raw = e.dataTransfer.getData("application/wf-node");
      if (!raw) return;
      const { kind, type } = JSON.parse(raw) as { kind: string; type: string };
      const def = nodeTypeDef(kind, type);
      if (!def) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const node: WfNode = {
        id: `tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        type: "wf",
        position,
        data: {
          kind,
          type,
          label: def.defaultLabel,
          config: JSON.parse(JSON.stringify(def.defaultConfig)),
          status: null,
        },
      };
      setNodes((nds) => [...nds, node]);
      setDirty(true);
    },
    [canEdit, screenToFlowPosition, setNodes],
  );

  const updateNodeData = useCallback(
    (id: string, patch: Partial<WfNodeData>) => {
      setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
      setDirty(true);
    },
    [setNodes],
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      setSelNodeId(null);
      setDirty(true);
    },
    [setNodes, setEdges],
  );

  const updateEdgeLabel = useCallback(
    (id: string, label: string | null) => {
      setEdges((eds) =>
        eds.map((e) => (e.id === id ? { ...e, label: label ?? undefined, data: { ...e.data, label } } : e)),
      );
      setDirty(true);
    },
    [setEdges],
  );

  const deleteEdge = useCallback(
    (id: string) => {
      setEdges((eds) => eds.filter((e) => e.id !== id));
      setSelEdgeId(null);
      setDirty(true);
    },
    [setEdges],
  );

  // --- save / run ------------------------------------------------------------
  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!selectedId) return false;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/${selectedId}/nodes`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          nodes: nodes.map((n) => ({
            id: n.id,
            kind: n.data.kind,
            type: n.data.type,
            label: n.data.label,
            config: n.data.config,
            positionX: Math.round(n.position.x),
            positionY: Math.round(n.position.y),
          })),
          edges: edges.map((e) => ({
            id: e.id.startsWith("tmp-") ? undefined : e.id,
            sourceNodeId: e.source,
            targetNodeId: e.target,
            label: (e.data?.label as string | null | undefined) ?? null,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(res, data, "Save failed");
        return false;
      }
      const savedNodes: ServerNode[] = data.nodes;
      const savedEdges: ServerEdge[] = data.edges;
      setNodes(savedNodes.map((n) => toFlowNode(n)));
      setEdges(savedEdges.map(toFlowEdge));
      setDirty(false);
      setWorkflows((prev) =>
        prev.map((w) => (w.id === selectedId ? { ...w, nodes: savedNodes, edges: savedEdges } : w)),
      );
      return true;
    } finally {
      setSaving(false);
    }
  }, [selectedId, nodes, edges, setNodes, setEdges]);

  const refreshRuns = useCallback(async () => {
    if (!selectedId) return;
    const res = await fetch(`/api/workflows/runs?projectId=${projectId}&workflowId=${selectedId}`);
    if (!res.ok) return;
    const data = await res.json();
    setRuns(data.runs);
  }, [selectedId, projectId]);

  const selectRun = useCallback(
    async (runId: string | null) => {
      setSelectedRunId(runId);
      if (!runId) {
        setSelectedRun(null);
        setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: null } })));
        return;
      }
      const res = await fetch(`/api/workflows/runs/${runId}`);
      if (!res.ok) return;
      const data = await res.json();
      const run: ServerRun = data.run;
      setSelectedRun(run);
      const statusByNode = new Map<string, string>();
      for (const s of run.steps ?? []) statusByNode.set(s.nodeId, s.status);
      setNodes((nds) =>
        nds.map((n) => ({ ...n, data: { ...n.data, status: statusByNode.get(n.id) ?? null } })),
      );
      setTab("runs");
    },
    [setNodes],
  );

  const handleRun = useCallback(async () => {
    if (!selectedId || running) return;
    setError(null);
    // Runs execute the last SAVED graph — persist first when dirty.
    if (dirty) {
      const ok = await handleSave();
      if (!ok) return;
    }
    setRunning(true);
    try {
      const res = await fetch(`/api/workflows/${selectedId}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(res, data, "Run failed");
        return;
      }
      await refreshRuns();
      if (data.run?.id) await selectRun(data.run.id);
    } finally {
      setRunning(false);
    }
  }, [selectedId, running, dirty, handleSave, refreshRuns, selectRun]);

  // --- workflows CRUD ----------------------------------------------------------
  const createWorkflow = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, name }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(res, data, "Create failed");
        return;
      }
      const w: ServerWorkflow = { ...data.workflow, nodes: [], edges: [] };
      setWorkflows((prev) => [w, ...prev]);
      setNewName("");
      await loadWorkflow(w.id);
    } finally {
      setCreating(false);
    }
  };

  const saveSettings = async () => {
    if (!selectedId) return;
    setSavingSettings(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/${selectedId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: settings.name,
          description: settings.description,
          status: settings.status,
          schedule: settings.schedule || null,
          enabled: settings.enabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(res, data, "Settings save failed");
        return;
      }
      setWorkflows((prev) => prev.map((w) => (w.id === selectedId ? { ...w, ...data.workflow } : w)));
    } finally {
      setSavingSettings(false);
    }
  };

  const deleteWorkflow = async () => {
    if (!selectedId || !window.confirm("Delete this workflow and its run history?")) return;
    const res = await fetch(`/api/workflows/${selectedId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(res, data, "Delete failed");
      return;
    }
    setWorkflows((prev) => prev.filter((w) => w.id !== selectedId));
    const next = workflows.find((w) => w.id !== selectedId);
    if (next) await loadWorkflow(next.id);
    else {
      setSelectedId(null);
      setNodes([]);
      setEdges([]);
    }
  };

  // --- derived -----------------------------------------------------------------
  const selNode = selNodeId ? nodes.find((n) => n.id === selNodeId) ?? null : null;
  const selEdge = selEdgeId ? edges.find((e) => e.id === selEdgeId) ?? null : null;
  const selNodeDef = selNode ? nodeTypeDef(selNode.data.kind, selNode.data.type) : null;
  const wfRuns = useMemo(() => runs.filter((r) => r.workflowId === selectedId), [runs, selectedId]);

  const displayEdges: WfEdge[] = useMemo(
    () =>
      edges.map((e) => ({
        ...e,
        style: {
          stroke: selEdgeId === e.id ? "#f97316" : "#d4d4d8",
          strokeWidth: selEdgeId === e.id ? 2.5 : 2,
        },
        labelStyle: { fontSize: 11, fontWeight: 600, fill: "#71717a" },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 1 },
        labelBgPadding: [6, 10] as [number, number],
        labelBgBorderRadius: 6,
      })),
    [edges, selEdgeId],
  );

  // --- render ------------------------------------------------------------------
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* Left: workflows + palette */}
      <div className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3">
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Workflows</div>
          <div className="flex flex-col gap-1">
            {workflows.map((w) => {
              const lastRun = w.runs?.[0];
              const active = w.id === selectedId;
              return (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => loadWorkflow(w.id)}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-150 ${
                    active ? "bg-orange-50 ring-1 ring-orange-200" : "hover:bg-zinc-50"
                  }`}
                >
                  <WorkflowIcon className={`h-4 w-4 shrink-0 ${active ? "text-orange-600" : "text-zinc-400"}`} strokeWidth={2} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-zinc-900">{w.name}</span>
                    <span className="block text-[11px] text-zinc-500">
                      {w.status}
                      {lastRun ? ` · last run ${lastRun.status.replace(/_/g, " ")}` : ""}
                    </span>
                  </span>
                  {lastRun && <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLES[lastRun.status] ?? "bg-zinc-300"}`} />}
                </button>
              );
            })}
            {workflows.length === 0 && (
              <p className="text-xs text-zinc-400">No workflows yet — create one below.</p>
            )}
          </div>
          {canEdit && (
            <div className="mt-2 flex gap-1.5">
              <input
                className={`${inputCls} !py-1.5 text-[13px]`}
                placeholder="New workflow name…"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createWorkflow()}
              />
              <Btn onClick={createWorkflow} disabled={creating || !newName.trim()} variant="primary" className="!px-2.5" title="Create workflow">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Btn>
            </div>
          )}
        </div>
        <div className="border-t border-zinc-100 pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Node palette</div>
          <Palette canEdit={canEdit} />
        </div>
      </div>

      {/* Center: canvas */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
        {error && (
          <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)} className="text-red-400 hover:text-red-600" aria-label="Dismiss">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {selectedRun && (
          <div className="flex items-center gap-3 border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-sm">
            {statusChip(selectedRun.status)}
            <span className="text-zinc-500">
              Run {selectedRun.triggerKind} · {new Date(selectedRun.startedAt).toLocaleString()}
            </span>
            {selectedRun.status === "waiting_approval" && (
              <a
                href={`/dashboard/projects/${projectId}/autopilot`}
                className="font-medium text-orange-600 hover:text-orange-700"
              >
                Review in approval queue →
              </a>
            )}
            {selectedRun.error && <span className="truncate text-red-600">{selectedRun.error}</span>}
            <button
              type="button"
              onClick={() => selectRun(null)}
              className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700"
            >
              <X className="h-3.5 w-3.5" /> Clear run overlay
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2">
          <span className="truncate text-sm font-semibold text-zinc-900">{wf?.name ?? "No workflow selected"}</span>
          {wf && (
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600">{wf.status}</span>
          )}
          {dirty && canEdit && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-600">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Unsaved changes
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Btn onClick={refreshRuns} variant="ghost" title="Refresh run history">
              <History className="h-4 w-4" />
            </Btn>
            <Btn onClick={handleSave} disabled={!canEdit || !dirty || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </Btn>
            <Btn onClick={handleRun} disabled={!canEdit || running || !wf} variant="primary" title={dirty ? "Saves first, then runs" : "Run now"}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "Running…" : "Run now"}
            </Btn>
          </div>
        </div>
        <div
          className="relative min-h-0 flex-1 bg-white"
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }}
        >
          {!wf ? (
            <div className="flex h-full items-center justify-center text-sm text-zinc-400">
              Create or select a workflow to start building.
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={displayEdges}
              onNodesChange={handleNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onSelectionChange={({ nodes: sn, edges: se }) => {
                setSelNodeId(sn[0]?.id ?? null);
                setSelEdgeId(se[0]?.id ?? null);
                if (sn[0] || se[0]) setTab("inspector");
              }}
              nodeTypes={nodeTypes}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
              colorMode="light"
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#e9e9ec" gap={24} />
              <Controls className="!border-zinc-200 !bg-white !shadow-sm" />
            </ReactFlow>
          )}
        </div>
      </div>

      {/* Right: inspector / runs */}
      <div className="flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
        <div className="flex border-b border-zinc-100">
          {(
            [
              { id: "inspector", label: "Inspector", icon: MousePointer2 },
              { id: "runs", label: "Runs", icon: History },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-[13px] font-medium transition-colors duration-150 ${
                tab === t.id ? "text-orange-700" : "text-zinc-500 hover:text-zinc-700"
              }`}
            >
              <t.icon className="h-4 w-4" strokeWidth={2} />
              {t.label}
              <span className={`absolute bottom-0 h-0.5 w-full ${tab === t.id ? "bg-orange-600" : "bg-transparent"}`} />
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "inspector" ? (
            selNode ? (
              <NodeInspector
                node={selNode}
                def={selNodeDef}
                canEdit={canEdit}
                onLabel={(label) => updateNodeData(selNode.id, { label })}
                onConfig={(key, value) =>
                  updateNodeData(selNode.id, { config: { ...selNode.data.config, [key]: value } })
                }
                onDelete={() => deleteNode(selNode.id)}
              />
            ) : selEdge ? (
              <EdgeInspector
                edge={selEdge}
                canEdit={canEdit}
                onLabel={(label) => updateEdgeLabel(selEdge.id, label)}
                onDelete={() => deleteEdge(selEdge.id)}
              />
            ) : (
              <WorkflowSettings
                settings={settings}
                canEdit={canEdit}
                saving={savingSettings}
                onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                onSave={saveSettings}
                onDelete={deleteWorkflow}
              />
            )
          ) : (
            <RunsPanel
              runs={wfRuns}
              selectedRun={selectedRun}
              onSelect={selectRun}
              projectId={projectId}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspectors
// ---------------------------------------------------------------------------

function NodeInspector({
  node,
  def,
  canEdit,
  onLabel,
  onConfig,
  onDelete,
}: {
  node: WfNode;
  def: ReturnType<typeof nodeTypeDef>;
  canEdit: boolean;
  onLabel: (label: string) => void;
  onConfig: (key: string, value: unknown) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${KIND_STYLES[node.data.kind] ?? ""}`}>
            {node.data.kind}
          </span>
          <span className="text-xs text-zinc-500">{def?.label ?? node.data.type}</span>
        </div>
        {canEdit && (
          <Btn variant="danger" onClick={onDelete} className="!px-2 !py-1" title="Delete node">
            <Trash2 className="h-3.5 w-3.5" />
          </Btn>
        )}
      </div>
      <Field label="Label">
        <input className={inputCls} value={node.data.label} disabled={!canEdit} onChange={(e) => onLabel(e.target.value)} />
      </Field>
      {def && <ConfigEditor fields={def.fields} config={node.data.config} onChange={onConfig} disabled={!canEdit} />}
      {node.data.type === "condition" && (
        <p className="rounded-lg bg-violet-50 px-2.5 py-2 text-[11px] leading-snug text-violet-700">
          Branch tip: click an outgoing edge and set its label to <b>true</b> or <b>false</b>. Unlabeled
          edges are followed on the default path.
        </p>
      )}
      {node.data.type === "approval_gate" && (
        <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700">
          Pauses the run and pushes a pending item into the approval queue. Approve to resume, reject to
          cancel the run.
        </p>
      )}
      {node.data.status && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          Last run status: {statusChip(node.data.status)}
        </div>
      )}
    </div>
  );
}

function EdgeInspector({
  edge,
  canEdit,
  onLabel,
  onDelete,
}: {
  edge: WfEdge;
  canEdit: boolean;
  onLabel: (label: string | null) => void;
  onDelete: () => void;
}) {
  const label = (edge.data?.label as string | null | undefined) ?? null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-900">Connection</span>
        {canEdit && (
          <Btn variant="danger" onClick={onDelete} className="!px-2 !py-1" title="Delete edge">
            <Trash2 className="h-3.5 w-3.5" />
          </Btn>
        )}
      </div>
      <Field label="Branch label" hint='For condition branches: "true" or "false". Empty = default path.'>
        <select
          className={inputCls}
          value={label ?? ""}
          disabled={!canEdit}
          onChange={(e) => onLabel(e.target.value || null)}
        >
          <option value="">(none — default path)</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </Field>
    </div>
  );
}

function WorkflowSettings({
  settings,
  canEdit,
  saving,
  onChange,
  onSave,
  onDelete,
}: {
  settings: { name: string; description: string; status: string; schedule: string; enabled: boolean };
  canEdit: boolean;
  saving: boolean;
  onChange: (patch: Partial<{ name: string; description: string; status: string; schedule: string; enabled: boolean }>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        <Settings2 className="h-4 w-4 text-zinc-400" strokeWidth={2} />
        Workflow settings
      </div>
      <Field label="Name">
        <input className={inputCls} value={settings.name} disabled={!canEdit} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <textarea className={`${inputCls} min-h-[56px] resize-y`} value={settings.description} disabled={!canEdit} onChange={(e) => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Status">
        <select className={inputCls} value={settings.status} disabled={!canEdit} onChange={(e) => onChange({ status: e.target.value })}>
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="archived">archived</option>
        </select>
      </Field>
      <Field label="Schedule (cron)" hint="Fires automatically via /api/cron/workflows. Empty = manual only.">
        <input className={inputCls} value={settings.schedule} disabled={!canEdit} placeholder="0 9 * * *" onChange={(e) => onChange({ schedule: e.target.value })} />
      </Field>
      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-zinc-300 accent-orange-600"
          checked={settings.enabled}
          disabled={!canEdit}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        Enabled
      </label>
      {canEdit && (
        <div className="flex gap-2">
          <Btn onClick={onSave} disabled={saving} variant="primary" className="flex-1">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save settings
          </Btn>
          <Btn onClick={onDelete} variant="danger" title="Delete workflow">
            <Trash2 className="h-4 w-4" />
          </Btn>
        </div>
      )}
      <p className="text-[11px] leading-snug text-zinc-400">
        Only <b>active</b> + enabled workflows run. Manual runs need an active workflow; the kill switch
        in Content autopilot blocks all runs with a 423.
      </p>
    </div>
  );
}

function RunsPanel({
  runs,
  selectedRun,
  onSelect,
  projectId,
}: {
  runs: ServerRun[];
  selectedRun: ServerRun | null;
  onSelect: (runId: string | null) => void;
  projectId: string;
}) {
  if (runs.length === 0) {
    return <p className="text-xs text-zinc-400">No runs yet. Press “Run now” to execute the saved graph.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {runs.map((r) => {
        const active = selectedRun?.id === r.id;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelect(active ? null : r.id)}
            className={`rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 ${
              active ? "border-orange-300 bg-orange-50" : "border-zinc-200 bg-white hover:border-zinc-300"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              {statusChip(r.status)}
              <span className="text-[11px] text-zinc-400">{new Date(r.startedAt).toLocaleString()}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500">
              <span>{r.triggerKind} · {r._count?.steps ?? r.steps?.length ?? 0} steps</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </div>
            {r.error && <div className="mt-1 truncate text-[11px] text-red-600">{r.error}</div>}
          </button>
        );
      })}
      {selectedRun?.steps && selectedRun.steps.length > 0 && (
        <div className="mt-2 border-t border-zinc-100 pt-2">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Steps — {new Date(selectedRun.startedAt).toLocaleString()}
          </div>
          <div className="flex flex-col gap-1">
            {selectedRun.steps.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-1.5">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${STATUS_STYLES[s.status] ?? "bg-zinc-300"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-zinc-800">{s.nodeLabel}</div>
                  <div className="text-[11px] text-zinc-500">{s.status.replace(/_/g, " ")}</div>
                  {s.error && <div className="text-[11px] text-red-600">{s.error}</div>}
                </div>
              </div>
            ))}
          </div>
          {selectedRun.status === "waiting_approval" && (
            <a
              href={`/dashboard/projects/${projectId}/autopilot`}
              className="mt-2 block rounded-lg bg-amber-50 px-2.5 py-2 text-[12px] font-medium text-amber-700 hover:bg-amber-100"
            >
              Waiting on approval — review in the approval queue →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export (ReactFlowProvider required for screenToFlowPosition)
// ---------------------------------------------------------------------------

export default function WorkflowCanvas(props: {
  projectId: string;
  canEdit: boolean;
  initialWorkflows: ServerWorkflow[];
  initialRuns: ServerRun[];
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
