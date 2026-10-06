// ShapesOS — Phase 18.1 (WS=desk): the caller's desk preferences (voice, shortcuts).
//   GET   /api/desk/prefs → { shortcuts, voice }
//   PATCH /api/desk/prefs { voice: { enabled } }
//   PATCH /api/desk/prefs { shortcut: { id, combo | null } }   (null = back to the default)
//     A rebinding that clashes with another live shortcut, takes a browser
//     combo or a bare navigation key is refused with 400 and the reason
//     (lib/keyboard/shortcuts.ts rebind); nothing is stored.
// viewer+; the caller's own preferences, stored in UserPreference
// (lib/preferences) through the desk adapter lib/desktop/prefs.ts.

import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { DeskPreferenceError, getUserPreferences, setUserPreference } from "@/lib/desktop/prefs";
import { rebind, sanitizeOverrides, toStoredBinding } from "@/lib/keyboard/shortcuts";
import { deskGuard, NO_STORE } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const prefs = await getUserPreferences(ctx.userId);
    return Response.json({ shortcuts: prefs.shortcuts, voice: prefs.voice }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, "GET /api/desk/prefs");
  }
}

const PatchSchema = z.union([
  z.object({ voice: z.object({ enabled: z.boolean() }) }),
  z.object({ shortcut: z.object({ id: z.string().max(64), combo: z.string().max(40).nullable() }) }),
]);

export async function PATCH(req: Request) {
  const ctx = await deskGuard("viewer");
  if (ctx instanceof Response) return ctx;
  try {
    const body = validateBody(PatchSchema, await req.json());
    if (!body.ok) return body.error;
    if ("voice" in body.data) {
      const prefs = await setUserPreference(ctx.userId, "voice", body.data.voice);
      return Response.json({ shortcuts: prefs.shortcuts, voice: prefs.voice }, { headers: NO_STORE });
    }
    const current = sanitizeOverrides((await getUserPreferences(ctx.userId)).shortcuts);
    const r = rebind(current, body.data.shortcut.id, body.data.shortcut.combo);
    // code + values let the cheat-sheet say why in the person's language.
    if (!r.ok) return Response.json({ error: r.error, code: r.code, values: r.values ?? {} }, { status: 400 });
    const stored = Object.fromEntries(Object.entries(r.overrides).map(([id, c]) => [id, toStoredBinding(c)]));
    const prefs = await setUserPreference(ctx.userId, "shortcuts", stored);
    return Response.json({ shortcuts: prefs.shortcuts, voice: prefs.voice }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof DeskPreferenceError) return Response.json({ error: err.message }, { status: 400 });
    return errorResponse(err, "PATCH /api/desk/prefs");
  }
}
