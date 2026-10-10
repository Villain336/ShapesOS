// ShapesOS — Phase 21A round 2 (WS=agentweb): a research session as a document (PURE).
//
// A research session collects what a person found: the answers they asked (each with its claims,
// citations and sources), pages they attached directly, their own notes. This module builds the
// view of it for ONE reader and the Markdown export with its receipts.
//
// What leaves the owner's hands: an answer can cite the owner's WORKSPACE records (private notes,
// files), because the answer engine searches the workspace as its asker. A reader who is not the
// owner never sees those sources or the claims they back, and an export leaves them out unless
// the owner asks for them. Sharing a session shares the web research, not private records.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AnswerPayload, Claim } from "@/lib/answer/types";

export interface ResearchRow {
  id: string;
  title: string;
  question: string;
  status: string;
  shareState: string;
  notes: string;
  runId: string | null;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface AnswerInput {
  id: string;
  question: string;
  status: string;
  createdAt: Date;
  payload: AnswerPayload;
}
export interface CaptureInput {
  id: string;
  url: string;
  fetchedAt: Date;
  domHash: string;
  textHash: string;
  excerpt: string;
  alg: string;
  signature: string | null;
  provider: string | null;
}

export interface ViewSource {
  id: number;
  title: string;
  url: string;
  providers: string[];
  captureId: string | null;
  /** A workspace record this reader may not see: title, address and text are empty. */
  redacted: boolean;
}
export interface ViewClaim {
  text: string;
  cites: number[];
  status: "supported" | "unsupported";
  reason: string | null;
  /** Backed only by a workspace record this reader may not see. */
  withheld: boolean;
}
export interface ViewAnswer {
  id: string;
  question: string;
  status: string;
  createdAt: string;
  claims: ViewClaim[];
  sources: ViewSource[];
  followUps: string[];
  partial: boolean;
}
export interface ViewPage {
  captureId: string;
  url: string;
  excerpt: string;
  fetchedAt: string;
}
export interface ResearchView {
  id: string;
  title: string;
  question: string;
  status: string;
  shareState: string;
  notes: string;
  runId: string | null;
  owner: boolean;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  answers: ViewAnswer[];
  pages: ViewPage[];
  /** Signed captures behind the visible sources and pages (id, address, time, hashes, signature). */
  receipts: Array<{ id: string; url: string; fetchedAt: string; domHash: string; textHash: string; excerpt: string; alg: string; signature: string | null }>;
  /** True when the reader's view leaves out the owner's workspace records. */
  workspaceHidden: boolean;
}

const isWorkspace = (providers: readonly string[]) => providers.includes("workspace");

export function buildView(row: ResearchRow, answers: readonly AnswerInput[], captures: readonly CaptureInput[], opts: { readerId: string; includeWorkspace?: boolean }): ResearchView {
  const owner = opts.readerId === row.userId;
  const showWorkspace = owner && opts.includeWorkspace === true;
  const capById = new Map(captures.map((c) => [c.id, c]));
  const cited = new Set<string>();
  const outAnswers: ViewAnswer[] = answers.map((a) => {
    const hiddenIds = new Set<number>();
    const sources: ViewSource[] = a.payload.sources.map((s) => {
      const red = !showWorkspace && isWorkspace(s.providers);
      if (red) hiddenIds.add(s.id);
      else if (s.captureId) cited.add(s.captureId);
      return { id: s.id, title: red ? "" : s.title, url: red ? "" : s.url, providers: red ? ["workspace"] : s.providers, captureId: red ? null : (s.captureId ?? null), redacted: red };
    });
    const claims: ViewClaim[] = a.payload.claims.map((c: Claim) => {
      const withheld = c.cites.length > 0 && c.cites.every((id) => hiddenIds.has(id));
      return { text: withheld ? "" : c.text, cites: withheld ? [] : c.cites.filter((id) => !hiddenIds.has(id)), status: c.status, reason: c.reason ?? null, withheld };
    });
    // Sources the answer cited but that were captured for a hidden record never show up in pages.
    for (const s of a.payload.sources) if (s.captureId && isWorkspace(s.providers)) cited.add(s.captureId);
    return { id: a.id, question: a.question, status: a.status, createdAt: a.createdAt.toISOString(), claims, sources, followUps: a.payload.followUps, partial: a.payload.partial };
  });
  const pages: ViewPage[] = captures
    .filter((c) => !cited.has(c.id) && (showWorkspace || c.provider !== "workspace"))
    .map((c) => ({ captureId: c.id, url: c.url, excerpt: c.excerpt, fetchedAt: c.fetchedAt.toISOString() }));
  const visible = new Set<string>([...pages.map((p) => p.captureId), ...outAnswers.flatMap((a) => a.sources.map((s) => s.captureId).filter((x): x is string => !!x))]);
  const receipts = [...visible]
    .map((id) => capById.get(id))
    .filter((c): c is CaptureInput => !!c)
    .sort((a, b) => a.fetchedAt.getTime() - b.fetchedAt.getTime() || a.id.localeCompare(b.id))
    .map((c) => ({ id: c.id, url: c.url, fetchedAt: c.fetchedAt.toISOString(), domHash: c.domHash, textHash: c.textHash, excerpt: c.excerpt, alg: c.alg, signature: c.signature }));
  return {
    id: row.id,
    title: row.title,
    question: row.question,
    status: row.status,
    shareState: row.shareState,
    notes: row.notes,
    runId: row.runId,
    owner,
    ownerId: row.userId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    answers: outAnswers,
    pages,
    receipts,
    workspaceHidden: !showWorkspace && answers.some((a) => a.payload.sources.some((s) => isWorkspace(s.providers))),
  };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function researchMarkdown(v: ResearchView): string {
  const out: string[] = [`# ${oneLine(v.title) || "Research"}`, "", `**Question:** ${oneLine(v.question)}`, ""];
  for (const a of v.answers) {
    out.push(`## ${oneLine(a.question)}`, "");
    if (a.partial) out.push("_Partial answer: it stopped early._", "");
    const claims = a.claims.filter((c) => !c.withheld);
    out.push(
      ...(claims.length
        ? claims.map((c) => `- ${c.text}${c.cites.length ? ` ${c.cites.map((i) => `[${i}]`).join("")}` : ""}${c.status === "unsupported" ? ` (unsupported: ${c.reason ?? "no source backs this"})` : ""}`)
        : ["_No claims._"]),
      "",
    );
    const shown = a.sources.filter((s) => !s.redacted);
    if (shown.length) out.push("**Sources**", "", ...shown.map((s) => `[${s.id}] ${oneLine(s.title)} — ${s.url}${s.captureId ? ` (receipt ${s.captureId})` : ""}`), "");
  }
  if (v.pages.length) out.push("## Pages", "", ...v.pages.map((p) => `- ${p.url} — ${oneLine(p.excerpt).slice(0, 200)} (receipt ${p.captureId})`), "");
  if (v.notes.trim()) out.push("## Notes", "", v.notes.trim(), "");
  if (v.receipts.length) {
    out.push("## Receipts", "", "Each source was stored when it was read: address, time and content hashes, signed by this workspace.", "");
    for (const r of v.receipts) out.push(`- ${r.id} — ${r.url} — ${r.fetchedAt} — dom ${r.domHash.slice(0, 16)} text ${r.textHash.slice(0, 16)} — ${r.alg === "hmac-sha256" && r.signature ? "signed" : "not signed"}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export interface ExportBundle {
  markdown: string;
  receipts: ResearchView["receipts"];
  exportedAt: string;
  exportedBy: string;
  /** HMAC over the Markdown and the receipt ids, or null when the app has no secret. */
  seal: string | null;
}

export function sealExport(markdown: string, receiptIds: readonly string[], secret: string): string {
  const h = createHash("sha256").update(markdown).digest("hex");
  return createHmac("sha256", secret).update(`research-export:v1\n${h}\n${receiptIds.join(",")}`).digest("hex");
}

export function exportBundle(view: ResearchView, secret: string | null, now: Date, exportedBy: string): ExportBundle {
  const markdown = researchMarkdown(view);
  return { markdown, receipts: view.receipts, exportedAt: now.toISOString(), exportedBy, seal: secret ? sealExport(markdown, view.receipts.map((r) => r.id), secret) : null };
}

export function verifySeal(b: Pick<ExportBundle, "markdown" | "receipts" | "seal">, secret: string): boolean {
  if (!b.seal) return false;
  const want = Buffer.from(sealExport(b.markdown, b.receipts.map((r) => r.id), secret));
  const got = Buffer.from(b.seal);
  return want.length === got.length && timingSafeEqual(want, got);
}
