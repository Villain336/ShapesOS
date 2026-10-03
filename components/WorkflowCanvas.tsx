// Marketr — automation canvas: client island (redesign §2).
//
// Node-graph builder on React Flow v12: drag node types from the palette,
// connect edges, edit node config in the inspector sheet, save the graph,
// run it, and review run history with per-node step statuses.
//
// UI language: vault components only (Card, ValuePill, Button, Field,
// TaskRows, GlideMenu, shadcn Sheet/Select/Input/Switch/Tabs/Tooltip).
// Phosphor icons only: duotone for feature icons, regular for small chrome.

"use client";

import Link from "next/link";
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
  Target,
  Leaf,
  Webhook,
  Zap,
  Scan,
  Link as LinkIcon,
  Bell,
  ChartColumn,
  Rocket,
  ShieldCheck,
  GitFork,
  Timer,
  Plus,
  Save,
  Trash,
  X,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  TriangleAlert,
  LoaderCircle,
  GitBranch as WorkflowIcon,
  Settings,
  History,
  MousePointer,
} from "lucide-react";
import {
  NODE_CATALOG,
  NODE_KINDS,
  nodeTypeDef,
  type ConfigField,
  type WorkflowNodeKind,
} from "@/lib/workflow/catalog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/vault/atoms/Button";
import { Card } from "@/components/vault/Card";
import { EmptyState } from "@/components/vault/EmptyState";
import { Field } from "@/components/vault/Field";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import TaskRows, { type TaskRow } from "@/components/vault/primitives/TaskRows";
import GlideMenu from "@/components/vault/primitives/GlideMenu";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
import { Switch } from "@/components/vault/shadcn/switch";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/vault/shadcn/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/vault/shadcn/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/vault/shadcn/tooltip";
import { confirmAction } from "@/lib/ui/feedback";

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
  Play, Clock, TrendingDown, Target, Leaf, Webhook, Zap, Scan, Link: LinkIcon,
  Bell, ChartColumn, Rocket, ShieldCheck, GitFork, Timer,
  // Legacy aliases: node catalogs stored phosphor icon names as strings.
  TrendDown: TrendingDown, WebhooksLogo: Webhook, Lightning: Zap, LinkSimple: LinkIcon,
  ChartBar: ChartColumn, FloppyDisk: Save, Warning: TriangleAlert, CircleNotch: LoaderCircle,
  GearSix: Settings, ClockCounterClockwise: History,
  // Legacy alias: pre-redesign workflows stored the "Sparkle" icon name.
  Sparkle: Zap,
};

/* Kind tiles — icons are always warm ink (never orange/red); kind is
 * distinguished by the tile wash. Approval nodes additionally carry a warm
 * amber ring on the node itself. */
const KIND_STYLES: Record<string, string> = {
  trigger: "bg-accent-tint text-ink-2",
  action: "bg-inset text-ink-2",
  approval: "bg-amber-tint text-ink-2",
  logic: "bg-green-tint text-ink-2",
};

const KIND_LABELS: Record<WorkflowNodeKind, string> = {
  trigger: "Triggers",
  action: "Actions",
  approval: "Approval",
  logic: "Logic",
};

const STATUS_TONES: Record<string, "neutral" | "green" | "orange" | "red" | "accent"> = {
  running: "orange",
  waiting_approval: "orange",
  succeeded: "green",
  active: "green",
  paused: "orange",
  failed: "red",
};

const STATUS_DOTS: Record<string, string> = {
  running: "bg-orange",
  waiting_approval: "bg-orange",
  succeeded: "bg-green",
  failed: "bg-red",
  active: "bg-green",
  paused: "bg-orange",
};

function StatusPill({ status }: { status: string }) {
  return <ValuePill tone={STATUS_TONES[status] ?? "neutral"}>{status.replace(/_/g, " ")}</ValuePill>;
}

function statusDot(status?: string | null) {
  if (!status) return null;
  const cls = STATUS_DOTS[status] ?? "bg-ink-3";
  const pulse = status === "running" ? " animate-pulse" : "";
  return (
    <span
      className={`absolute -right-1 -top-1 z-10 h-3 w-3 rounded-full ring-2 ring-surface ${cls}${pulse}`}
      title={status.replace(/_/g, " ")}
    />
  );
}

// ---------------------------------------------------------------------------
// Custom node (vault Card)
// ---------------------------------------------------------------------------

