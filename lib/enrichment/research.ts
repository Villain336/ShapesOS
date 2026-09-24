// Marketr — R6 AI research agent (lib/enrichment/research.ts).
//
// Per-prospect research: takes the prospect + its enrichment data + the
// list's ICP and writes Prospect.research =
//   { summary, icebreakers[3], firstLines[3], talkingPoints[] }.
// RESEARCH ONLY — this module never sends anything, anywhere. Outreach is
// R3's territory and always goes through the approval queue.
//
// LLM routing (lib/llm): "background" workload for the company summary,
// "copy" workload for the client-facing icebreakers/first lines. Each run
// meters one `prospect_research` charge and audit-logs. When no live LLM is
// configured the router falls back to the mock provider; the parser is
// tolerant of non-JSON output and the result is flagged mock:true so the UI
// can label it honestly.

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { meter } from "@/lib/metering/service";
import { auditEvent } from "@/lib/auditlog";
import { getLlmProviderFor, WORKLOAD_MAX_TOKENS } from "@/lib/llm";
import type { FileChangeAction } from "@prisma/client";

export interface ProspectResearch {
  summary: string;
  icebreakers: string[];
  firstLines: string[];
  talkingPoints: string[];
  generatedAt: string;
  /** Model string that produced this research ("mock" when unconfigured). */
  model: string;
  /** True when produced without a live LLM — label it in the UI. */
  mock: boolean;
  wordCount: number;
}

interface ProspectContext {
  name: string | null;
  title: string | null;
  company: string | null;
  website: string | null;
  enrichmentData: Record<string, unknown> | null;
  icp: Record<string, unknown>;
  listName: string;
}

function ctxLine(label: string, value: string | null | undefined): string {
  return value ? `${label}: ${value}` : "";
}

function buildContext(c: ProspectContext): string {
  const ed = c.enrichmentData ?? {};
  const company = (ed.company ?? {}) as Record<string, unknown>;
  const contact = (ed.contact ?? {}) as Record<string, unknown>;
  const icp = c.icp;
  return [
    ctxLine("Contact", c.name),
    ctxLine("Title", (contact.title as string) ?? c.title),
    ctxLine("Company", (company.name as string) ?? c.company),
    ctxLine("Website", (company.website as string) ?? c.website),
    ctxLine("Industry", company.industry as string),
    ctxLine("Employees", (company.employeeRange as string) ?? String(company.employeeCount ?? "")),
    ctxLine("Location", company.location as string),
    ctxLine("About", company.description as string),
    ctxLine("Tech stack", Array.isArray(company.technologies) ? (company.technologies as string[]).join(", ") : ""),
    "",
    "Our ideal customer profile:",
    ctxLine("Industries", Array.isArray(icp.industries) ? (icp.industries as string[]).join(", ") : ""),
    ctxLine("Titles", Array.isArray(icp.titles) ? (icp.titles as string[]).join(", ") : ""),
    ctxLine("Geo", typeof icp.geo === "string" ? icp.geo : ""),
  ]
    .filter(Boolean)
    .join("\n");
}

function take3(arr: string[]): [string, string, string] {
  const clean = arr.map((s) => s.trim()).filter(Boolean);
  while (clean.length < 3) clean.push(clean[clean.length - 1] ?? "");
  return [clean[0], clean[1], clean[2]];
}

/** Tolerant parse of the copy-workload output. Real LLMs return the asked
 *  JSON; the mock provider returns canned markdown, so fall back to
 *  deterministic lines built from the context (flagged mock:true). */
function parseOutreach(text: string, c: ProspectContext): { icebreakers: [string, string, string]; firstLines: [string, string, string]; talkingPoints: string[] } {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        icebreakers?: string[];
        firstLines?: string[];
        talkingPoints?: string[];
      };
      if (Array.isArray(parsed.icebreakers) && Array.isArray(parsed.firstLines)) {
        return {
          icebreakers: take3(parsed.icebreakers.map(String)),
          firstLines: take3(parsed.firstLines.map(String)),
          talkingPoints: Array.isArray(parsed.talkingPoints) ? parsed.talkingPoints.map(String).slice(0, 6) : [],
        };
      }
    } catch {
      // fall through to the deterministic fallback
    }
  }
  const company = c.company ?? "their company";
  const contactFirst = (c.name ?? "there").split(/\s+/)[0];
  const industry = ((c.enrichmentData?.company as Record<string, unknown> | undefined)?.industry as string) ?? "their industry";
  return {
    icebreakers: [
      `Noticed ${company} is growing its ${industry} footprint — curious how you're thinking about marketing as you scale.`,
      `Saw ${company} is hiring around growth — usually a sign the current playbook is straining.`,
      `${contactFirst}, quick question about how ${company} is approaching customer acquisition this quarter.`,
    ],
    firstLines: [
      `Hi ${contactFirst} — I came across ${company} and was impressed by your traction in ${industry}.`,
      `Hi ${contactFirst} — noticed ${company}'s recent momentum and had one idea worth 30 seconds.`,
      `Hi ${contactFirst} — we help ${industry} companies turn marketing into pipeline; thought of ${company} immediately.`,
    ],
    talkingPoints: [
      `Growth-stage ${industry} company — likely feeling scaling pain in acquisition.`,
      `Fit against ICP: ${c.listName}.`,
      `Lead with a specific observation, not a generic pitch.`,
    ],
  };
}

