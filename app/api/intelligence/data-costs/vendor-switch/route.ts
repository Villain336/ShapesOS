// Marketr — Phase 10 M6: vendor-switch API (ADMIN-ONLY).
// POST /api/intelligence/data-costs/vendor-switch { vendor }
// Flips the default SERP vendor in serp_vendor_config routing rules.
// Admin-gated here — no self-serve vendor switching without approval.
// (A future iteration may route this through the Phase 9 approval executor;
// the admin gate is the approval for now.) Audit-logged either way.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { setDefaultVendor } from "@/lib/intelligence/providers/meter";
import { auditApiCall } from "@/lib/intelligence/providers/audit";
import { ALL_VENDORS } from "@/lib/intelligence/providers/routing";
import type { SerpVendorId } from "@/lib/intelligence/providers/types";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) {
    return Response.json(
      { error: "Admin role required to switch the default SERP vendor." },
      { status: 403 },
    );
  }

  let body: { vendor?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.vendor || !ALL_VENDORS.includes(body.vendor as SerpVendorId)) {
    return Response.json(
      { error: `vendor must be one of: ${ALL_VENDORS.join(", ")}` },
      { status: 400 },
    );
  }

  const vendor = body.vendor as SerpVendorId;
  await setDefaultVendor(workspace.id, vendor);
  await auditApiCall(
    workspace.id,
    "vendorSwitched",
    `Default SERP vendor switched to ${vendor} by ${user.email ?? user.id}`,
  );
  return Response.json({ ok: true, vendor });
}
