// Marketr — Wave 2 context.dev slice 2: KnowledgeSource governance.
//
// Governed action `add_source`: registering a new KnowledgeSource.
//   - The tenant's own domains (workspace Project domains) auto-activate.
//   - A third-party domain already approved once in this workspace auto-activates.
//   - Any other third-party domain lands at pending_approval — a tenant
//     approval (approveSource) activates it; rejectSource archives it.
//
// Pure helpers (extractDomain, classifySourceDomain) are unit-tested; the
// DB functions are thin wrappers over Prisma.

import { prisma } from "@/lib/prisma";

export type KnowledgeSourceType = "page" | "sitemap" | "brand";
export type KnowledgeSourceCadence = "manual" | "daily" | "weekly";
export type KnowledgeSourceStatus = "active" | "pending_approval" | "archived";

export const KNOWLEDGE_SOURCE_TYPES: readonly KnowledgeSourceType[] = ["page", "sitemap", "brand"];
export const KNOWLEDGE_SOURCE_CADENCES: readonly KnowledgeSourceCadence[] = ["manual", "daily", "weekly"];

export class KnowledgeSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "KnowledgeSourceError";
    this.code = code;
  }
}

/** Lowercased hostname of a URL. Throws BAD_URL on anything unparsable. */
export function extractDomain(url: string): string {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    throw new KnowledgeSourceError("BAD_URL", "Source URL is not a valid absolute URL");
  }
  if (!host || !host.includes(".")) {
    throw new KnowledgeSourceError("BAD_URL", "Source URL must have a valid hostname");
  }
  return host;
}

/**
 * Pure governance decision. ownDomains = workspace Project domains.
 * approvedDomains = domains with an active (or previously approved) source.
 */
export function classifySourceDomain(
  domain: string,
  ownDomains: readonly string[],
  approvedDomains: readonly string[],
): KnowledgeSourceStatus {
  const d = domain.toLowerCase();
  if (ownDomains.some((o) => o.toLowerCase() === d)) return "active";
  if (approvedDomains.some((a) => a.toLowerCase() === d)) return "active";
  return "pending_approval";
}

async function workspaceOwnDomains(workspaceId: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    select: { domain: true },
  });
  return [...new Set(projects.map((p) => p.domain.toLowerCase()).filter(Boolean))];
}

export interface RegisterSourceInput {
  url: string;
  sourceType: KnowledgeSourceType;
  cadence?: KnowledgeSourceCadence;
}

export async function registerSource(workspaceId: string, input: RegisterSourceInput) {
  if (!KNOWLEDGE_SOURCE_TYPES.includes(input.sourceType)) {
    throw new KnowledgeSourceError("BAD_TYPE", `Unknown source type "${input.sourceType}"`);
  }
  const cadence = input.cadence ?? "manual";
  if (!KNOWLEDGE_SOURCE_CADENCES.includes(cadence)) {
    throw new KnowledgeSourceError("BAD_CADENCE", `Unknown cadence "${cadence}"`);
  }
  const domain = extractDomain(input.url);
  const [ownDomains, approved] = await Promise.all([
    workspaceOwnDomains(workspaceId),
    prisma.knowledgeSource.findMany({
      where: { workspaceId, domain, status: "active" },
      select: { domain: true },
    }),
  ]);
  const status = classifySourceDomain(
    domain,
    ownDomains,
    approved.map((a) => a.domain),
  );
  return prisma.knowledgeSource.create({
    data: {
      workspaceId,
      url: input.url.trim(),
      sourceType: input.sourceType,
      cadence,
      status,
      domain,
    },
  });
}

export async function approveSource(workspaceId: string, sourceId: string) {
  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, workspaceId },
  });
  if (!source) throw new KnowledgeSourceError("NOT_FOUND", "Knowledge source not found");
  if (source.status === "active") return source;
  return prisma.knowledgeSource.update({
    where: { id: sourceId },
    data: { status: "active" },
  });
}

export async function rejectSource(workspaceId: string, sourceId: string) {
  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, workspaceId },
  });
  if (!source) throw new KnowledgeSourceError("NOT_FOUND", "Knowledge source not found");
  return prisma.knowledgeSource.update({
    where: { id: sourceId },
    data: { status: "archived" },
  });
}

export async function listSources(workspaceId: string) {
  return prisma.knowledgeSource.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { jobs: true, chunks: true } },
    },
  });
}
