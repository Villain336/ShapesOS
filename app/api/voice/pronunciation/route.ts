// Marketr — Phase 13D Worker B: pronunciation dictionary API.
// GET    /api/voice/pronunciation            → entry list
// POST   /api/voice/pronunciation            → { action:"seed" } seeds from
//                                             the 13B knowledge graph, else
//                                             { term, phonetic } upserts
// PUT    /api/voice/pronunciation            → { id, phonetic } re-spell
// DELETE /api/voice/pronunciation?id=…       → remove an entry

import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  listEntries,
  upsertEntry,
  deleteEntry,
  seedFromKnowledgeGraph,
} from "@/lib/voice/pronunciation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const entries = await listEntries(workspace.id);
    return Response.json({ entries });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      action?: unknown;
      term?: unknown;
      phonetic?: unknown;
    };
    if (body.action === "seed") {
      const result = await seedFromKnowledgeGraph(workspace.id);
      const entries = await listEntries(workspace.id);
      return Response.json({ seeded: result, entries });
    }
    if (typeof body.term !== "string" || typeof body.phonetic !== "string") {
      return Response.json(
        { error: "term and phonetic are required." },
        { status: 400 },
      );
    }
    const entry = await upsertEntry(workspace.id, {
      term: body.term,
      phonetic: body.phonetic,
      source: "manual",
    });
    return Response.json({ entry }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PUT(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      id?: unknown;
      term?: unknown;
      phonetic?: unknown;
    };
    if (typeof body.term !== "string" || typeof body.phonetic !== "string") {
      return Response.json(
        { error: "term and phonetic are required." },
        { status: 400 },
      );
    }
    const entry = await upsertEntry(workspace.id, {
      term: body.term,
      phonetic: body.phonetic,
      source: "manual",
    });
    void body.id;
    return Response.json({ entry });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return Response.json({ error: "id is required." }, { status: 400 });
    await deleteEntry(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
