// ShapesOS — signed inbound URL for the workflow canvas "webhook" trigger
// (Phase 6 runtime).
//
//   POST /api/hooks/workflows/<workflowId>
//   ShapesOS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
//
// The signature scheme is the one ShapesOS already uses for its outbound
// webhooks (lib/webhooks/signing.ts — computeSignature / verifyWebhookSignature,
// 5-minute replay window), so a sender can reuse the receiver code we
// document there; there is no second HMAC implementation here.
//
// Secret: one per workflow ("whsec_…", mintWebhookSecret), minted or rotated
// from the canvas by an editor, shown once, stored only as a secrets()
// envelope with a non-sensitive hint (same convention as outbound
// webhook_endpoints). Rotation invalidates the old secret immediately.
//
// Replay: besides the timestamp window, every accepted signature is recorded
// (workflow_webhook_receipts, unique per workflow), so the exact same signed
// request is refused even inside the window. Receipts older than twice the
// window are pruned on the next delivery.
//
// The run starts through the engine's normal path (startWorkflowRun — kill
// switch, 5-minute dedupe, inline execution), the same one the manual run
// API uses, with triggerKind "webhook" and the JSON body as the trigger
// payload (nodes read it as "trigger.<field>").

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { secrets } from "@/lib/secrets";
import {
  computeSignature,
  DEFAULT_TOLERANCE_SECONDS,
  mintWebhookSecret,
  parseSignatureHeader,
  secretHint,
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} from "@/lib/webhooks/signing";
import { startWorkflowRun, WorkflowKilledError } from "./engine";

export { SIGNATURE_HEADER };

/** Largest accepted request body (raw bytes). */
export const WORKFLOW_WEBHOOK_MAX_BYTES = 64 * 1024;

/** Public path of a workflow's inbound URL. */
export function workflowWebhookPath(workflowId: string): string {
  return `/api/hooks/workflows/${encodeURIComponent(workflowId)}`;
}

type NodeLike = { kind: string; type: string };

export function isWebhookTrigger(n: NodeLike): boolean {
  return n.kind === "trigger" && n.type === "webhook";
}

export interface WorkflowWebhookView {
  /** True when the workflow has a webhook trigger node (saved). */
  hasTrigger: boolean;
  /** True when a signing secret exists. */
  configured: boolean;
  secretHint: string | null;
  lastReceivedAt: string | null;
  path: string;
}

export async function getWorkflowWebhook(workflowId: string): Promise<WorkflowWebhookView> {
  const [hook, triggers] = await Promise.all([
    prisma.workflowWebhook.findUnique({ where: { workflowId } }),
    prisma.workflowNode.count({ where: { workflowId, kind: "trigger", type: "webhook" } }),
  ]);
  return {
    hasTrigger: triggers > 0,
    configured: !!hook,
    secretHint: hook?.secretHint ?? null,
    lastReceivedAt: hook?.lastReceivedAt?.toISOString() ?? null,
    path: workflowWebhookPath(workflowId),
  };
}

/**
 * Mint (first time) or rotate the workflow's signing secret. Returns the raw
 * secret exactly once; only the envelope and hint are stored.
 */
export async function rotateWorkflowWebhookSecret(
  workflowId: string,
  userId: string | null,
): Promise<{ secret: string; view: WorkflowWebhookView }> {
  const secret = mintWebhookSecret();
  const data = { secretEnc: secrets().encrypt(secret), secretHint: secretHint(secret), createdBy: userId };
  await prisma.workflowWebhook.upsert({
    where: { workflowId },
    create: { workflowId, ...data },
    update: data,
  });
  // Old receipts were signed with the old secret; nothing to keep.
  await prisma.workflowWebhookReceipt.deleteMany({ where: { workflowId } });
  return { secret, view: await getWorkflowWebhook(workflowId) };
}

/** Remove the secret: the inbound URL stops accepting calls. */
export async function revokeWorkflowWebhook(workflowId: string): Promise<void> {
  await prisma.workflowWebhook.deleteMany({ where: { workflowId } });
}

export type ReceiveResult =
  | { ok: true; status: 200 | 201; runId: string; runStatus: string; deduped: boolean }
  | { ok: false; status: 400 | 401 | 404 | 409 | 423; error: string };

