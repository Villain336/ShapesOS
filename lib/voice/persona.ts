// Marketr — Phase 13D Worker A: agent persona prompt builder.
//
// The agent sells like the company: persona prompts are assembled from the
// 13B company intelligence layer — hard style rules (verbatim, fail-closed),
// brand voice, and company knowledge (products, objection handling, FAQs).
// This is what makes a follow-up agent a *Marketr* agent rather than a
// generic callbot.

import type { CompanyKnowledge } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  loadActiveStyleRules,
  renderStyleRulesSection,
} from "../intelligence/company/style-check";
import {
  getVoiceProfile,
  renderVoiceSection,
  type VoiceDimensions,
} from "../intelligence/company/voice";
import type { AgentConfig } from "./agents";

export interface PersonaInput {
  agentName: string;
  companyName: string;
  /** The approved script body — the opening is the AI disclosure. */
  opening?: string;
  config?: AgentConfig;
}

export interface PersonaContext {
  styleRules: string;
  brandVoice: string;
  knowledge: string;
  dimensions: VoiceDimensions | null;
}

async function loadCompanyKnowledge(
  workspaceId: string,
): Promise<CompanyKnowledge[]> {
  try {
    return await withWorkspaceScope(workspaceId, (tx) =>
      tx.companyKnowledge.findMany({
        where: { workspaceId },
        orderBy: [{ kind: "asc" }, { updatedAt: "desc" }],
        take: 60,
      }),
    );
  } catch {
    return [];
  }
}

/** Pure, DB-free: render knowledge entries into a prompt section. */
export function renderKnowledgeSection(entries: CompanyKnowledge[]): string {
  if (entries.length === 0) return "";
  const lines = ["## COMPANY KNOWLEDGE — sell like the company"];
  for (const e of entries) {
    const body =
      typeof e.body === "object" && e.body !== null
        ? JSON.stringify(e.body).slice(0, 600)
        : String(e.body ?? "");
    lines.push(`- [${e.kind}] ${e.title}: ${body}`);
  }
  return lines.join("\n");
}

export async function loadPersonaContext(
  workspaceId: string,
): Promise<PersonaContext> {
  const [rules, profile, knowledge] = await Promise.all([
    loadActiveStyleRules(workspaceId).catch(() => []),
    getVoiceProfile(workspaceId).catch(() => null),
    loadCompanyKnowledge(workspaceId),
  ]);
  const dimensions = (profile?.dimensions as unknown as VoiceDimensions | null) ?? null;
  return {
    styleRules: renderStyleRulesSection(rules),
    brandVoice: renderVoiceSection(dimensions),
    knowledge: renderKnowledgeSection(knowledge),
    dimensions,
  };
}

/**
 * Assemble the system prompt for a LiveKit follow-up agent. Layer order
 * mirrors the 13B prompt-context contract: hard constraints first, then
 * voice, then knowledge. Call-compliance guardrails are hard-coded — they
 * are never derived from learned content and cannot be overridden by it.
 */
export function buildAgentPersona(
  input: PersonaInput,
  ctx: PersonaContext,
): string {
  const hours = input.config?.hours;
  const escalation = input.config?.escalationRules ?? [];
  const lines: string[] = [
    `# ${input.agentName} — AI follow-up agent${input.companyName ? ` for ${input.companyName}` : ""}`,
    "",
    "You are an AI sales development representative making a follow-up call to a prospect",
    "who has previously opted in to be contacted. You qualify the prospect, handle",
    "objections in the company's own voice, and book a meeting.",
    "",
    "## CALL COMPLIANCE — non-negotiable, overrides everything below",
    "- You MUST open every call with the AI disclosure, verbatim: the opening line below.",
    "- Never claim to be human. If asked, say plainly: \"I'm an AI assistant.\"",
    "- Respect any request to stop, be removed, or not be called again — end the call gracefully.",
    "- Never promise what the company cannot deliver; never invent prices, dates, or features.",
    escalation.length > 0
      ? `- Get a human when: ${escalation.join("; ")}.`
      : "- When you are unsure or the prospect is upset, offer to have a human follow up.",
    hours
      ? `- Call hours: ${[hours.days?.join(", "), hours.start && hours.end ? `${hours.start}–${hours.end}` : "", hours.timezone].filter(Boolean).join(" ") || "not set"}.`
      : "",
    "",
  ];
  if (input.opening) {
    lines.push("## OPENING LINE (read verbatim at call start)", input.opening, "");
  }
  if (ctx.styleRules) lines.push(ctx.styleRules, "");
  if (ctx.brandVoice) lines.push(ctx.brandVoice, "");
  if (ctx.knowledge) lines.push(ctx.knowledge, "");
  if (ctx.dimensions?.dontExamples?.length) {
    lines.push(
      "## STYLE DON'TS",
      ...ctx.dimensions.dontExamples.map((d) => `- ${d}`),
      "",
    );
  }
  lines.push(
    "## CONVERSATION SHAPE",
    "1. Confirm you are speaking with the right person.",
    "2. Qualify: one question at a time, listen before pitching.",
    "3. Handle objections using the company's objection knowledge.",
    "4. Close on a meeting: propose two specific times, confirm, then summarize.",
    "Keep turns short — this is a phone call, not an essay.",
  );
  return lines.filter((l) => l !== null).join("\n");
}

/** One-shot: load context + build the persona for an agent. */
export async function buildAgentPersonaForWorkspace(
  workspaceId: string,
  input: PersonaInput,
): Promise<string> {
  const ctx = await loadPersonaContext(workspaceId);
  return buildAgentPersona(input, ctx);
}
