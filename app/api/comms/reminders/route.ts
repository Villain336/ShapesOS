// ShapesOS — Phase 18.2 (WS=comms): the Reminders app.
//   GET  /api/comms/reminders[?done=1] → { reminders }           (viewer+, your own)
//   POST /api/comms/reminders { title, notes?, dueAt?, repeat? } → 201 { reminder }
//
// A reminder is an OpsTask with no project, assigned to you
// (lib/comms/reminders.ts). Personal: you only ever read and write your own.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { createReminder, listReminders, REMINDER_NOTES_MAX, REMINDER_TITLE_MAX, REPEAT_RULES } from "@/lib/comms/reminders";
import { commsGuard } from "../_lib";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().trim().min(1).max(REMINDER_TITLE_MAX),
  notes: z.string().max(REMINDER_NOTES_MAX).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  repeat: z.enum(REPEAT_RULES).nullable().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const includeDone = req.nextUrl.searchParams.get("done") === "1";
    const reminders = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      listReminders(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, includeDone }),
    );
    return Response.json({ reminders });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/reminders");
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await commsGuard("viewer");
    const parsed = validateBody(CreateSchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const b = parsed.data;
    const reminder = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      createReminder(tx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        title: b.title,
        notes: b.notes ?? null,
        dueAt: b.dueAt ? new Date(b.dueAt) : null,
        repeat: b.repeat ?? null,
      }),
    );
    return Response.json({ reminder }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/reminders");
  }
}
