// Marketr — Phase 12 "embeds": server-only GrowthBook tenant overrides.
// Prisma-backed read/write for per-workspace flag overrides. NEVER import
// this from a client component — the pure merge helpers
// (applyFlagOverrides, EffectiveFeature) live in ./growthbook, which is
// safe for the browser bundle (GrowthBookProvider imports it).

import { prisma } from "@/lib/prisma";

/** All overrides for a workspace as key -> JSON value. */
export async function getWorkspaceFlagOverrides(
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const rows = await prisma.workspaceFlagOverride.findMany({
    where: { workspaceId },
    select: { key: true, value: true },
  });
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Upsert a workspace's override for one flag. */
export async function setWorkspaceFlagOverride(
  workspaceId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const jsonValue = value as never;
  await prisma.workspaceFlagOverride.upsert({
    where: { workspaceId_key: { workspaceId, key } },
    create: { workspaceId, key, value: jsonValue },
    update: { value: jsonValue },
  });
}

/** Clear a workspace's override (falls back to the GrowthBook default). */
export async function clearWorkspaceFlagOverride(
  workspaceId: string,
  key: string,
): Promise<void> {
  await prisma.workspaceFlagOverride
    .delete({ where: { workspaceId_key: { workspaceId, key } } })
    .catch(() => null);
}
