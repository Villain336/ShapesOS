// ShapesOS — Phase 18.2 (WS=comms): who can be messaged or mentioned here.
//   GET /api/comms/messages/people → { people: [{ key, userId, label, email }], agents: [{ key, agentKey, label }], targets }

import { errorResponse } from "@/lib/api/errors";
import { buildMentionTargets, userKey, agentMemberKey } from "@/lib/comms/messages/model";
import { workspaceAgents, workspaceMembers } from "@/lib/comms/messages/store.server";
import { messagesGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await messagesGuard();
    const members = await workspaceMembers(ctx.workspaceId);
    const agents = workspaceAgents();
    return Response.json({
      me: userKey(ctx.userId),
      people: members.map((m) => ({ key: userKey(m.userId), userId: m.userId, label: (m.name ?? "").trim() || (m.email ? m.email.split("@")[0] : "Member"), email: m.email })),
      agents: agents.map((a) => ({ key: agentMemberKey(a.key), agentKey: a.key, label: a.name })),
      targets: buildMentionTargets(members, agents),
    });
  } catch (err) {
    return errorResponse(err, "GET /api/comms/messages/people");
  }
}
