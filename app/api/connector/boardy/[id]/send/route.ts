// Marketr — Connector Agent slice 6 API.
// POST /api/connector/boardy/[id]/send — send the approved request (approval gate: not_approved unless approved).
import { handleBoardySend } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBoardySend(req, id);
}
