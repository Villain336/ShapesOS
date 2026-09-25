// Marketr — studio creative PDF upload (Phase 4, T2).
// POST /api/studio/creatives/[id]/upload — multipart { file } (editor)
// Validates dimensions/page count against the format track server-side,
// stores the PDF in the workspace filesystem, and stamps the creative hash.
// 25 MB cap. Ready creatives reject new PDFs — version instead.

import { prisma } from "@/lib/prisma";
import { setCreativePdf } from "@/lib/studio/creatives";
import {
  creativeErrorResponse,
  guardWorkspace,
} from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request, { params }: Params) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart")) {
      return Response.json({ error: "Expected multipart form data." }, { status: 400 });
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Missing file field." }, { status: 400 });
    }
    if (file.size === 0) return Response.json({ error: "File is empty." }, { status: 400 });
    if (file.size > MAX_BYTES) {
      return Response.json({ error: "PDF exceeds the 25 MB cap." }, { status: 413 });
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const creative = await setCreativePdf(prisma, workspace.id, id, bytes, { createdBy: user.id });
    return Response.json({ creative });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
