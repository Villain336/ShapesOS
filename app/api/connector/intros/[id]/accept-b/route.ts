// Marketr — Connector Agent slice 4 API.
// POST /api/connector/intros/[id]/accept-b — see ../action-handlers.ts.
import { handleAcceptB } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleAcceptB(req, id);
}
