// Marketr — Connector Agent slice 6 API.
// POST /api/connector/boardy/[id]/cancel — cancel a draft or approved request.
import { handleBoardyCancel } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBoardyCancel(req, id);
}
