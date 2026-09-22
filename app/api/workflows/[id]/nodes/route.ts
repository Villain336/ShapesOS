// Marketr — automation canvas API: replace the canvas graph.
// PUT /api/workflows/[id]/nodes
//   { nodes: [{ id?, kind, type, label, config?, positionX, positionY }],
//     edges: [{ id?, sourceNodeId, targetNodeId, label? }] }   (editor+)
//
// Replaces every node/edge of the workflow atomically. Client temp ids
// ("tmp-…") are mapped to fresh ids and edges are rewritten to match.

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { isError, requireWorkflow } from "@/lib/workflow/http";
import { CONDITION_LABELS, nodeTypeDef } from "@/lib/workflow/catalog";
import { parseCron } from "@/lib/workflow/cron";

export const dynamic = "force-dynamic";

interface NodeInput {
  id?: string;
  kind?: string;
  type?: string;
  label?: string;
  config?: unknown;
  positionX?: number;
  positionY?: number;
}

interface EdgeInput {
  id?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  label?: string | null;
}

const MAX_NODES = 200;
const MAX_EDGES = 400;

function bad(msg: string) {
  return Response.json({ error: msg }, { status: 400 });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "editor");
  if (isError(access)) return access.error;

  let body: { nodes?: NodeInput[]; edges?: EdgeInput[] };
  try {
    body = await req.json();
  } catch {
    return bad("Invalid JSON");
  }
  const nodes = body.nodes ?? [];
  const edges = body.edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return bad("nodes and edges must be arrays");
  if (nodes.length === 0) return bad("Workflow needs at least one node (a trigger)");
  if (nodes.length > MAX_NODES) return bad(`Too many nodes (max ${MAX_NODES})`);
  if (edges.length > MAX_EDGES) return bad(`Too many edges (max ${MAX_EDGES})`);

  // --- validate nodes -------------------------------------------------
  const idMap = new Map<string, string>(); // client id → final id
  const seenIds = new Set<string>();
  let triggerCount = 0;
  for (const n of nodes) {
    const def = nodeTypeDef(n.kind ?? "", n.type ?? "");
    if (!def) return bad(`Invalid node kind/type: ${n.kind}/${n.type}`);
    if (n.kind === "trigger") triggerCount++;
    const label = (n.label ?? "").trim();
    if (!label) return bad("Every node needs a label");
    if (typeof n.positionX !== "number" || typeof n.positionY !== "number") {
      return bad(`Node "${label}" needs numeric positionX/positionY`);
    }
    if (n.config !== undefined && (typeof n.config !== "object" || n.config === null || Array.isArray(n.config))) {
      return bad(`Node "${label}" config must be an object`);
    }
    // Validate schedule-trigger cron expressions at save time.
    if (n.kind === "trigger" && n.type === "schedule") {
      const cron = ((n.config ?? {}) as Record<string, unknown>).cron;
      try {
        parseCron(String(cron ?? ""));
      } catch (err) {
        return bad(`Schedule node "${label}": ${err instanceof Error ? err.message : "invalid cron"}`);
      }
    }
    const clientId = n.id ?? "";
    if (seenIds.has(clientId)) return bad(`Duplicate node id "${clientId}"`);
    seenIds.add(clientId);
    // Temp ids get fresh server ids; cuid-looking ids are kept as-is.
    const finalId = clientId.startsWith("tmp-") || !clientId ? undefined : clientId;
    idMap.set(clientId, finalId ?? "");
  }
  if (triggerCount === 0) return bad("Workflow needs at least one trigger node");

  // --- validate edges ---------------------------------------------------
  for (const e of edges) {
    const from = idMap.has(e.sourceNodeId ?? "") ? e.sourceNodeId! : null;
    const to = idMap.has(e.targetNodeId ?? "") ? e.targetNodeId! : null;
    if (!from || !to) return bad("Edges must reference existing node ids");
    if (from === to) return bad("Self-edges are not allowed");
    const label = e.label ?? null;
    if (label !== null && !(CONDITION_LABELS as readonly string[]).includes(label)) {
      return bad(`Edge labels must be "true", "false", or empty (got "${label}")`);
    }
  }

  // --- replace atomically -----------------------------------------------
  const created = await prisma.$transaction(async (tx) => {
    await tx.workflowEdge.deleteMany({ where: { workflowId: access.workflow.id } });
    await tx.workflowNode.deleteMany({ where: { workflowId: access.workflow.id } });

    const finalIds = new Map<string, string>();
    for (const n of nodes) {
      const clientId = n.id ?? "";
      const row = await tx.workflowNode.create({
        data: {
          ...(idMap.get(clientId) ? { id: idMap.get(clientId)! } : {}),
          workflowId: access.workflow.id,
          kind: n.kind!,
          type: n.type!,
          label: n.label!.trim().slice(0, 120),
          config: ((n.config ?? {}) as object) as never,
          positionX: n.positionX!,
          positionY: n.positionY!,
        },
      });
      finalIds.set(clientId, row.id);
    }
    const createdEdges = [];
    for (const e of edges) {
      const row = await tx.workflowEdge.create({
        data: {
          workflowId: access.workflow.id,
          sourceNodeId: finalIds.get(e.sourceNodeId!)!,
          targetNodeId: finalIds.get(e.targetNodeId!)!,
          label: e.label ?? null,
        },
      });
      createdEdges.push(row);
    }
    return { finalIds, createdEdges };
  });

  const savedNodes = await prisma.workflowNode.findMany({ where: { workflowId: access.workflow.id } });
  await prisma.fileChangeLog.create({
    data: {
      workspaceId: access.project.workspaceId,
      projectId: access.project.id,
      connectionId: null,
      filePath: "",
      actor: "user",
      action: "save",
      summary: `Workflow graph saved: ${savedNodes.length} nodes, ${created.createdEdges.length} edges`.slice(0, 280),
    },
  });

  return Response.json({ nodes: savedNodes, edges: created.createdEdges });
}
