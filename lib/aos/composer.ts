// ShapesOS — New task composer, pure parts (kit: command-and-inputs.png).
//
// The composer hands a goal to the lead agent (Strategist = the Chief
// Strategy Agent the assistant chat runs as) or straight to one of its
// sub-agents. It reuses the existing task path — an assistant chat thread
// (POST /api/chat/threads, then /messages with attachmentIds) — so every
// approval gate stays exactly where it was.
//
// Phase 5: the agent and the tool chips are real. The thread is created with
// { agentKey, tools } and the SERVER enforces them (lib/agents/grants.ts):
// the turn runs as that agent, the model only sees the granted tools, and a
// call outside them is refused. Nothing the client sends can widen a grant.

import { LEAD_AGENT, SUB_AGENTS, isSubAgentKey, type SubAgentKey } from "./agents";
import { AGENT_MAX_GROUPS, COMPOSER_TOOL_GROUPS, UNAVAILABLE_GROUPS, type ToolGroup } from "@/lib/agents/grants";

/** Same bound as the chat messages route (MAX_CONTENT). */
export const TASK_MAX_CHARS = 4000;
/** Same bounds as the attachment API (AttachmentMenu MAX_BYTES, route max 10 ids). */
export const TASK_MAX_FILES = 10;
export const TASK_MAX_FILE_BYTES = 25 * 1024 * 1024;

export type ComposerAgentKey = "lead" | SubAgentKey;

export interface ComposerAgent {
  key: ComposerAgentKey;
  name: string;
  /** "Lead agent" or the sub-agent's one-line job. */
  hint: string;
}

/** The picker: the lead first, then the sub-agents in their canonical order. */
export function composerAgents(): ComposerAgent[] {
  return [
    { key: "lead", name: LEAD_AGENT.name, hint: "Plans it and hands out the steps" },
    ...(Object.entries(SUB_AGENTS) as Array<[SubAgentKey, (typeof SUB_AGENTS)[SubAgentKey]]>).map(([key, p]) => ({
      key,
      name: p.name,
      hint: p.description.replace(/\.$/, ""),
    })),
  ];
}

export function isComposerAgentKey(v: unknown): v is ComposerAgentKey {
  return v === "lead" || isSubAgentKey(v);
}

export type ComposerToolKey = "web" | "email" | "code";

export const COMPOSER_TOOLS: ReadonlyArray<{ key: ComposerToolKey; label: string; tool: string }> = [
  { key: "web", label: "Web", tool: "Web search" },
  { key: "email", label: "Email", tool: "Email" },
  { key: "code", label: "Code", tool: "Code runner" },
];

export interface TaskDraft {
  agent: ComposerAgentKey;
  prompt: string;
  tools: readonly ComposerToolKey[];
}

/**
 * The chat message the task becomes: the prompt as typed. The agent and the
 * tools travel separately (taskThreadOptions) and are enforced server-side.
 */
export function composeTaskMessage(draft: TaskDraft): string {
  return draft.prompt.trim();
}

/** The tool group each chip grants. */
export function chipGroup(key: ComposerToolKey): ToolGroup {
  return COMPOSER_TOOL_GROUPS[key];
}

/**
 * Why a chip can't be picked for this agent (null = it can). Unavailable
 * groups (the code runner before the sandbox ships) and groups beyond the
 * agent's maximum are offered but disabled — never faked.
 */
export function chipUnavailable(agent: ComposerAgentKey, key: ComposerToolKey): string | null {
  const group = chipGroup(key);
  if (UNAVAILABLE_GROUPS.has(group)) return "Not available yet — the code runner arrives with the sandbox.";
  if (!AGENT_MAX_GROUPS[agent].includes(group)) {
    const name = agent === "lead" ? LEAD_AGENT.name : SUB_AGENTS[agent].name;
    return `${name} doesn't use this tool.`;
  }
  return null;
}

/** Thread-creation options for a task (POST /api/chat/threads). */
export function taskThreadOptions(draft: TaskDraft): { agentKey: ComposerAgentKey; tools: ToolGroup[] } {
  const tools = draft.tools.filter((k) => !chipUnavailable(draft.agent, k)).map(chipGroup);
  return { agentKey: draft.agent, tools };
}

/** Field error for the prompt, or null when it can be sent. */
export function taskPromptError(draft: TaskDraft): string | null {
  if (!draft.prompt.trim()) return "Describe the task first.";
  const over = composeTaskMessage(draft).length - TASK_MAX_CHARS;
  if (over > 0) return `Shorten the task by ${over.toLocaleString("en-US")} character${over === 1 ? "" : "s"}.`;
  return null;
}

/** Why a picked file can't be attached, or null. */
export function attachmentError(file: { name: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= TASK_MAX_FILES) return `Attach up to ${TASK_MAX_FILES} files per task.`;
  if (file.size > TASK_MAX_FILE_BYTES) return `${file.name} is over the 25 MB limit.`;
  return null;
}

/** "48 KB", "1.2 MB", "312 B". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * The project a task lands in: the one asked for when it exists, else the
 * workspace's first project (the assistant page's own default).
 */
export function pickTaskProject<T extends { id: string; createdAt: string }>(projects: readonly T[], preferred?: string | null): T | null {
  if (projects.length === 0) return null;
  const hit = preferred ? projects.find((p) => p.id === preferred) : undefined;
  if (hit) return hit;
  return [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
}
