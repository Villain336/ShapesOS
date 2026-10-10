// ShapesOS — Phase 21A (WS=agentweb): put agent-ready changes into a SiteBuilder
// site as a DRAFT revision, never straight to the live working copy. Mirrors
// lib/seo/jsonld-draft.ts: read the working copy, plan (pure: ./plan.ts), save the
// whole snapshot as a Phase 9 draft (source "agent"); a person reviews the diff and
// applies it in Site drafts; deploying stays a separate step.

import { createTwoFilesPatch } from "diff";
import type { WorkingCopyProvider } from "@/lib/connectors/local";
import { assertSnapshotSize, readSiteWorkingCopy, siteFingerprint } from "@/lib/sites/files";
import { createSiteRevision, type SiteRevisionSummary } from "@/lib/sites/revisions";
import { capPatch } from "@/lib/ship/git";
import { JsonLdDraftError, siteIdentity } from "@/lib/seo/jsonld-draft";
import { planAgentReady, type AgentReadyPlan } from "./plan";
import { policyOf, type AiPolicy } from "./robots-ai";

/** What a new site starts with: found by search and answer engines, not used for training. The owner decides. */
export const DEFAULT_AI_POLICY: AiPolicy = { search: true, input: true, train: false };

export class AgentReadyError extends Error {
  constructor(
    readonly code: "no_origin" | "unreadable_files" | "no_pages",
    message: string,
  ) {
    super(message);
    this.name = "AgentReadyError";
  }
}

export interface AgentReadyDraftInput {
  workspaceId: string;
  projectId: string;
  siteId: string;
  /** The tenant's AI-usage choice; defaults to what robots.txt already says, else DEFAULT_AI_POLICY. */
  policy?: AiPolicy;
  createdBy?: string | null;
  runId?: string | null;
  /** Test seam: the working copy. */
  provider?: WorkingCopyProvider;
}

export interface AgentReadyPreview extends AgentReadyPlan {
  origin: string;
  policy: AiPolicy;
  /** The policy robots.txt states now, if any (what the UI shows as the current choice). */
  currentPolicy: AiPolicy | null;
  baseFiles: { path: string; content: string }[];
}

export async function previewAgentReady(input: AgentReadyDraftInput): Promise<AgentReadyPreview> {
  let identity;
  try {
    identity = await siteIdentity(input);
  } catch (err) {
    if (err instanceof JsonLdDraftError) throw new AgentReadyError("no_origin", "Agent readiness needs the site's absolute URL: deploy the site or set the project domain first.");
    throw err;
  }
  const { files, skipped } = await readSiteWorkingCopy(input.siteId, input.provider);
  if (skipped.length) {
    throw new AgentReadyError("unreadable_files", `The working copy has ${skipped.length} file${skipped.length === 1 ? "" : "s"} a draft can't hold (${skipped.slice(0, 3).map((s) => s.path).join(", ")}); fix those first.`);
  }
  if (!files.some((f) => /\.html?$/i.test(f.path))) throw new AgentReadyError("no_pages", "No HTML pages to make agent-ready.");
  const currentPolicy = policyOf(files.find((f) => f.path === "/robots.txt")?.content ?? null);
  const policy = input.policy ?? currentPolicy ?? DEFAULT_AI_POLICY;
  const plan = planAgentReady({ files, origin: identity.origin, siteName: identity.name, logo: identity.logo, sameAs: identity.sameAs, policy });
  return { ...plan, origin: identity.origin, policy, currentPolicy, baseFiles: files };
}

function patchOf(base: { path: string; content: string }[], next: { path: string; content: string }[]): { patch: string; truncated: boolean } {
  const before = new Map(base.map((f) => [f.path, f.content]));
  const parts: string[] = [];
  for (const f of next) {
    const old = before.get(f.path) ?? "";
    if (old === f.content) continue;
    const rel = f.path.replace(/^\//, "");
    parts.push(createTwoFilesPatch(before.has(f.path) ? `a/${rel}` : "/dev/null", `b/${rel}`, old, f.content, "", "", { context: 2 }).replace(/^=+\n/m, ""));
  }
  return capPatch(parts.join(""));
}

export interface AgentReadyDraftResult {
  /** Null when the site already carries exactly these changes. */
  revision: SiteRevisionSummary | null;
  preview: AgentReadyPreview;
}

export async function createAgentReadyDraft(input: AgentReadyDraftInput): Promise<AgentReadyDraftResult> {
  const preview = await previewAgentReady(input);
  if (!preview.changes.length) return { revision: null, preview };
  assertSnapshotSize(preview.files);
  const { patch, truncated } = patchOf(preview.baseFiles, preview.files);
  const revision = await createSiteRevision({
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    status: "draft",
    source: "agent",
    files: preview.files,
    runId: input.runId ?? null,
    summary: `Agent readiness: ${preview.changes.length} file${preview.changes.length === 1 ? "" : "s"} changed (score ${preview.before.score} to ${preview.after.score})`,
    patch,
    patchTruncated: truncated,
    baseFingerprint: siteFingerprint(preview.baseFiles),
    createdBy: input.createdBy ?? null,
  });
  return { revision, preview };
}
