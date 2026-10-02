// Marketr — Connector Agent slice 6 API.
// POST /api/connector/boardy/[id]/decline — tenant declines the draft (human-only).
import { handleBoardyDecline } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBoardyDecline(req, id);
}
