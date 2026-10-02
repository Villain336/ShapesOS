// Marketr — Connector Agent slice 4 API.
// POST /api/connector/intros/[id]/accept-a — see ../action-handlers.ts.
import { handleAcceptA } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleAcceptA(req, id);
}
