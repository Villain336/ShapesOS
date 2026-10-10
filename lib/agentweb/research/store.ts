// ShapesOS — Phase 21A round 2 (WS=agentweb): research sessions at rest (FORCE RLS tables
// agentweb_research, agentweb_research_items).
//
// A research session belongs to the member who started it. It is private until they share it with
// the workspace (the Notes share states; sharing needs the editor role). Answers (web_answers),
// pages (web_captures) and the agent's browsing session (agent_runs) are attached by id: nothing is
// copied, so the receipts and the run tree stay the single source of truth.

import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { roleAtLeast } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { AnswerPayload } from "@/lib/answer/types";
import { receiptSecret } from "../receipts";
import { rememberPage } from "../memory/store";
import { buildView, exportBundle, type AnswerInput, type CaptureInput, type ExportBundle, type ResearchRow, type ResearchView } from "./view";

type Tx = Prisma.TransactionClient;

export const MAX_RESEARCH_PER_MEMBER = 200;
export const MAX_ITEMS_PER_RESEARCH = 100;
export const NOTES_MAX = 20_000;

export class ResearchError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "bad_request" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "ResearchError";
  }
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");

export interface ResearchSummary {
  id: string;
  title: string;
  question: string;
  status: string;
  shareState: string;
  owner: boolean;
  answers: number;
  pages: number;
  updatedAt: string;
}

async function loadOwned(tx: Tx, workspaceId: string, userId: string, id: string) {
  const row = await tx.agentwebResearch.findFirst({ where: { id, workspaceId } });
  if (!row) throw new ResearchError("not_found", "That research was not found.");
  if (row.userId !== userId) throw new ResearchError(row.shareState === "workspace" ? "forbidden" : "not_found", row.shareState === "workspace" ? "Only the person who started this research can change it." : "That research was not found.");
  return row;
}

export async function createResearch(workspaceId: string, userId: string, input: { question: string; title?: string; answerId?: string }): Promise<ResearchSummary> {
  const question = clip(input.question, 2000);
  if (question.length < 3) throw new ResearchError("bad_request", "Say what you want to find out.");
  const id = `rs_${randomBytes(9).toString("hex")}`;
  await withWorkspaceScope(workspaceId, async (tx) => {
    if ((await (tx as Tx).agentwebResearch.count({ where: { workspaceId, userId } })) >= MAX_RESEARCH_PER_MEMBER) throw new ResearchError("limit", `You can keep ${MAX_RESEARCH_PER_MEMBER} research sessions. Archive or remove some first.`);
    await (tx as Tx).agentwebResearch.create({ data: { id, workspaceId, userId, title: clip(input.title, 160) || question.slice(0, 120), question } });
  });
  if (input.answerId) await attachAnswer(workspaceId, userId, id, input.answerId);
  return (await listResearch(workspaceId, userId)).find((r) => r.id === id)!;
}

