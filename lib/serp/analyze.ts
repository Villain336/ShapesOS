// Marketr — standalone SERP analysis core (serp_analysis action).
//
// One user intent = one charge: this is the ONLY seam that meters
// "serp_analysis". The raw pull itself is un-metered (lib/serp/pull.ts, T14).
// Used by POST /api/serp/analyze and the MCP analyze_serp tool — both are
// thin wrappers; all authz, cap-gating, and metering live here.

import { prisma } from "@/lib/prisma";
import { accessibleWorkspaceWhere, requireProjectRole } from "@/lib/authz";
import { checkCap, meter } from "@/lib/metering/service";
import { dayBucket, seedHash } from "@/lib/metering/wiring";
import { pullSerp } from "./pull";
import type { KeywordIntentLabel } from "@/lib/providers/types";

/** Coded error the route/MCP wrappers map to status codes. */
export class ActionError extends Error {
  constructor(
    public code:
      | "validation"
      | "project_not_found"
      | "forbidden"
      | "cap_denied"
      | "provider_error",
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export interface AnalyzeSerpInput {
  userId: string;
  projectId: string;
  keyword: string;
  /** DataForSEO location code; default 2840 (United States). */
  locationCode?: number;
  /**
   * Recorded and part of the idempotency key, but NOT passed to the
   * provider — the current SeoDataProvider interface has no device
   * targeting. Honest: we record intent for future provider support.
   */
  device?: "desktop" | "mobile";
  /** Evidence only, never affects billing. */
  actorId?: string;
}

export interface SerpAnalysis {
  keyword: string;
  locationCode: number;
  device: "desktop" | "mobile";
  results: Array<{
    position: number;
    domain: string;
    url: string;
    title: string;
    description: string | null;
  }>;
  features: {
    aiOverviewPresent: boolean | null;
    peopleAlsoAskCount: number;
  };
  peopleAlsoAsk: string[];
  /**
   * Empty: the current SERP parser (live DataForSEO and mock) does not
   * surface related searches. The field exists so callers don't invent it.
   */
  relatedSearches: string[];
  analysis: {
    resultCount: number;
    uniqueDomains: number;
    /** uniqueDomains / resultCount, 0..1, 2dp. */
    domainDiversity: number;
    topDomain: string | null;
    /** SERP features detected, e.g. ["ai_overview", "people_also_ask"]. */
    featureBreakdown: string[];
  };
  provider: { name: string; isLive: boolean; configured: boolean };
  mock: boolean;
  notes: string[];
}

export interface AnalyzeSerpResult {
  analysis: SerpAnalysis;
  charged: number;
  eventId: string;
}

function capDeniedMessage(used: number, capCredits: number): string {
  return (
    `Credit cap reached (${used.toLocaleString()} of ${capCredits.toLocaleString()} ` +
    `credits used). Raise the cap or add credits in Settings → Usage.`
  );
}

export async function analyzeSerpUnmetered(
  input: AnalyzeSerpInput,
): Promise<{
  analysis: SerpAnalysis;
  workspaceId: string;
  projectId: string;
}> {
  const keyword = input.keyword.trim();
  if (!keyword || keyword.length > 200) {
    throw new ActionError(
      "validation",
      "keyword is required (1–200 characters).",
      400,
    );
  }
  if (!input.projectId) {
    throw new ActionError("validation", "projectId is required.", 400);
  }
  const device = input.device ?? "desktop";
  if (input.device && input.device !== "desktop" && input.device !== "mobile") {
    throw new ActionError(
      "validation",
      'device must be "desktop" or "mobile".',
      400,
    );
  }
  const locationCode = input.locationCode ?? 2840;

  // Workspace comes from the authorized project row — never from client input (T10).
  const project = await prisma.project.findFirst({
    where: {
      id: input.projectId,
      workspace: accessibleWorkspaceWhere(input.userId),
    },
    select: { id: true, workspaceId: true },
  });
  if (!project) {
    throw new ActionError(
      "project_not_found",
      "Project not found in this workspace.",
      404,
    );
  }
  if (!(await requireProjectRole(input.userId, project.id, "editor"))) {
    throw new ActionError(
      "forbidden",
      "Editor role required to run a SERP analysis.",
      403,
    );
  }
  const workspaceId = project.workspaceId;

  // Pre-run cap gate: a capped workspace never executes (zero vendor spend).
  const cap = await checkCap(workspaceId);
  if (!cap.allowed) {
    throw new ActionError(
      "cap_denied",
      capDeniedMessage(cap.used, cap.capCredits),
      402,
    );
  }

  let pulled;
  try {
    pulled = await pullSerp({ keyword, locationCode, depth: 10 });
  } catch (err) {
    throw new ActionError(
      "provider_error",
      err instanceof Error ? err.message : "SERP pull failed.",
      502,
    );
  }
  const { snapshot, provider } = pulled;

  const results = snapshot.results.slice(0, 10).map((r) => ({
    position: r.position,
    domain: r.domain,
    url: r.url,
    title: r.title,
    description: r.description,
  }));
  const domainCounts = new Map<string, number>();
  for (const r of results) {
    domainCounts.set(r.domain, (domainCounts.get(r.domain) ?? 0) + 1);
  }
  const uniqueDomains = domainCounts.size;
  const resultCount = results.length;
  let topDomain: string | null = null;
  let topCount = 0;
  for (const [domain, count] of domainCounts) {
    if (count > topCount) {
      topCount = count;
      topDomain = domain;
    }
  }
  const featureBreakdown: string[] = [];
  if (snapshot.aiOverviewPresent) featureBreakdown.push("ai_overview");
  if (snapshot.peopleAlsoAsk.length > 0)
    featureBreakdown.push("people_also_ask");

  const notes: string[] = [];
  if (snapshot.mock || !provider.isLive) {
    notes.push(
      "Mock SERP for development — connect a live data source for real results. Never treat mock rows as real measurements.",
    );
  }
  notes.push(
    "Related searches are not surfaced by the current SERP parser and are returned empty — never invented.",
  );
  if (input.device) {
    notes.push(
      "Device targeting is recorded but not passed to the provider — the current provider interface has no device parameter.",
    );
  }

  const analysis: SerpAnalysis = {
    keyword,
    locationCode,
    device,
    results,
    features: {
      aiOverviewPresent: snapshot.aiOverviewPresent ?? null,
      peopleAlsoAskCount: snapshot.peopleAlsoAsk.length,
    },
    peopleAlsoAsk: snapshot.peopleAlsoAsk,
    relatedSearches: [],
    analysis: {
      resultCount,
      uniqueDomains,
      domainDiversity:
        resultCount === 0
          ? 0
          : Math.round((uniqueDomains / resultCount) * 100) / 100,
      topDomain,
      featureBreakdown,
    },
    provider,
    mock: snapshot.mock ?? !provider.isLive,
    notes,
  };

  return { analysis, workspaceId, projectId: project.id };
}

/**
 * Metered wrapper for the REST route — the ONLY seam that writes a
 * "serp_analysis" ledger event. Meter AFTER success; replay (same query,
 * same UTC day) returns the original charge without a second charge
 * (T13). Cap denial here is the authoritative enforcement (T9) —
 * fail closed, no results returned.
 */
export async function analyzeSerp(
  input: AnalyzeSerpInput,
): Promise<AnalyzeSerpResult> {
  const { analysis, workspaceId, projectId } =
    await analyzeSerpUnmetered(input);
  const keyword = analysis.keyword;
  const key = `serpanalysis:${seedHash(
    `${workspaceId}|${keyword.toLowerCase()}|${analysis.locationCode}|${analysis.device}|${dayBucket()}`,
  )}`;
  const res = await meter({
    workspaceId,
    projectId,
    actorId: input.actorId,
    action: "serp_analysis",
    idempotencyKey: key,
    evidenceRef: `serp-analysis:${keyword.slice(0, 60)}`,
  });
  if (!res.ok) {
    throw new ActionError("cap_denied", res.message, 402);
  }
  return { analysis, charged: res.charged, eventId: res.eventId };
}

export type { KeywordIntentLabel };
