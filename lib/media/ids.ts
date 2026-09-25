// Marketr — Phase 5 SAFETY: client-side id generation for raw-SQL inserts.
//
// The SQL stores (lib/media/db.ts) insert rows directly, so ids are minted
// here instead of relying on Prisma's cuid() default. Format matches cuid:
// "c" + base36 timestamp + random — unique enough for DB primary keys.

import { randomBytes } from "node:crypto";

export function createId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(9).toString("hex").slice(0, 16);
  return `c${ts}${rand}`.slice(0, 25);
}
