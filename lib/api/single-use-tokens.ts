// ShapesOS — single-use confirmation tokens shared by every app instance
// (Deploy PR, WS=state).
//
// A token is issued by one request (say, a domain purchase preview on web
// replica A) and must be accepted exactly once by a later request that may
// land on any replica (the confirm on replica B), within its TTL. The
// per-process Maps this replaces could not do either across replicas.
//
//   issue()   → a random 192-bit token; only sha256(token) is stored, with the
//               workspace, a purpose label, a JSON payload and an expiry.
//   consume() → ONE statement: DELETE … WHERE token_hash AND purpose RETURNING,
//               under the workspace GUC (FORCE RLS). The first caller gets the
//               payload; a replay — or the loser of a concurrent double
//               confirm — finds nothing ("invalid"). An expired token is
//               consumed too and reported as "expired".
//
// Store selection: Postgres (table single_use_tokens) whenever DATABASE_URL
// is set; otherwise an in-process store with the same semantics (unit tests,
// scripts with a mocked database, a dev box without Postgres).

import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

export type ConsumeResult =
  | { status: "ok"; payload: Record<string, unknown>; expiresAt: Date }
  | { status: "expired" }
  | { status: "invalid" };

export interface IssueInput {
  workspaceId: string;
  /** What the token confirms, e.g. "studio_domain_purchase". */
  purpose: string;
  payload: Record<string, unknown>;
  expiresAt: Date;
}

export interface SingleUseTokenStore {
  readonly kind: "postgres" | "memory";
  issue(input: IssueInput): Promise<string>;
  consume(input: { workspaceId: string; purpose: string; token: string }): Promise<ConsumeResult>;
}

/** The stored form of a token: never the token itself. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/** Shape check before any lookup (cheap rejection of garbage input). */
function plausibleToken(token: unknown): token is string {
  return typeof token === "string" && token.length >= 16 && token.length <= 256;
}

export function postgresSingleUseTokens(): SingleUseTokenStore {
  // Lazy so loading this module never loads Prisma (proxy, unit tests).
  const scope = async <T>(workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    const { withWorkspaceScope } = await import("@/lib/substrate/memory/rls");
    return withWorkspaceScope(workspaceId, fn);
  };
  return {
    kind: "postgres",
    async issue(input) {
      const token = newToken();
      await scope(input.workspaceId, async (tx) => {
        // Opportunistic sweep: this workspace's expired tokens go first.
        await tx.singleUseToken.deleteMany({ where: { workspaceId: input.workspaceId, expiresAt: { lt: new Date() } } });
        await tx.singleUseToken.create({
          data: {
            tokenHash: hashToken(token),
            workspaceId: input.workspaceId,
            purpose: input.purpose,
            payload: input.payload as Prisma.InputJsonValue,
            expiresAt: input.expiresAt,
          },
        });
      });
      return token;
    },
    async consume({ workspaceId, purpose, token }) {
      if (!plausibleToken(token)) return { status: "invalid" };
      const rows = await scope(workspaceId, (tx) =>
        tx.$queryRaw<Array<{ payload: unknown; expires_at: Date }>>`
          DELETE FROM "single_use_tokens"
           WHERE "token_hash" = ${hashToken(token)} AND "purpose" = ${purpose} AND "workspace_id" = ${workspaceId}
       RETURNING "payload", "expires_at"`,
      );
      const row = rows[0];
      if (!row) return { status: "invalid" };
      const expiresAt = new Date(row.expires_at);
      if (expiresAt.getTime() < Date.now()) return { status: "expired" };
      return { status: "ok", payload: (row.payload ?? {}) as Record<string, unknown>, expiresAt };
    },
  };
}

export interface MemorySingleUseTokenStore extends SingleUseTokenStore {
  /** Synchronous issue (test seams that seed a token). */
  issueSync(input: IssueInput): string;
}

export function memorySingleUseTokens(): MemorySingleUseTokenStore {
  const rows = new Map<string, { workspaceId: string; purpose: string; payload: Record<string, unknown>; expiresAt: Date }>();
  const issueSync = (input: IssueInput) => {
    const now = Date.now();
    for (const [k, v] of rows) if (v.expiresAt.getTime() < now) rows.delete(k);
    const token = newToken();
    rows.set(hashToken(token), { workspaceId: input.workspaceId, purpose: input.purpose, payload: input.payload, expiresAt: input.expiresAt });
    return token;
  };
  return {
    kind: "memory",
    issueSync,
    async issue(input) {
      return issueSync(input);
    },
    async consume({ workspaceId, purpose, token }) {
      if (!plausibleToken(token)) return { status: "invalid" };
      const key = hashToken(token);
      const row = rows.get(key);
      if (!row || row.workspaceId !== workspaceId || row.purpose !== purpose) return { status: "invalid" };
      rows.delete(key);
      if (row.expiresAt.getTime() < Date.now()) return { status: "expired" };
      return { status: "ok", payload: row.payload, expiresAt: row.expiresAt };
    },
  };
}

/** Postgres when a database is configured, the in-process store otherwise. */
export function sharedSingleUseTokens(env: NodeJS.ProcessEnv = process.env): SingleUseTokenStore {
  return env.DATABASE_URL?.trim() ? postgresSingleUseTokens() : memorySingleUseTokens();
}
