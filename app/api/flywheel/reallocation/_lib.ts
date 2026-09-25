// Marketr — /api/flywheel/reallocation shared guard (not a route: no HTTP exports).
//
// Mirrors app/api/authority/_lib.ts: signed-in user → their workspace,
// mutations require editor+. SRA lifecycle (create/revoke), proposal
// approval, execution, and breaker acknowledgment additionally require the
// workspace owner/admin role — money envelopes are never signed by editors.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createPrismaReallocationStore, type ReallocationStore } from "@/lib/flywheel/reallocation/store";

export interface FlywheelGuard {
  userId: string;
  workspaceId: string;
  role: string;
  isOwner: boolean;
}

export async function flywheelGuard(min: "viewer" | "editor" = "viewer"): Promise<FlywheelGuard | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min === "editor" && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return forbidden();
  }
  const membership = await getMembership(user.id, workspace.id);
  const role = membership?.role ?? "viewer";
  return { userId: user.id, workspaceId: workspace.id, role, isOwner: role === "owner" || role === "admin" };
}

/** Money-envelope actions require owner/admin. */
export function requireOwner(gate: FlywheelGuard) {
  if (!gate.isOwner) {
    return Response.json(
      { error: "This action requires the workspace owner or admin role. Money envelopes are never signed by editors." },
      { status: 403 },
    );
  }
  return null;
}

export function badRequest(message: string, issues?: unknown) {
  return Response.json({ error: message, ...(issues ? { issues } : {}) }, { status: 400 });
}

export function safetyError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const status = /not found/i.test(message) ? 404 : 422;
  return Response.json({ error: message }, { status });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    return (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/** The F1 tables exist only after the coordinator merges the fragment + migrates. */
export async function reallocationTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM reallocation_proposals LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

export function tablesNotReady() {
  return Response.json(
    { error: "Reallocation tables not provisioned yet (fragment not merged/migrated)." },
    { status: 503 },
  );
}

export function getStore(): ReallocationStore {
  return createPrismaReallocationStore(prisma);
}

/**
 * Server secret for SRA signing/verification. Missing = fail closed:
 * no SRA can be created or verified without it (timeout means no).
 */
export function sraSecret(): string | undefined {
  return process.env.SRA_SIGNING_SECRET || undefined;
}

export function requireSraSecret(): string | Response {
  const s = sraSecret();
  if (!s) {
    return Response.json(
      { error: "SRA_SIGNING_SECRET is not configured — SRA operations are disabled (fail-closed)." },
      { status: 503 },
    );
  }
  return s;
}

/**
 * Live revocation check, pre-fetched per request and closed over synchronously
 * (the policy engine's interface is sync). Freshness = per request/decision —
 * the checkout path re-reads the SRA row itself before executing, so a
 * revocation landing between policy check and checkout is still caught.
 */
export async function revocationChecker(store: ReallocationStore, workspaceId: string) {
  const sras = await store.listSras(workspaceId);
  const revoked = new Set(sras.filter((s) => s.status === "revoked").map((s) => s.revocationId));
  const known = new Set(sras.map((s) => s.revocationId));
  return {
    /** Unknown revocation ids = deny (timeout means no). */
    check: (revocationId: string): boolean => !known.has(revocationId) || revoked.has(revocationId),
  };
}

export async function isRevokedLive(store: ReallocationStore, workspaceId: string, revocationId: string): Promise<boolean> {
  const { check } = await revocationChecker(store, workspaceId);
  return check(revocationId);
}