/** The member's own sessions and the ones other members shared with the workspace. */
export async function listResearch(workspaceId: string, userId: string): Promise<ResearchSummary[]> {
  const rows = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).agentwebResearch.findMany({
      where: { workspaceId, OR: [{ userId }, { shareState: "workspace" }] },
      orderBy: { updatedAt: "desc" },
      take: 300,
      include: { items: { select: { kind: true } } },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    question: r.question,
    status: r.status,
    shareState: r.shareState,
    owner: r.userId === userId,
    answers: r.items.filter((i) => i.kind === "answer").length,
    pages: r.items.filter((i) => i.kind === "capture").length,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function loadInputs(tx: Tx, workspaceId: string, row: { id: string; userId: string }) {
  const items = await tx.agentwebResearchItem.findMany({ where: { workspaceId, researchId: row.id }, orderBy: { createdAt: "asc" } });
  const answerIds = items.filter((i) => i.kind === "answer").map((i) => i.refId);
  const answerRows = answerIds.length ? await tx.webAnswer.findMany({ where: { workspaceId, id: { in: answerIds } } }) : [];
  const answers: AnswerInput[] = answerRows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((a) => ({ id: a.id, question: a.question, status: a.status, createdAt: a.createdAt, payload: a.payload as unknown as AnswerPayload }));
  const captureIds = new Set<string>(items.filter((i) => i.kind === "capture").map((i) => i.refId));
  for (const a of answers) for (const s of a.payload.sources) if (s.captureId) captureIds.add(s.captureId);
  const capRows = captureIds.size ? await tx.webCapture.findMany({ where: { workspaceId, id: { in: [...captureIds] }, retentionUntil: { gt: new Date() } } }) : [];
  const captures: CaptureInput[] = capRows.map((c) => ({ id: c.id, url: c.url, fetchedAt: c.fetchedAt, domHash: c.domHash, textHash: c.textHash, excerpt: c.excerpt, alg: c.alg, signature: c.signature, provider: c.provider }));
  // Attached pages are the capture items; the view lists those no answer cites.
  return { answers, captures, attached: new Set(items.filter((i) => i.kind === "capture").map((i) => i.refId)) };
}

export async function getResearch(workspaceId: string, readerId: string, id: string, opts: { includeWorkspace?: boolean } = {}): Promise<ResearchView | null> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const row = await (tx as Tx).agentwebResearch.findFirst({ where: { id, workspaceId } });
    if (!row || (row.userId !== readerId && row.shareState !== "workspace")) return null;
    const { answers, captures, attached } = await loadInputs(tx as Tx, workspaceId, row);
    // Pages cited by an answer but not attached are not "pages"; pages attached are, even if cited.
    const view = buildView(row as ResearchRow, answers, captures, { readerId, includeWorkspace: opts.includeWorkspace });
    const have = new Set(view.pages.map((p) => p.captureId));
    for (const c of captures) if (attached.has(c.id) && !have.has(c.id) && (c.provider !== "workspace" || (view.owner && opts.includeWorkspace))) view.pages.push({ captureId: c.id, url: c.url, excerpt: c.excerpt, fetchedAt: c.fetchedAt.toISOString() });
    return view;
  });
}

export async function updateResearch(workspaceId: string, userId: string, role: string, id: string, patch: { title?: string; notes?: string; status?: string; shareState?: string; runId?: string | null }): Promise<ResearchView> {
  const data: Prisma.AgentwebResearchUpdateInput = {};
  if (patch.title !== undefined) {
    const t = clip(patch.title, 160);
    if (!t) throw new ResearchError("bad_request", "A research session needs a title.");
    data.title = t;
  }
  if (patch.notes !== undefined) {
    if (typeof patch.notes !== "string" || patch.notes.length > NOTES_MAX) throw new ResearchError("bad_request", `Notes can be up to ${NOTES_MAX.toLocaleString("en-US")} characters.`);
    data.notes = patch.notes;
  }
  if (patch.status !== undefined) {
    if (patch.status !== "open" && patch.status !== "archived") throw new ResearchError("bad_request", "Status is open or archived.");
    data.status = patch.status;
  }
  if (patch.shareState !== undefined) {
    if (patch.shareState !== "private" && patch.shareState !== "workspace") throw new ResearchError("bad_request", "Share state is private or workspace.");
    if (patch.shareState === "workspace" && !roleAtLeast(role as never, "editor")) throw new ResearchError("forbidden", "Sharing research with the workspace needs the editor role.");
    data.shareState = patch.shareState;
  }
  let linkRun: string | null | undefined;
  await withWorkspaceScope(workspaceId, async (tx) => {
    await loadOwned(tx as Tx, workspaceId, userId, id);
    if (patch.runId !== undefined) {
      if (patch.runId !== null) {
        const run = await (tx as Tx).agentRun.findFirst({ where: { id: patch.runId, workspaceId, startedBy: userId }, select: { id: true } });
        if (!run) throw new ResearchError("bad_request", "That session was not found, or you did not start it.");
      }
      data.runId = patch.runId;
      linkRun = patch.runId;
    }
    await (tx as Tx).agentwebResearch.update({ where: { id, workspaceId }, data });
  });
  if (linkRun) await backfillFromRun(workspaceId, userId, id, linkRun);
  return (await getResearch(workspaceId, userId, id, { includeWorkspace: true }))!;
}

export async function removeResearch(workspaceId: string, userId: string, id: string): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    await loadOwned(tx as Tx, workspaceId, userId, id);
    await (tx as Tx).agentwebResearch.delete({ where: { id, workspaceId } });
  });
}

