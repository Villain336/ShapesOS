// Marketr — Connector Agent slice 4 API.
// POST /api/connector/intros/[id]/approve — see ../action-handlers.ts.
import { handleApprove } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleApprove(req, id);
}
