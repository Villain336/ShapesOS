// ShapesOS — Phase 21A (WS=agentweb): the answer engine wired to the platform.
//
// Resolves the workspace's providers and settings, binds the real ports to the
// pure pipeline (lib/answer/engine.ts) and stores the result:
//   - the model, over the router (lib/answer/model-port.ts), metered as llm_tokens;
//   - provider calls, metered as web_search_call (afterTheFact: the money is spent);
//   - the workspace index through Spotlight, AS THE CALLER (their role, their
//     personal records only): a viewer gets exactly what ⌘K would show them;
//   - receipts: a signed capture per cited source, chained into the audit log;
//   - the answer row (web_answers) with claims, sources, cost and cap.
// Before anything is spent the workspace's own credit cap is checked: a capped
// workspace is refused cleanly instead of getting a half answer it cannot pay for.

import { randomBytes } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { fetchPageText } from "@/lib/agentweb/page-fetch";
import { receiptSecret, recordReceipt } from "@/lib/agentweb/receipts";
import { storeCapture } from "@/lib/agentweb/captures-store";
import { getConfig } from "@/lib/agentweb/settings";
import { authorityAudit } from "@/lib/authority/db";
import { capDeniedMessage } from "@/lib/metering/wiring";
import { checkCap, meter } from "@/lib/metering/service";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { answerQuestion, type AnswerOutcome, type EngineDeps } from "./engine";
import { workspaceModelPort } from "./model-port";
import { resolveProviders } from "./providers";
import type { AnswerPayload, SearchProvider, SearchResult } from "./types";

export const QUESTION_MIN = 3;
export const QUESTION_MAX = 500;

export class AnswerError extends Error {
  constructor(
    readonly status: 400 | 402 | 403,
    message: string,
  ) {
    super(message);
  }
}

export interface RunAnswerInput {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  projectId?: string | null;
  question: string;
}

export interface RunAnswerOptions {
  env?: Record<string, string | undefined>;
  /** Test seams. */
  providers?: SearchProvider[];
  overrides?: Partial<EngineDeps>;
  now?: () => Date;
}

export interface StoredAnswer extends AnswerOutcome {
  id: string;
  status: "done" | "partial";
}

const STOP = new Set(["what", "when", "where", "which", "whom", "does", "said", "says", "about", "there", "their", "this", "that", "have", "from", "with", "into", "your", "mine", "were", "been", "being", "would", "could", "should", "please", "tell", "show", "find", "give", "last", "latest"]);

/** The few words worth looking up in the workspace index (it matches names and words, not whole questions). */
export function indexKeywords(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? [];
  return [...new Set(words.filter((w) => !STOP.has(w)))].sort((a, b) => b.length - a.length).slice(0, 3);
}

