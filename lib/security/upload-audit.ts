// Marketr — audit helper for rejected uploads (Phase A, fix 5).
// Denials are never silent: every rejected upload writes a `file_rejected`
// audit row, mirroring the M21 `connector_tool_denied` philosophy.

import { auditEvent } from "@/lib/auditlog";
import { getMalwareScanner, type MalwareScanResult } from "./malware-scan";

export async function auditUploadRejected(opts: {
  projectId: string | null;
  workspaceId: string;
  filename: string;
  reason: string;
  actorUserId?: string;
}): Promise<void> {
  await auditEvent({
    projectId: opts.projectId,
    workspaceId: opts.workspaceId,
    action: "file_rejected",
    summary: `Rejected upload "${opts.filename.slice(0, 120)}": ${opts.reason}`,
    actorUserId: opts.actorUserId,
  });
}

export type ScreenResult =
  | { ok: true }
  | { ok: false; status: 400 | 503; reason: string };

/**
 * Run the configured malware scanner over an already-validated buffer.
 * Fail-closed: a scanner infrastructure failure rejects the upload (503)
 * rather than waving it through.
 */
export async function screenUploadBuffer(buf: Buffer): Promise<ScreenResult> {
  let scan: MalwareScanResult;
  try {
    scan = await getMalwareScanner().scanBuffer(buf);
  } catch {
    return {
      ok: false,
      status: 503,
      reason:
        "The malware scanner is unavailable, so the upload was rejected. Please try again shortly.",
    };
  }
  if (!scan.clean) {
    return {
      ok: false,
      status: 400,
      reason: `This file failed the malware scan${scan.signature ? ` (${scan.signature})` : ""} and was rejected.`,
    };
  }
  return { ok: true };
}
