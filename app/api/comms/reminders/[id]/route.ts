// ShapesOS — Phase 18.2 (WS=comms): one of your reminders.
//   PATCH  /api/comms/reminders/[id] { title?, notes?, dueAt?, repeat?, done? } → { reminder }
//   DELETE /api/comms/reminders/[id] → 204
// Viewer+, and only your own (another member's id answers 404). Completing a
// repeating reminder rolls it to its next occurrence in your time zone.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { removeReminder, REMINDER_NOTES_MAX, REMINDER_TITLE_MAX, REPEAT_RULES, updateReminder } from "@/lib/comms/reminders";
import { commsGuard, memberTimeZone } from "../../_lib";

export const dynamic = "force-dynamic";

const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(REMINDER_TITLE_MAX).optional(),
    notes: z.string().max(REMINDER_NOTES_MAX).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    repeat: z.enum(REPEAT_RULES).nullable().optional(),
    done: z.boolean().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await commsGuard("viewer");
    const { id } = await params;
    const parsed = validateBody(PatchSchema, await req.json());
    if (!parsed.ok) return parsed.error;
    const b = parsed.data;
    const timeZone = await memberTimeZone(ctx.userId);
    const reminder = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      updateReminder(tx, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        id: String(id).slice(0, 64),
        timeZone,
        patch: {
          title: b.title,
          notes: b.notes,
          dueAt: b.dueAt === undefined ? undefined : b.dueAt === null ? null : new Date(b.dueAt),
          repeat: b.repeat,
          done: b.done,
        },
      }),
    );
    return Response.json({ reminder });
  } catch (err) {
    return errorResponse(err, "PATCH /api/comms/reminders/[id]");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await commsGuard("viewer");
    const { id } = await params;
    await withWorkspaceScope(ctx.workspaceId, (tx) =>
      removeReminder(tx, { workspaceId: ctx.workspaceId, userId: ctx.userId, id: String(id).slice(0, 64) }),
    );
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "DELETE /api/comms/reminders/[id]");
  }
}
