// Marketr — Prisma client singleton (spec §11 tech approach).
// One client per process in prod, reused across HMR in dev.
//
// Phase 17 (latency): DATABASE_POOL_SIZE sets the connection pool of this
// process (Prisma's `connection_limit`) when the URL does not already carry
// one. Default (unset): Prisma's own (num_cpus × 2 + 1). Size it so that
// (web replicas + workers) × pool stays under the database's connection
// limit. Behind PgBouncer in transaction mode see docs/deploy/RENDER.md §6
// ("Connections") — the URL then also needs `pgbouncer=true`.

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/** The datasource URL with DATABASE_POOL_SIZE applied (null = leave Prisma's default). PURE. */
export function pooledDatabaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.DATABASE_URL?.trim();
  const size = Number((env.DATABASE_POOL_SIZE ?? "").trim());
  if (!url || !Number.isInteger(size) || size < 1) return null;
  if (/[?&]connection_limit=/.test(url)) return null;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${Math.min(size, 500)}`;
}

function createClient(): PrismaClient {
  const url = pooledDatabaseUrl();
  return url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