/** The workspace index as the caller, never wider: Spotlight with the caller's role and user. */
async function workspaceResults(input: RunAnswerInput, question: string): Promise<SearchResult[]> {
  const { spotlight } = await import("@/lib/search/records");
  const lists = await Promise.all(indexKeywords(question).map((k) => spotlight(input.workspaceId, input.role, k, { perKind: 3, userId: input.userId, semantic: "off" })));
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const h of lists.flatMap((l) => l.hits)) {
    const key = `${h.kind}:${h.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: h.href, title: h.title, snippet: (h.snippet ?? h.subtitle ?? h.title).replace(/[⟦⟧]/g, ""), provider: "workspace" });
    if (out.length >= 8) break;
  }
  return out;
}

export async function runAnswer(input: RunAnswerInput, opts: RunAnswerOptions = {}): Promise<StoredAnswer> {
  const question = input.question.trim().replace(/\s+/g, " ");
  if (question.length < QUESTION_MIN) throw new AnswerError(400, "Ask a question of at least a few words.");
  if (question.length > QUESTION_MAX) throw new AnswerError(400, `Keep the question under ${QUESTION_MAX} characters.`);

  const cap = await checkCap(input.workspaceId);
  if (!cap.allowed) throw new AnswerError(402, cap.trialExpired ? "Your trial has ended. Upgrade to keep asking." : capDeniedMessage(cap.used, cap.capCredits));

  const config = await getConfig(input.workspaceId);
  const resolved = opts.providers ? { providers: opts.providers, notes: [] as string[] } : resolveProviders(config.providerOrder, opts.env ?? process.env);
  const now = opts.now ?? (() => new Date());
  const answerId = `ans_${randomBytes(9).toString("hex")}`;
  const secret = receiptSecret(opts.env ?? process.env);
  // An answer may not spend more than the workspace has left, either.
  const capCredits = Math.max(1, Math.min(config.answerCapCredits, cap.hardCap ? cap.remaining : config.answerCapCredits));

  const deps: EngineDeps = {
    providers: resolved.providers,
    providerNotes: resolved.notes,
    model: await workspaceModelPort({ workspaceId: input.workspaceId, projectId: input.projectId, userId: input.userId }),
    capCredits,
    now,
    workspaceSearch: (q) => workspaceResults(input, q),
    fetchDepth: (url) => fetchPageText(url),
    async captureSource(s, id) {
      const r = await recordReceipt(
        {
          secret,
          store: (c) => storeCapture(input.workspaceId, c, { via: "search-snippet", provider: s.providers[0], answerId: id, bodyText: s.text, retentionDays: config.captureRetentionDays }),
          audit: (e) => authorityAudit.logAsync(e),
        },
        { workspaceId: input.workspaceId, actor: `user:${input.userId}`, url: s.url, html: s.text, text: s.text, fetchedAt: now(), step: { action: "answer", klass: "benign", tier: 0, decision: "allow" } },
      );
      return r.id;
    },
    async meterProviderCall(c) {
      await meter({ workspaceId: input.workspaceId, projectId: input.projectId ?? null, actorId: input.userId, action: "web_search_call", idempotencyKey: `web_search:${c.answerId}:${c.provider}:${c.n}`, credits: c.credits, evidenceRef: `answer:${c.answerId}`, afterTheFact: true });
    },
    ...opts.overrides,
  };

  const outcome = await answerQuestion({ question, workspaceId: input.workspaceId, answerId }, deps);
  const status = outcome.payload.partial ? "partial" : "done";
  await withWorkspaceScope(input.workspaceId, (tx) =>
    (tx as Prisma.TransactionClient).webAnswer.create({
      data: {
        id: answerId,
        workspaceId: input.workspaceId,
        userId: input.userId,
        question,
        status,
        mock: outcome.usage.mock,
        payload: outcome.payload as unknown as Prisma.InputJsonValue,
        captureIds: outcome.captureIds,
        providerCostMicroUsd: outcome.usage.providerMicroUsd,
        modelCostMicroUsd: outcome.usage.modelMicroUsd,
        credits: outcome.usage.credits,
        capCredits: outcome.usage.capCredits,
      },
    }),
  );
  return { ...outcome, id: answerId, status };
}

export interface AnswerSummary {
  id: string;
  question: string;
  status: string;
  mock: boolean;
  credits: number;
  createdAt: Date;
}

export async function listAnswers(workspaceId: string, userId: string, limit = 30): Promise<AnswerSummary[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Prisma.TransactionClient).webAnswer.findMany({ where: { workspaceId, userId }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 100), select: { id: true, question: true, status: true, mock: true, credits: true, createdAt: true } }),
  );
  return rows;
}

/** One answer, only for the person who asked it. */
export async function getAnswer(workspaceId: string, userId: string, id: string) {
  const row = await withWorkspaceScope(workspaceId, (tx) => (tx as Prisma.TransactionClient).webAnswer.findFirst({ where: { id, workspaceId, userId } }));
  if (!row) return null;
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    mock: row.mock,
    payload: row.payload as unknown as AnswerPayload,
    captureIds: row.captureIds,
    usage: { providerMicroUsd: row.providerCostMicroUsd, modelMicroUsd: row.modelCostMicroUsd, credits: row.credits, capCredits: row.capCredits },
    createdAt: row.createdAt,
  };
}

/**
 * A receipt, for a member who may see it: public-web captures to any member of the
 * workspace; a capture of a WORKSPACE record only to the person whose answer cited it.
 */
export async function getReceiptFor(workspaceId: string, userId: string, captureId: string) {
  const { getCapture } = await import("@/lib/agentweb/captures-store");
  const cap = await getCapture(workspaceId, captureId);
  if (!cap) return null;
  if (cap.provider === "workspace") {
    const mine = cap.answerId ? await getAnswer(workspaceId, userId, cap.answerId) : null;
    if (!mine) return null;
  }
  return cap;
}