function wordCountOf(...texts: string[]): number {
  return texts.join(" ").split(/\s+/).filter(Boolean).length;
}

/**
 * Run AI research for one prospect and persist it to Prospect.research.
 * Idempotent per call (each call meters exactly one `prospect_research`
 * charge and overwrites the previous research payload).
 */
export async function researchProspect(
  workspaceId: string,
  prospectId: string,
  actorUserId?: string,
): Promise<ProspectResearch> {
  const prospect = await prisma.prospect.findFirst({
    where: { id: prospectId, workspaceId },
    include: { list: { select: { name: true, icp: true } } },
  });
  if (!prospect) throw new Error("Prospect not found");

  const ctx: ProspectContext = {
    name: prospect.name,
    title: prospect.title,
    company: prospect.company,
    website: prospect.website,
    enrichmentData: (prospect.enrichmentData ?? null) as Record<string, unknown> | null,
    icp: (prospect.list.icp ?? {}) as Record<string, unknown>,
    listName: prospect.list.name,
  };
  const contextBlock = buildContext(ctx);

  // 1) Company summary — background workload (cheap model).
  const background = getLlmProviderFor("background");
  const summaryPrompt = [
    "Write a 2-3 sentence research summary of this prospect for a B2B sales rep.",
    "Focus on what the company does, its scale, and why it might need marketing help.",
    "Plain text, no markdown, no preamble.",
    "",
    contextBlock,
  ].join("\n");
  let summary = "";
  try {
    summary = (await background.generate(summaryPrompt, { maxTokens: 512 })).trim();
  } catch (err) {
    summary = "";
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "prospect_researched" as FileChangeAction,
      summary: `Prospect research summary failed for ${prospect.id}: ${err instanceof Error ? err.message : err}`.slice(0, 500),
      actorUserId,
    }).catch(() => {});
  }

  // 2) Icebreakers + first lines + talking points — copy workload.
  const copy = getLlmProviderFor("copy");
  const outreachPrompt = [
    "You are writing cold-outreach research for a B2B sales rep. Using the prospect context below,",
    "respond with ONLY a JSON object (no markdown fences, no commentary) shaped like:",
    '{"icebreakers": ["...", "...", "..."], "firstLines": ["...", "...", "..."], "talkingPoints": ["...", "..."]}',
    "Rules: 3 icebreakers (one specific observation each, under 25 words), 3 email first lines",
    "(personal, under 20 words), 3-6 talking points (discovery angles tied to their business).",
    "Never invent funding rounds, revenue numbers, or news events you were not given.",
    "",
    contextBlock,
  ].join("\n");
  let outreachText = "";
  try {
    outreachText = await copy.generate(outreachPrompt, {
      maxTokens: WORKLOAD_MAX_TOKENS.copy,
    });
  } catch (err) {
    await auditEvent({
      projectId: null,
      workspaceId,
      action: "prospect_researched" as FileChangeAction,
      summary: `Prospect research outreach failed for ${prospect.id}: ${err instanceof Error ? err.message : err}`.slice(0, 500),
      actorUserId,
    }).catch(() => {});
  }

  const mock = !background.isLive && !copy.isLive;
  const parsed = parseOutreach(outreachText, ctx);
  const finalSummary =
    summary && !summary.startsWith("> **Mock draft**")
      ? summary.split("\n").filter((l) => !l.startsWith(">")).join(" ").trim().slice(0, 600)
      : `${ctx.company ?? "This prospect"} — ${(ctx.enrichmentData?.company as Record<string, unknown> | undefined)?.description as string ?? "B2B prospect matching the list ICP."}`.slice(0, 600);

  const research: ProspectResearch = {
    summary: finalSummary,
    icebreakers: [...parsed.icebreakers],
    firstLines: [...parsed.firstLines],
    talkingPoints: parsed.talkingPoints,
    generatedAt: new Date().toISOString(),
    model: mock ? "mock" : `${background.name}+${copy.name}`,
    mock,
    wordCount: 0,
  };
  research.wordCount = wordCountOf(research.summary, ...research.icebreakers, ...research.firstLines, ...research.talkingPoints);

  await prisma.prospect.update({
    where: { id: prospect.id },
    data: { research: research as unknown as object },
  });

  await meter({
    workspaceId,
    actorId: actorUserId ?? null,
    action: "prospect_research",
    idempotencyKey: `research:${prospect.id}:${randomUUID()}`,
    evidenceRef: `prospect:${prospect.id}`,
  }).catch(() => null);

  // NOTE: "prospect_researched" must be added to the FileChangeAction enum in
  // prisma/schema.prisma by the schema coordinator — until then this no-ops.
  await auditEvent({
    projectId: null,
    workspaceId,
    action: "prospect_researched" as FileChangeAction,
    summary: `AI research generated for prospect ${prospect.id} (${research.wordCount} words${mock ? ", mock provider" : ""})`,
    actorUserId,
  }).catch(() => {});

  return research;
}
