// Marketr — Connector Agent slice 6 API.
// POST /api/connector/boardy/[id]/reply — triage Boardy's reply as a priority thread.
import { handleBoardyReply } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBoardyReply(req, id);
}
