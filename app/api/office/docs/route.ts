// Marketr — Phase 14: Office docs API (host-owned Univer snapshots).
// GET  /api/office/docs[?kind=sheet|doc|slide]
// POST /api/office/docs { kind, title, snapshot?, sourceRef?, shareState? }
//   (snapshot optional: when omitted a blank sheet/doc/slide is generated)

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import {
  createUniverDoc,
  listUniverDocs,
} from "@/lib/univer/docs";
import {
  buildDocSnapshot,
  buildSheetSnapshot,
  buildSlideSnapshot,
  isUniverDocKind,
} from "@/lib/univer/snapshots";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  kind: z.string().trim().min(1).max(16),
  title: z.string().trim().min(1).max(200),
  snapshot: z.unknown().optional(),
  sourceRef: z.string().trim().max(200).optional(),
  shareState: z.enum(["private", "workspace", "link"]).optional(),
});

function blankSnapshot(kind: "sheet" | "doc" | "slide", title: string): unknown {
  if (kind === "sheet") return buildSheetSnapshot({ title, headers: [], rows: [] });
  if (kind === "doc") return buildDocSnapshot({ title, paragraphs: [""] });
  return buildSlideSnapshot({ title, slides: [""] });
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const kindParam = new URL(req.url).searchParams.get("kind");
    const kind = kindParam && isUniverDocKind(kindParam) ? kindParam : undefined;
    const docs = await listUniverDocs(workspace.id, { kind });
    // List view strips snapshots (they can be MBs); fetch one doc for content.
    const slim = docs.map(({ snapshot: _s, ...rest }) => rest);
    return Response.json({ docs: slim });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = CreateSchema.parse(await readJson(req));
    if (!isUniverDocKind(body.kind)) {
      return Response.json({ error: `invalid kind: ${body.kind}` }, { status: 400 });
    }
    const doc = await createUniverDoc(workspace.id, {
      kind: body.kind,
      title: body.title,
      snapshot: body.snapshot ?? blankSnapshot(body.kind, body.title),
      ...(body.sourceRef ? { sourceRef: body.sourceRef } : {}),
      ...(body.shareState ? { shareState: body.shareState } : {}),
    });
    return Response.json({ doc }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
