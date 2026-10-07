// ShapesOS — Phase 19B (WS=panel): interviews for Dress Rehearsal.
//   GET  → { interviews }                                   (viewer+)
//   POST multipart { file, interviewee? }   → 201 { interview }   upload .txt/.md/.vtt/.srt/.docx (editor+)
//   POST JSON { title, text, interviewee? } → 201                 paste
//   POST JSON { meetingId } | { noteId }    → 201                 reuse a Meet transcript / a Note
// Interviews are stored verbatim and never summarized (lib/panel).

import { errorResponse } from "@/lib/api/errors";
import { panelDeps } from "@/lib/panel/deps.server";
import { addInterview, importInterviewFile, importInterviewFromMeeting, importInterviewFromNote, listInterviews } from "@/lib/panel/service.server";
import { badBody, readJson, rehearsalGuard } from "../_lib";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function GET(req: Request) {
  try {
    const actor = await rehearsalGuard("viewer");
    if (actor instanceof Response) return actor;
    return Response.json({ interviews: await listInterviews(actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/rehearsal/interviews", req);
  }
}

export async function POST(req: Request) {
  try {
    const actor = await rehearsalGuard("editor");
    if (actor instanceof Response) return actor;
    const deps = panelDeps();
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return Response.json({ error: "Attach the interview file." }, { status: 400 });
      if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "That file is over 5 MB. Split the interview into parts." }, { status: 413 });
      const interviewee = typeof form.get("interviewee") === "string" ? String(form.get("interviewee")) : null;
      const interview = await importInterviewFile(actor, { filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), interviewee }, deps);
      return Response.json({ interview }, { status: 201 });
    }
    const body = await readJson(req, TRANSCRIPT_BODY_MAX);
    if (!body) return badBody();
    if (typeof body.meetingId === "string") return Response.json({ interview: await importInterviewFromMeeting(actor, body.meetingId, deps) }, { status: 201 });
    if (typeof body.noteId === "string") return Response.json({ interview: await importInterviewFromNote(actor, body.noteId, deps) }, { status: 201 });
    const interview = await addInterview(
      actor,
      { title: typeof body.title === "string" ? body.title : "Interview", text: typeof body.text === "string" ? body.text : "", interviewee: typeof body.interviewee === "string" ? body.interviewee : null, source: "paste" },
      deps,
    );
    return Response.json({ interview }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/rehearsal/interviews", req);
  }
}

const TRANSCRIPT_BODY_MAX = 450_000;