/** Attach one of the owner's answers; its web sources are remembered if the owner turned browsing memory on. */
export async function attachAnswer(workspaceId: string, userId: string, id: string, answerId: string): Promise<void> {
  const answer = await withWorkspaceScope(workspaceId, async (tx) => {
    await loadOwned(tx as Tx, workspaceId, userId, id);
    const a = await (tx as Tx).webAnswer.findFirst({ where: { id: answerId, workspaceId, userId } });
    if (!a) throw new ResearchError("not_found", "That answer was not found.");
    if ((await (tx as Tx).agentwebResearchItem.count({ where: { workspaceId, researchId: id } })) >= MAX_ITEMS_PER_RESEARCH) throw new ResearchError("limit", `A research session holds up to ${MAX_ITEMS_PER_RESEARCH} items.`);
    await (tx as Tx).agentwebResearchItem.upsert({
      where: { researchId_kind_refId: { researchId: id, kind: "answer", refId: answerId }, workspaceId },
      create: { id: `ri_${randomBytes(9).toString("hex")}`, workspaceId, researchId: id, kind: "answer", refId: answerId, addedBy: userId },
      update: {},
    });
    await (tx as Tx).agentwebResearch.update({ where: { id, workspaceId }, data: { updatedAt: new Date() } });
    return a;
  });
  // The person asked for this answer, so the pages it read for them may be remembered (only if they opted in).
  const payload = answer.payload as unknown as AnswerPayload;
  for (const s of payload.sources) {
    if (s.providers.includes("workspace") || !/^https?:\/\//i.test(s.url)) continue;
    await rememberPage(workspaceId, userId, { url: s.url, title: s.title, text: s.text, askedByPerson: true, captureId: s.captureId ?? null, researchId: id }).catch(() => undefined);
  }
}

export async function attachCapture(workspaceId: string, userId: string, id: string, captureId: string): Promise<void> {
  await withWorkspaceScope(workspaceId, async (tx) => {
    await loadOwned(tx as Tx, workspaceId, userId, id);
    const c = await (tx as Tx).webCapture.findFirst({ where: { workspaceId, id: captureId, retentionUntil: { gt: new Date() } } });
    if (!c || c.provider === "workspace") throw new ResearchError("not_found", "That page was not found.");
    if ((await (tx as Tx).agentwebResearchItem.count({ where: { workspaceId, researchId: id } })) >= MAX_ITEMS_PER_RESEARCH) throw new ResearchError("limit", `A research session holds up to ${MAX_ITEMS_PER_RESEARCH} items.`);
    await (tx as Tx).agentwebResearchItem.upsert({
      where: { researchId_kind_refId: { researchId: id, kind: "capture", refId: captureId }, workspaceId },
      create: { id: `ri_${randomBytes(9).toString("hex")}`, workspaceId, researchId: id, kind: "capture", refId: captureId, addedBy: userId },
      update: {},
    });
    await (tx as Tx).agentwebResearch.update({ where: { id, workspaceId }, data: { updatedAt: new Date() } });
  });
}

/** Pages the linked browsing session has read so far, for the member who asked for that session. */
export async function backfillFromRun(workspaceId: string, userId: string, researchId: string, runId: string): Promise<number> {
  const caps = await withWorkspaceScope(workspaceId, (tx) =>
    (tx as Tx).webCapture.findMany({ where: { workspaceId, runId, via: "step", stepAction: { in: ["navigate", "click"] }, retentionUntil: { gt: new Date() } }, orderBy: { fetchedAt: "asc" }, take: 200 }),
  );
  let n = 0;
  for (const c of caps) {
    const d = await rememberPage(workspaceId, userId, { url: c.url, title: "", text: c.excerpt, askedByPerson: true, captureId: c.id, researchId, runId }).catch(() => null);
    if (d?.store) n += 1;
  }
  return n;
}

/** The live hook: a step of a run the owner linked to a research session remembers its page. */
export async function rememberFromRunStep(workspaceId: string, userId: string, runId: string, page: { url: string; text: string; captureId: string }): Promise<void> {
  const linked = await withWorkspaceScope(workspaceId, (tx) => (tx as Tx).agentwebResearch.findFirst({ where: { workspaceId, userId, runId }, select: { id: true } }));
  if (!linked) return;
  await rememberPage(workspaceId, userId, { url: page.url, title: "", text: page.text, askedByPerson: true, captureId: page.captureId, researchId: linked.id, runId });
}

export async function exportResearch(workspaceId: string, readerId: string, id: string, opts: { includeWorkspace?: boolean; now?: Date } = {}): Promise<ExportBundle | null> {
  const view = await getResearch(workspaceId, readerId, id, { includeWorkspace: opts.includeWorkspace === true });
  if (!view) return null;
  return exportBundle(view, receiptSecret(), opts.now ?? new Date(), readerId);
}
