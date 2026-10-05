// Marketr — Calls API: reminder runner.
// POST /api/calls/reminders/run → processes due reminders (confirmations,
// 24h + 1h reminders) for ALL workspaces. Intended for a scheduler cron.
//
// Auth: Bearer token matching REMINDERS_CRON_SECRET. When that env var is
// not set (local dev), an editor+ session of any workspace is accepted so
// operators can run it manually. Mail delivery: Resend when
// RESEND_API_KEY + BOOKING_MAIL_FROM are set, otherwise the stub log port.

import { sendDueReminders } from "@/lib/calls/reminders";
import { resolveBookingMailPort } from "@/lib/calls/resendMail";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { bearerMatches } from "@/lib/security/constant-time";

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.REMINDERS_CRON_SECRET;
  const authHeader = req.headers.get("authorization") ?? "";
  if (bearerMatches(authHeader, secret)) return true; // constant-time (Phase 1)
  if (!secret) {
    // Dev fallback: any signed-in editor may run it manually.
    const user = await requireUser();
    if (!user) return false;
    const workspace = await getOrCreateWorkspace(user.id, user.email);
    return (await requireWorkspaceRole(user.id, workspace.id, "editor")) !== null;
  }
  return false;
}

export async function POST(req: Request) {
  if (!(await authorized(req))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const result = await sendDueReminders({ mail: resolveBookingMailPort() });
  return Response.json({ ...result, elapsedMs: Date.now() - started });
}
