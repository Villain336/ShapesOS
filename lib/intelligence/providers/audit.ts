// Marketr — Phase 10 M6: audit wrapper for data-provider calls.
// Spec §4.6: every external API call is metered AND audit-logged.
// Semantic audit actions follow the lib/enrichment/waterfall.ts precedent:
// the intent names are written with a cast so no code changes are needed once
// the schema coordinator adds them to the FileChangeAction enum — until then
// auditEvent() no-ops on them (its catch swallows the invalid-enum error).

import { auditEvent } from "@/lib/auditlog";
import type { FileChangeAction } from "@prisma/client";

const AUDIT = {
  serpVendorCalled: "serp_vendor_called",
  volumeLookup: "volume_lookup",
  linkVerified: "link_verified",
  vendorSwitched: "serp_vendor_switched",
} as const;

function auditAction(name: string): FileChangeAction {
  return name as FileChangeAction;
}

export function auditApiCall(
  workspaceId: string,
  action: keyof typeof AUDIT,
  summary: string,
): Promise<void> {
  return auditEvent({
    projectId: null,
    workspaceId,
    action: auditAction(AUDIT[action]),
    summary,
    actor: "ai",
  });
}
