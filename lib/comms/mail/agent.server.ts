// ShapesOS — Phase 18.2 (WS=comms): the inbox agent.
//
//   summarizeThread  a short summary + suggested labels for one thread (the
//                    workspace's background model, metered like every model
//                    call; stored on the cached Gmail / Outlook thread — a
//                    derived summary, never the bodies). Labels are only
//                    SUGGESTED: a person accepts them.
//   draftReply       a drafted reply saved as a MailDraft (origin "agent") —
//                    drafts only; sending is a person's click, or an agent's
//                    mail_send that goes through the tier gate.
//   startTriage      bulk triage as a delegated agent run: a Drafter task
//                    (email + workspace tools only) that reads the inbox,
//                    summarizes, suggests labels and drafts replies; it runs on
//                    the agent worker and is watched / stopped on its run page.
//
// When no live model is configured the provider answers from its mock path:
// the result is flagged mock and says so — never presented as a real summary.

import { HttpError } from "@/lib/api/errors";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { readMailThread, type MailCtx } from "./mailbox.server";
import { normalizeTag, parseThreadKey } from "./types";

export const STANDARD_TAGS = ["needs reply", "waiting", "fyi", "meeting", "sales", "support", "billing", "newsletter"] as const;

function transcript(messages: { from: { name: string | null; address: string | null }; at: string; body: string; direction: string }[], maxChars = 8000): string {
  const lines: string[] = [];
  for (const m of messages.slice(-12)) {
    const who = m.direction === "outbound" ? "Me" : (m.from.name ?? m.from.address ?? "Them");
    lines.push(`[${m.at.slice(0, 16)}] ${who}:\n${m.body.replace(/\n{3,}/g, "\n\n").slice(0, 2000)}`);
  }
  const text = lines.join("\n\n");
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/** {"summary": "...", "labels": ["..."]} from a model's text (tolerates fences / prose). PURE. */
export function parseSummaryJson(raw: string): { summary: string; labels: string[] } | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { summary?: unknown; labels?: unknown };
    const summary = typeof j.summary === "string" ? j.summary.trim().slice(0, 1200) : "";
    const labels = Array.isArray(j.labels) ? j.labels.map(normalizeTag).filter((x): x is string => !!x).slice(0, 4) : [];
    return summary ? { summary, labels: [...new Set(labels)] } : null;
  } catch {
    return null;
  }
}

async function model(ctx: MailCtx, workload: "background" | "copy") {
  const { getLlmProviderForWorkspace } = await import("@/lib/llm/workspace");
  return getLlmProviderForWorkspace(workload, { workspaceId: ctx.workspaceId, actorId: ctx.userId });
}

export async function summarizeThread(ctx: MailCtx, key: string): Promise<{ summary: string; suggestedTags: string[]; mock: boolean }> {
  const detail = await readMailThread(ctx, key);
  if (!detail.messages.length) throw new HttpError(400, "This thread has no messages to summarize.");
  const llm = await model(ctx, "background");
  const prompt = [
    "Summarize this conversation for the person who owns the inbox. Use ONLY the messages below; never invent facts.",
    "Respond with ONLY a JSON object: {\"summary\": \"2-3 plain sentences: what it is about, what is asked of me, any date or amount\", \"labels\": [\"1 to 3 labels\"]}.",
    `Prefer these labels when they fit: ${STANDARD_TAGS.join(", ")}.`,
    "",
    `Subject: ${detail.thread.subject}`,
    transcript(detail.messages),
  ].join("\n");
  const raw = await llm.generate(prompt, { maxTokens: 400 });
  const parsed = parseSummaryJson(raw) ?? { summary: raw.trim().slice(0, 1200), labels: [] };
  const mock = !llm.isLive;
  const ref = parseThreadKey(key);
  if (!mock && ref && (ref.source === "gmail" || ref.source === "outlook") && !detail.thread.mock) {
    await withWorkspaceScope(ctx.workspaceId, (tx) =>
      tx.mailThreadCache.updateMany({
        where: { workspaceId: ctx.workspaceId, ownerUserId: ctx.userId, connectionId: ref.connectionId, externalId: ref.externalId },
        data: { summary: parsed.summary, summarizedAt: new Date(), suggestedTags: parsed.labels },
      }),
    );
  }
  return { summary: parsed.summary, suggestedTags: parsed.labels, mock };
}

