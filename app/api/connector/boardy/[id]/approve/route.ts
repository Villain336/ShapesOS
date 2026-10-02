// Marketr — Connector Agent slice 6 API.
// POST /api/connector/boardy/[id]/approve — tenant approves the draft per instance (human-only).
import { handleBoardyApprove } from "../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleBoardyApprove(req, id);
}
