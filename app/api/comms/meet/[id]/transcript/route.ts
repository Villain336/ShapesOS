// ShapesOS — Phase 18.2 (WS=comms): a meeting's transcript (post-call).
//   POST /api/comms/meet/[id]/transcript
//        application/json { text }              → pasted transcript
//        multipart/form-data file=<recording>    → transcribed by Whisper (≤ 25 MB;
//                                                   409 when no transcription key is set)
//   → { meeting }   (editor+)

import type { NextRequest } from "next/server";
import { errorResponse, HttpError } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { MAX_RECORDING_BYTES, MAX_TRANSCRIPT_CHARS } from "@/lib/comms/meet/model";
import { saveTranscript, transcribeRecording } from "@/lib/comms/meet/meet.server";
import { idParam, meetGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ text: z.string().min(1).max(MAX_TRANSCRIPT_CHARS) }).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await meetGuard();
    const id = idParam((await params).id);
    const type = req.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > MAX_RECORDING_BYTES + 64 * 1024) throw new HttpError(413, "Recordings are at most 25 MB.");
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Attach the recording.");
      const audio = Buffer.from(await file.arrayBuffer());
      return Response.json({ meeting: await transcribeRecording(ctx, id, { audio, fileName: file.name || "recording.mp3", mimeType: file.type || "audio/mpeg" }) });
    }
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ meeting: await saveTranscript(ctx, id, { text: parsed.data.text, source: "pasted" }) });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/meet/[id]/transcript");
  }
}