function WfNodeView({ data, selected }: NodeProps<WfNode>) {
  const def = nodeTypeDef(data.kind, data.type);
  const Icon = (def && ICONS[def.icon]) || WorkflowIcon;
  const isApproval = data.kind === "approval";
  return (
    <Card
      className={cn(
        "relative min-w-[190px] max-w-[230px] rounded-card",
        isApproval && "ring-1 ring-amber",
        selected && "ring-2 ring-accent",
      )}
    >
      {statusDot(data.status)}
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-ink-3" />
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-line", isApproval && "ring-amber", KIND_STYLES[data.kind] ?? "bg-field text-ink-2")}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink">{data.label}</div>
          <div className="text-[11px] capitalize text-ink-3">{def?.label ?? data.type}</div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-2 !border-surface !bg-ink-3" />
    </Card>
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
    return <p className="text-xs text-ink-3">No configuration for this node.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {fields.map((f) => {
        const v = config[f.key];
        return (
          <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.hint}>
            {f.type === "textarea" ? (
              <Textarea
                value={typeof v === "string" ? v : ""}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            ) : f.type === "select" ? (
              <Select
                value={typeof v === "string" ? v : (f.options?.[0] ?? "")}
                onValueChange={(val) => onChange(f.key, val)}
                disabled={disabled}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : f.type === "number" ? (
              <Input
                type="number"
                value={typeof v === "number" ? v : typeof v === "string" ? v : ""}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(e) => onChange(f.key, e.target.value === "" ? "" : Number(e.target.value))}
              />
            ) : f.type === "checkbox" ? (
              <Switch
                checked={v === true}
                disabled={disabled}
                onCheckedChange={(checked) => onChange(f.key, checked)}
              />
            ) : (
              <Input
                type="text"
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
// Palette (GlideMenu rows, draggable)
// ---------------------------------------------------------------------------

function Palette({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {NODE_KINDS.map((kind) => (
        <div key={kind}>
          <div className="mb-1.5 text-[12.5px] font-medium text-ink-3">
            {KIND_LABELS[kind]}
          </div>
          <GlideMenu highlightClassName="inset-x-0 rounded-control bg-hover">
            <div className="flex flex-col gap-1">
              {NODE_CATALOG[kind].map((def) => {
                const Icon = ICONS[def.icon] || WorkflowIcon;
                return (
                  <div
                    key={def.type}
                    data-menu-row
                    draggable={canEdit}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/wf-node", JSON.stringify({ kind, type: def.type }));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    title={def.description}
                    className={cn(
                      "flex items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink shadow-hairline",
                      canEdit ? "cursor-grab hover:border-line-strong active:cursor-grabbing" : "opacity-60",
                    )}
                  >
                    <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-line", KIND_STYLES[kind])}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="truncate font-medium">{def.label}</span>
                  </div>
                );
              })}
            </div>
          </GlideMenu>
        </div>
      ))}
      <p className="text-[11px] leading-snug text-ink-3">
        Drag a node onto the canvas, then drag from a handle to connect it. Click a node to edit its
        config; click an edge to label it true/false for condition branches.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main island
// ---------------------------------------------------------------------------

function CanvasInner({
  projectId,
  projectDomain,
  canEdit,
  initialWorkflows,
  initialRuns,
}: {
  projectId: string;
  projectDomain: string;
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
    if (!selectedId || !await confirmAction("Delete this workflow and its run history?")) return;
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
          /* Selected edges: orange-tinted stroke per design-v2. */
          stroke: selEdgeId === e.id ? "#fed7aa" : "#d6d3d1",
          strokeWidth: selEdgeId === e.id ? 2.5 : 2,
        },
        labelStyle: { fontSize: 11, fontWeight: 600, fill: "#71717a" },
        labelBgStyle: { fill: "#ffffff", fillOpacity: 1 },
        labelBgPadding: [6, 10] as [number, number],
        labelBgBorderRadius: 6,
      })),
    [edges, selEdgeId],
  );

  const closePropertySheet = useCallback(() => {
    setSelNodeId(null);
    setSelEdgeId(null);
  }, []);

  // --- render ------------------------------------------------------------------
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <div className="relative h-full overflow-hidden bg-page">
      {/* Canvas base — full bleed */}
      <div
        className="absolute inset-0"
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
      >
        {!wf ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              icon={<WorkflowIcon className="size-5" />}
              title="No workflow selected"
              description="Create or select a workflow to start building."
            />
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
            <Background color="#ddd9cc" gap={24} />
            <Controls className="!border-line !bg-surface !shadow-hairline" />
          </ReactFlow>
        )}
      </div>

      {/* Floating top-center toolbar: save + run */}
      <div className="material-float absolute left-1/2 top-4 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-1.5 rounded-full py-1.5 pl-4 pr-1.5 shadow-float-md ring-1 ring-line">
        <span className="max-w-40 truncate text-[13px] font-semibold text-ink">
          {wf?.name ?? "No workflow"}
        </span>
        {wf && <StatusPill status={wf.status} />}
        {dirty && canEdit && (
          <span className="size-2 shrink-0 rounded-full bg-amber" title="Unsaved changes" />
        )}
        <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button type="button" size="xs" variant="quiet" onClick={refreshRuns} aria-label="Refresh run history">
                <History className="size-3.5" />
              </Button>
            }
          />
          <TooltipContent>Refresh run history</TooltipContent>
        </Tooltip>
        <Button type="button" size="xs" variant="secondary" onClick={handleSave} disabled={!canEdit || !dirty || saving}>
          {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          Save
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="sm"
                variant="accent"
                onClick={handleRun}
                disabled={!canEdit || running || !wf}
                aria-label={dirty ? "Saves first, then runs" : "Run now"}
              >
                {running ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                {running ? "Running…" : "Run now"}
              </Button>
            }
          />
          <TooltipContent>{dirty ? "Saves first, then runs" : "Run now"}</TooltipContent>
        </Tooltip>
      </div>

      {/* Error + run banners, stacked under the toolbar */}
      {(error || selectedRun) && (
        <div className="absolute left-1/2 top-[68px] z-20 flex w-full max-w-xl -translate-x-1/2 flex-col gap-2 px-4">
          {error && (
            <div className="flex items-start gap-2 rounded-card bg-red-tint px-4 py-2 text-sm text-red shadow-float-sm ring-1 ring-line">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <span className="flex-1">{error}</span>
              <Button type="button" size="xs" variant="quiet" onClick={() => setError(null)} aria-label="Dismiss error">
                <X className="size-3.5" />
              </Button>
            </div>
          )}
          {selectedRun && (
            <div className="material-float flex items-center gap-3 rounded-card px-4 py-2 text-sm shadow-float-sm ring-1 ring-line">
              <StatusPill status={selectedRun.status} />
              <span className="min-w-0 flex-1 truncate text-ink-2">
                Run {selectedRun.triggerKind} · {new Date(selectedRun.startedAt).toLocaleString()}
              </span>
              {selectedRun.status === "waiting_approval" && (
                <a
                  href={`/dashboard/projects/${projectId}/autopilot`}
                  className="shrink-0 font-medium text-accent-ink hover:underline"
                >
                  Review in approval queue →
                </a>
              )}
              {selectedRun.error && <span className="truncate text-red">{selectedRun.error}</span>}
              <Button type="button" size="xs" variant="quiet" onClick={() => selectRun(null)} className="shrink-0">
                <X className="size-3.5" /> Clear run overlay
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Left: floating workflows + palette */}
      {leftOpen ? (
        <div className="material-float absolute bottom-4 left-4 top-4 z-10 flex w-64 flex-col rounded-card p-3 shadow-float-md ring-1 ring-line">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Link
              href={`/dashboard/projects/${projectId}`}
              className="inline-flex min-w-0 items-center gap-1 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink"
            >
              <ArrowLeft className="size-3.5 shrink-0" />
              <span className="truncate">{projectDomain}</span>
            </Link>
            <Button type="button" size="xs" variant="quiet" onClick={() => setLeftOpen(false)} aria-label="Collapse panel">
              <ChevronLeft className="size-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div>
              <div className="mb-2 text-[12.5px] font-medium text-ink-3">Workflows</div>
              {workflows.length === 0 ? (
                <p className="text-xs text-ink-3">No workflows yet — create one below.</p>
              ) : (
                <GlideMenu highlightClassName="inset-x-0 rounded-control bg-hover">
                  <div className="flex flex-col gap-0.5">
                    {workflows.map((w) => {
                      const lastRun = w.runs?.[0];
                      const active = w.id === selectedId;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          data-menu-row
                          onClick={() => loadWorkflow(w.id)}
                          className={cn(
                            "flex items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm",
                            active && "bg-accent-tint shadow-hairline",
                          )}
                        >
                          <WorkflowIcon className={cn("size-4 shrink-0", active ? "text-ink" : "text-ink-3")} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-ink">{w.name}</span>
                            <span className="block text-[11px] text-ink-3">
                              {w.status}
                              {lastRun ? ` · last run ${lastRun.status.replace(/_/g, " ")}` : ""}
                            </span>
                          </span>
                          {lastRun && <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOTS[lastRun.status] ?? "bg-ink-3")} />}
                        </button>
                      );
                    })}
                  </div>
                </GlideMenu>
              )}
              {canEdit && (
                <div className="mt-2 flex gap-1.5">
                  <Input
                    placeholder="New workflow name…"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createWorkflow()}
                    className="h-7 text-[13px]"
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="xs"
                          variant="accent"
                          onClick={createWorkflow}
                          disabled={creating || !newName.trim()}
                          aria-label="Create workflow"
                          className="shrink-0"
                        >
                          {creating ? <LoaderCircle className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                        </Button>
                      }
                    />
                    <TooltipContent>Create workflow</TooltipContent>
                  </Tooltip>
                </div>
              )}
            </div>
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-2 text-[12.5px] font-medium text-ink-3">Node palette</div>
              <Palette canEdit={canEdit} />
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setLeftOpen(true)}
          aria-label="Open workflows and palette"
          className="material-float absolute left-4 top-4 z-10 flex items-center gap-2 rounded-full py-2 pl-3 pr-4 text-[13px] font-medium text-ink-2 shadow-float-md ring-1 ring-line transition-colors hover:text-ink"
        >
          <WorkflowIcon className="size-4" />
          Workflows
        </button>
      )}

      {/* Right: floating inspector / runs */}
      {rightOpen ? (
        <div className="material-float absolute bottom-4 right-4 top-4 z-10 flex w-80 flex-col overflow-hidden rounded-card shadow-float-md ring-1 ring-line">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "inspector" | "runs")} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-1 px-2 pt-1">
              <TabsList variant="line" className="min-w-0 flex-1">
                <TabsTrigger value="inspector" className="flex-1">
                  <MousePointer className="size-3.5" /> Inspector
                </TabsTrigger>
                <TabsTrigger value="runs" className="flex-1">
                  <History className="size-3.5" /> Runs
                </TabsTrigger>
              </TabsList>
              <Button type="button" size="xs" variant="quiet" onClick={() => setRightOpen(false)} aria-label="Collapse inspector" className="shrink-0">
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
            <TabsContent value="inspector" className="min-h-0 flex-1 overflow-y-auto p-3">
              <WorkflowSettings
                settings={settings}
                canEdit={canEdit}
                saving={savingSettings}
                onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
                onSave={saveSettings}
                onDelete={deleteWorkflow}
              />
            </TabsContent>
            <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto p-3">
              <RunsPanel
                runs={wfRuns}
                selectedRun={selectedRun}
                onSelect={selectRun}
                projectId={projectId}
              />
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRightOpen(true)}
          aria-label="Open inspector"
          className="material-float absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full py-2 pl-3 pr-4 text-[13px] font-medium text-ink-2 shadow-float-md ring-1 ring-line transition-colors hover:text-ink"
        >
          <Settings className="size-4" />
          Inspector
        </button>
      )}

      {/* Property editor sheet */}
      <Sheet open={!!(selNode || selEdge)} onOpenChange={(open) => { if (!open) closePropertySheet(); }}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{selNode ? "Node settings" : "Connection settings"}</SheetTitle>
            <SheetDescription>
              {selNode
                ? "Edit the label and configuration for this node. Changes are unsaved until you press Save."
                : "Label this connection for condition branches."}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
            {selNode ? (
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
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspectors (rendered inside the property sheet)
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
          <ValuePill tone="neutral">{node.data.kind}</ValuePill>
          <span className="text-xs text-ink-3">{def?.label ?? node.data.type}</span>
        </div>
        {canEdit && (
          <Button type="button" size="xs" variant="ghost" onClick={onDelete} title="Delete node" className="text-red">
            <Trash className="h-3.5 w-3.5" /> Delete
          </Button>
        )}
      </div>
      <Field label="Label">
        <Input value={node.data.label} disabled={!canEdit} onChange={(e) => onLabel(e.target.value)} />
      </Field>
      {def && <ConfigEditor fields={def.fields} config={node.data.config} onChange={onConfig} disabled={!canEdit} />}
      {node.data.type === "condition" && (
        <p className="rounded-control bg-field px-3 py-2 text-[11px] leading-snug text-ink-2">
          Branch tip: click an outgoing edge and set its label to <b>true</b> or <b>false</b>. Unlabeled
          edges are followed on the default path.
        </p>
      )}
      {node.data.type === "approval_gate" && (
        <p className="rounded-control bg-field px-3 py-2 text-[11px] leading-snug text-ink-2">
          Pauses the run and pushes a pending item into the approval queue. Approve to resume, reject to
          cancel the run.
        </p>
      )}
      {node.data.status && (
        <div className="flex items-center gap-2 text-xs text-ink-3">
          Last run status: <StatusPill status={node.data.status} />
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
        <span className="text-sm font-semibold text-ink">Connection</span>
        {canEdit && (
          <Button type="button" size="xs" variant="ghost" onClick={onDelete} title="Delete edge" className="text-red">
            <Trash className="h-3.5 w-3.5" /> Delete
          </Button>
        )}
      </div>
      <Field label="Branch label" hint='For condition branches: "true" or "false". Empty = default path.'>
        <Select
          value={label ?? "none"}
          onValueChange={(v) => onLabel(v === "none" ? null : v)}
          disabled={!canEdit}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">(none — default path)</SelectItem>
            <SelectItem value="true">true</SelectItem>
            <SelectItem value="false">false</SelectItem>
          </SelectContent>
        </Select>
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
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Settings className="h-4 w-4 text-ink-3" />
        Workflow settings
      </div>
      <Field label="Name">
        <Input value={settings.name} disabled={!canEdit} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <Textarea value={settings.description} disabled={!canEdit} onChange={(e) => onChange({ description: e.target.value })} />
      </Field>
      <Field label="Status">
        <Select value={settings.status} onValueChange={(v) => { if (v !== null) onChange({ status: v }); }} disabled={!canEdit}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="draft">draft</SelectItem>
            <SelectItem value="active">active</SelectItem>
            <SelectItem value="paused">paused</SelectItem>
            <SelectItem value="archived">archived</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Schedule (cron)" hint="Fires automatically via /api/cron/workflows. Empty = manual only.">
        <Input value={settings.schedule} disabled={!canEdit} placeholder="0 9 * * *" onChange={(e) => onChange({ schedule: e.target.value })} />
      </Field>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-ink-2">Enabled</span>
        <Switch checked={settings.enabled} disabled={!canEdit} onCheckedChange={(checked) => onChange({ enabled: checked })} />
      </div>
      {canEdit && (
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="accent" onClick={onSave} disabled={saving} className="flex-1">
            {saving ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save settings
          </Button>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button type="button" size="sm" variant="ghost" onClick={onDelete} aria-label="Delete workflow" className="text-red">
                  <Trash className="h-4 w-4" />
                </Button>
              }
            />
            <TooltipContent>Delete workflow</TooltipContent>
          </Tooltip>
        </div>
      )}
      <p className="text-[11px] leading-snug text-ink-3">
        Only <b>active</b> + enabled workflows run. Manual runs need an active workflow; the kill switch
        in Content autopilot blocks all runs with a 423.
      </p>
    </div>
  );
}

function stepTaskRow(s: ServerStep): TaskRow {
  return {
    key: s.id,
    label: s.nodeLabel,
    amount: s.status.replace(/_/g, " "),
    status: s.status === "succeeded" ? "done" : s.status === "running" ? "running" : "sequence",
    details: [
      { label: "Kind", meta: s.nodeKind },
      ...(s.error ? [{ label: "Error", meta: s.error }] : []),
    ],
  };
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
    return (
      <EmptyState
        icon={<History className="h-5 w-5" />}
        title="No runs yet"
        description="Press “Run now” to execute the saved graph."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <GlideMenu highlightClassName="inset-x-0 rounded-control bg-hover">
        <div className="flex flex-col gap-1">
          {runs.map((r) => {
            const active = selectedRun?.id === r.id;
            return (
              <button
                key={r.id}
                type="button"
                data-menu-row
                onClick={() => onSelect(active ? null : r.id)}
                className={cn(
                  "rounded-control border px-2.5 py-2 text-left",
                  active ? "border-line-strong bg-accent-tint" : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <StatusPill status={r.status} />
                  <span className="text-[11px] text-ink-3">{new Date(r.startedAt).toLocaleString()}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
                  <span>{r.triggerKind} · {r._count?.steps ?? r.steps?.length ?? 0} steps</span>
                  <ChevronRight className="h-3.5 w-3.5" />
                </div>
                {r.error && <div className="mt-1 truncate text-[11px] text-red">{r.error}</div>}
              </button>
            );
          })}
        </div>
      </GlideMenu>
      {selectedRun?.steps && selectedRun.steps.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1.5 text-[12.5px] font-medium text-ink-3">
            Steps · {new Date(selectedRun.startedAt).toLocaleString()}
          </div>
          <TaskRows variant="List" rows={selectedRun.steps.map(stepTaskRow)} />
          {selectedRun.status === "waiting_approval" && (
            <a
              href={`/dashboard/projects/${projectId}/autopilot`}
              className="mt-2 block rounded-control bg-orange-tint px-2.5 py-2 text-[12px] font-medium text-orange"
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
  projectDomain: string;
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