const NOT_FOUND = { ok: false, status: 404, error: "Not found" } as const;

export interface ReceiveArgs {
  workflowId: string;
  rawBody: string;
  signature: string | null;
  /** ms epoch (tests). */
  now?: number;
}

/**
 * Verify and act on one inbound call. Every failure before the signature
 * checks out answers 404 or 401 without saying which part was wrong beyond
 * "bad signature" / "expired", so the URL is no oracle for workflow ids.
 */
export async function receiveWorkflowWebhook(args: ReceiveArgs): Promise<ReceiveResult> {
  const now = args.now ?? Date.now();
  const workflow = await prisma.workflow.findUnique({
    where: { id: args.workflowId },
    select: {
      id: true,
      name: true,
      enabled: true,
      status: true,
      projectId: true,
      project: { select: { workspaceId: true } },
      webhook: { select: { secretEnc: true } },
      nodes: { where: { kind: "trigger", type: "webhook" }, select: { id: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!workflow?.webhook || workflow.nodes.length === 0) return NOT_FOUND;

  let secret: string;
  try {
    secret = secrets().decrypt(workflow.webhook.secretEnc);
  } catch {
    return NOT_FOUND; // undecryptable (key rotated away) — treat as unconfigured
  }

  const verdict = verifyWebhookSignature(secret, args.rawBody, args.signature, { now });
  if (!verdict.ok) {
    return {
      ok: false,
      status: 401,
      error:
        verdict.reason === "expired"
          ? `Signature timestamp is outside the ${DEFAULT_TOLERANCE_SECONDS / 60}-minute window.`
          : `Missing or invalid ${SIGNATURE_HEADER} header.`,
    };
  }

  let payload: unknown = {};
  if (args.rawBody.trim()) {
    try {
      payload = JSON.parse(args.rawBody);
    } catch {
      return { ok: false, status: 400, error: "Body must be JSON." };
    }
  }

  if (!workflow.enabled || workflow.status !== "active") {
    return { ok: false, status: 409, error: "Workflow is not active." };
  }

  // Replay guard: the HMAC of this exact (timestamp, body) is the receipt key.
  const receiptKey = computeSignature(secret, verdict.timestamp, args.rawBody);
  await prisma.workflowWebhookReceipt.deleteMany({
    where: { workflowId: workflow.id, receivedAt: { lt: new Date(now - 2 * DEFAULT_TOLERANCE_SECONDS * 1000) } },
  });
  let receiptId: string;
  try {
    const receipt = await prisma.workflowWebhookReceipt.create({
      data: { workflowId: workflow.id, signature: receiptKey, receivedAt: new Date(now) },
      select: { id: true },
    });
    receiptId = receipt.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, status: 409, error: "This signed request was already received." };
    }
    throw err;
  }
  await prisma.workflowWebhook.update({ where: { workflowId: workflow.id }, data: { lastReceivedAt: new Date(now) } });

  try {
    const { run, deduped } = await startWorkflowRun({
      workspaceId: workflow.project.workspaceId,
      projectId: workflow.projectId,
      workflowId: workflow.id,
      triggerKind: "webhook",
      createdBy: "webhook",
      actorUserId: null,
      triggerNodeId: workflow.nodes[0].id,
      payload,
    });
    await prisma.workflowWebhookReceipt.update({ where: { id: receiptId }, data: { runId: run.id } });
    return { ok: true, status: deduped ? 200 : 201, runId: run.id, runStatus: run.status, deduped };
  } catch (err) {
    if (err instanceof WorkflowKilledError) return { ok: false, status: 423, error: err.message };
    return { ok: false, status: 400, error: err instanceof Error ? err.message.slice(0, 200) : "Run failed" };
  }
}

/** True when the header at least parses (cheap pre-check before any DB work). */
export function signatureHeaderLooksValid(header: string | null): boolean {
  return parseSignatureHeader(header) !== null;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super(`Body exceeds ${WORKFLOW_WEBHOOK_MAX_BYTES} bytes.`);
  }
}

/** Read a request body as UTF-8, refusing anything past `max` bytes. */
export async function readCappedText(req: Request, max = WORKFLOW_WEBHOOK_MAX_BYTES): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}
