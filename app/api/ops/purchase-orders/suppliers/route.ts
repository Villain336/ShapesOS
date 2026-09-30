// Marketr — Phase 17 slice 3: POST /api/ops/purchase-orders/suppliers.
// Resolves supplierIds (CRM lead ids) to display names for the PO UI.
// Read-only — viewer+. Mirrors /api/ops/invoices/customers.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { resolveCustomerNames } from "@/lib/ops/invoices";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  let body: { ids?: unknown };
  try {
    body = (await req.json()) as { ids?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
  try {
    const suppliers = await withWorkspaceScope(workspace.id, (tx) =>
      resolveCustomerNames(tx, workspace.id, ids),
    );
    return Response.json({ suppliers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
