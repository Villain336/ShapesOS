// Marketr — Connector Agent slice 4 API.
// POST /api/connector/intros/[id]/decline-a — see ../action-handlers.ts.
import { handleDeclineA } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleDeclineA(req, id);
}