export interface DraftView {
  id: string;
  threadKey: string | null;
  source: string;
  connectionId: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  body: string;
  origin: string;
  agentKey: string | null;
  status: string;
  replyToMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function draftView(d: {
  id: string;
  threadKey: string | null;
  source: string;
  connectionId: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  body: string;
  origin: string;
  agentKey: string | null;
  status: string;
  replyToMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DraftView {
  return { ...d, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString() };
}

/** The inbox agent drafts a reply to a thread (saved as a draft — nothing is sent). */
export async function draftReply(
  ctx: MailCtx,
  key: string,
  opts: { instructions?: string | null; agentKey?: string | null; runId?: string | null } = {},
): Promise<{ draft: DraftView; mock: boolean }> {
  const detail = await readMailThread(ctx, key);
  const llm = await model(ctx, "copy");
  const prompt = [
    "Draft a reply for the inbox owner to send. Use ONLY facts in the conversation; never promise prices, dates or commitments that are not there — leave a [bracketed placeholder] instead.",
    "Plain text, ready to send, no subject line, no markdown. Match the language of the last message. Keep it short and friendly.",
    detail.thread.source === "crm" && detail.messages[detail.messages.length - 1]?.channel === "sms" ? "This is an SMS: at most 300 characters." : "",
    opts.instructions ? `The owner asked: ${opts.instructions.slice(0, 500)}` : "",
    "",
    `Subject: ${detail.thread.subject}`,
    transcript(detail.messages),
  ]
    .filter(Boolean)
    .join("\n");
  const body = (await llm.generate(prompt, { maxTokens: 700 })).trim().slice(0, 20_000);
  const mock = !llm.isLive;
  const subject = detail.reply.subject ? (/^re:/i.test(detail.reply.subject) ? detail.reply.subject : `Re: ${detail.reply.subject}`) : null;
  const row = await withWorkspaceScope(ctx.workspaceId, (tx) =>
    tx.mailDraft.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        source: detail.reply.source,
        connectionId: detail.reply.connectionId ?? null,
        threadKey: key,
        replyToMessageId: detail.reply.replyToMessageId ?? null,
        to: detail.reply.to.join(", ") || null,
        subject,
        body: mock ? `${body}\n\n(MOCK — no model is configured; this sample was not written by an AI model.)` : body,
        origin: "agent",
        agentKey: opts.agentKey ?? "drafter",
        runId: opts.runId ?? null,
        status: "draft",
      },
    }),
  );
  return { draft: draftView(row), mock };
}

export const TRIAGE_PROMPT = [
  "Triage my inbox.",
  "1. Call mail_list_threads (folder inbox, unread first) to see what is waiting.",
  "2. For each of the most recent unread threads (at most 10), call mail_read_thread, then mail_label_thread with a one-paragraph summary and 1-3 suggested labels.",
  "3. For threads that need a reply from me, call mail_draft_reply. Drafts only: never send anything.",
  "4. Finish with a short list: what needs me today, what can wait, which drafts are ready to review in Mail.",
].join("\n");

/** Bulk triage as a delegated agent run (Drafter: workspace + email tools; drafts only). */
export async function startTriage(ctx: MailCtx): Promise<{ runId: string; threadId: string; projectId: string }> {
  const { prisma } = await import("@/lib/prisma");
  const project = await prisma.project.findFirst({ where: { workspaceId: ctx.workspaceId }, orderBy: { updatedAt: "desc" }, select: { id: true } });
  if (!project) throw new HttpError(409, "Agents work inside a project. Add a project first.");
  const thread = await prisma.aiChatThread.create({
    data: { projectId: project.id, userId: ctx.userId, title: "Inbox triage", agentKey: "drafter", allowedTools: ["workspace", "email"] },
    select: { id: true },
  });
  await prisma.aiChatMessage.create({ data: { threadId: thread.id, role: "user", content: TRIAGE_PROMPT } });
  const { runTrackedAgentTurn } = await import("@/lib/chat/agent");
  const out = await runTrackedAgentTurn(
    { projectId: project.id, workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role, threadId: thread.id, userContent: TRIAGE_PROMPT },
    // The default budget: runs inline briefly, then hands off to the agent
    // worker at a step boundary (AGENT_WORKER=off: inline); the run page streams it.
    {},
  );
  return { runId: out.runId, threadId: thread.id, projectId: project.id };
}
