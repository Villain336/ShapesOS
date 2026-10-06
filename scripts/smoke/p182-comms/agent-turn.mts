// ShapesOS — Phase 18.2 (WS=comms) browser-smoke helper (scripts/smoke/p182-comms). Not part of the app.
// Phase 18.2 (WS=comms) browser smoke helper — an agent proposal in a channel.
// There is no live model in the smoke (the mock LLM only ever answers with a
// labelled text block, never a tool call), so this helper plays ONE turn of
// the Scheduler with a STUB model: it posts "@Scheduler remind me …" in the
// channel as the admin through the real posting path (mentions, membership,
// notifications), then runs the real channel_agent job body
// (runChannelAgent: chat-thread mapping, prompt, reply in the thread, inline
// proposal) with a runTurn stub whose proposal goes through the REAL
// executeTool gate (create_reminder → pending_confirmation, Tier 1 without a
// rule). The browser then clicks Approve: that enqueues the confirm job,
// which the dev server's local worker runs with the REAL "yes" turn.
// Usage (from the worktree): DATABASE_URL=<app role> npx tsx <this> <channel-name>
import type { ChatToolCall } from "@/lib/chat/tool-exec";
import type { ToolContext } from "@/lib/chat/tools";

const ADMIN = "admin:e2e-admin@example.com";
const name = process.argv[2] ?? "smoke-launch";

const { prisma } = await import("@/lib/prisma");
const store = await import("@/lib/comms/messages/store.server");
const agent = await import("@/lib/comms/messages/agent.server");
const ws = await prisma.workspace.findFirst({ where: { ownerUserId: ADMIN }, select: { id: true } });
if (!ws) throw new Error("no e2e workspace");
const ctx = { workspaceId: ws.id, userId: ADMIN, role: "owner" as const, name: "e2e-admin@example.com", email: "e2e-admin@example.com" };
const channel = (await store.listChannels(ctx)).find((c) => c.kind === "channel" && c.name === name);
if (!channel) throw new Error(`no channel #${name}`);
let payload: import("@/lib/comms/messages/agent.server").ChannelAgentJobPayload | null = null;
const posted = await store.postMessage(ctx, channel.id, { body: "@Scheduler remind me to send the launch deck tomorrow" }, { ...store.defaultPostDeps(), startAgent: async (p) => void (payload = p) });
if (!payload) throw new Error("the mention did not start the Scheduler");
const out = await agent.runChannelAgent(payload, {
  ...agent.defaultChannelAgentDeps,
  threadBusy: async () => null,
  isMock: async () => true,
  runTurn: async (input) => {
    const { executeTool } = await import("@/lib/chat/tool-exec");
    const tctx: ToolContext = { projectId: input.projectId, workspaceId: input.workspaceId, userId: input.userId, role: input.role, confirmed: false, agentKey: "scheduler", grant: ["workspace", "calendar", "automation"] };
    const due = new Date(Date.now() + 24 * 3_600_000);
    due.setUTCHours(15, 0, 0, 0);
    const args = { title: "Send the launch deck", dueAt: due.toISOString() };
    const call: ChatToolCall = { tool: "create_reminder", args, status: "pending_confirmation" };
    await executeTool(tctx, "create_reminder", args, call);
    await prisma.aiChatMessage.create({ data: { threadId: input.threadId, role: "assistant", content: "I can set that reminder for tomorrow at 15:00 UTC. It needs your OK.", toolCalls: [call] as unknown as object } });
    return { runId: `smoke-stub-${Date.now()}`, assistantText: "I can set that reminder for tomorrow at 15:00 UTC (stub model in the smoke). It needs your OK.", awaitingConfirmation: call.status === "pending_confirmation" };
  },
});
console.log(JSON.stringify({ messageId: posted.message.id, out }));
await prisma.$disconnect();
