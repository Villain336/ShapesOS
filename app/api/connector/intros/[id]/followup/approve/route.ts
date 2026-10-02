// Marketr — Connector Agent slice 4 API.
// POST /api/connector/intros/[id]/followup/approve — tenant approves the
// followup draft; it sends and the intro moves to followed_up.
import { handleFollowupApprove } from "../../../action-handlers";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleFollowupApprove(req, id);
}
