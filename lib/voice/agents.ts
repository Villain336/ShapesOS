// Marketr — Phase 13D Worker A: VoiceAgent CRUD + kill switch.
//
// A VoiceAgent is the container for a lead follow-up (or voiceover) agent
// config. The kill switch is load-bearing: when killSwitch=true the agent
// refuses ALL new sessions (lib/voice/sessions.ts gate (a)). Every write is
// tenant-scoped via withWorkspaceScope; RLS policies on voice_agents enforce
// it at the DB level too.

import { Prisma, type VoiceAgent, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

type TxClient = Prisma.TransactionClient | PrismaClient;

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export interface AgentConfig {
  hours?: { days?: string[]; start?: string; end?: string; timezone?: string };
  escalationRules?: string[];
  consentListRefs?: string[];
  maxAttemptsPerLead?: number;
  language?: string;
}

export interface CreateAgentInput {
  name: string;
  purpose?: "followup" | "voiceover";
  voiceId: string;
  voiceBackend?: "voicestudio" | "byo_provider";
  config?: AgentConfig;
}

export type AgentListItem = Pick<
  VoiceAgent,
  "id" | "name" | "purpose" | "voiceId" | "killSwitch" | "status" | "createdAt"
> & { _count: { sessions: number; scripts: number } };

/** Pure, DB-free: is this agent barred from starting new sessions? */
export function isAgentLiveBlocked(agent: Pick<VoiceAgent, "killSwitch" | "status">): {
  blocked: boolean;
  reason?: string;
} {
  if (agent.killSwitch)
    return { blocked: true, reason: "kill_switch_on" };
  if (agent.status === "archived")
    return { blocked: true, reason: "agent_archived" };
  if (agent.status === "paused")
    return { blocked: true, reason: "agent_paused" };
  return { blocked: false };
}

export async function listAgents(workspaceId: string): Promise<AgentListItem[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        purpose: true,
        voiceId: true,
        killSwitch: true,
        status: true,
        createdAt: true,
        _count: { select: { sessions: true, scripts: true } },
      },
    }),
  );
}

export async function getAgent(
  workspaceId: string,
  agentId: string,
): Promise<VoiceAgent | null> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.findFirst({ where: { id: agentId, workspaceId } }),
  );
}

export async function createAgent(
  workspaceId: string,
  input: CreateAgentInput,
): Promise<VoiceAgent> {
  const name = input.name.trim();
  if (!name) throw new Error("Agent name is required.");
  if (!input.voiceId.trim()) throw new Error("voiceId is required.");
  const purpose = input.purpose ?? "followup";
  if (purpose !== "followup" && purpose !== "voiceover")
    throw new Error("purpose must be followup or voiceover.");
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.create({
      data: {
        workspaceId,
        name,
        purpose,
        voiceId: input.voiceId.trim(),
        voiceBackend: input.voiceBackend ?? "voicestudio",
        config: json(input.config ?? {}),
      },
    }),
  );
}

export async function updateAgent(
  workspaceId: string,
  agentId: string,
  patch: Partial<Pick<VoiceAgent, "name" | "voiceId" | "voiceBackend" | "status">> & {
    config?: AgentConfig;
  },
): Promise<VoiceAgent> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.update({
      where: { id: agentId, workspaceId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.voiceId !== undefined ? { voiceId: patch.voiceId.trim() } : {}),
        ...(patch.voiceBackend !== undefined ? { voiceBackend: patch.voiceBackend } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.config !== undefined ? { config: json(patch.config) } : {}),
      },
    }),
  );
}

/**
 * Toggle the workspace kill switch for one agent. When enabled, the agent
 * refuses all new sessions immediately. The toggle itself is recorded in the
 * returned row; session refusals are logged on the session audit trail.
 */
export async function setKillSwitch(
  workspaceId: string,
  agentId: string,
  enabled: boolean,
  actorUserId?: string,
): Promise<VoiceAgent> {
  const agent = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.update({
      where: { id: agentId, workspaceId },
      data: { killSwitch: enabled },
    }),
  );
  // eslint-disable-next-line no-console
  console.log(
    `[voice] kill-switch ${enabled ? "ENGAGED" : "RELEASED"} agent=${agentId} ws=${workspaceId} actor=${actorUserId ?? "system"}`,
  );
  return agent;
}

export async function deleteAgent(
  workspaceId: string,
  agentId: string,
): Promise<void> {
  // RESTRICT on call_sessions: deleting an agent with session history throws.
  await withWorkspaceScope(workspaceId, (tx: TxClient) =>
    tx.voiceAgent.delete({ where: { id: agentId, workspaceId } }),
  );
}

/** Raw prisma export for scripts/seeds that already manage their own scope. */
export { prisma as voicePrisma };
