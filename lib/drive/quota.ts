// ShapesOS — Phase 21B (WS=drive): quota maths (PURE).
//
// The workspace keeps its one total (workspace_quotas). On top, two kinds of
// scope can carry their own limit: a person's private home ("user:<id>") and
// an app install's container ("app:<appId>/<install>"). A write is charged to
// the workspace AND to its scope; it must fit both. A null scope limit means
// "no separate limit" (only the workspace total applies). Freeing space is
// always allowed. The DB layer applies this under row locks (service.ts).

export const DEFAULT_APP_QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB per app install

export interface QuotaScopeRef {
  kind: "user" | "app";
  key: string;
}

export function quotaScopesFor(p: { ownerUserId: string | null; app: { appId: string; install: string } | null }): QuotaScopeRef[] {
  if (p.ownerUserId) return [{ kind: "user", key: `user:${p.ownerUserId}` }];
  if (p.app) return [{ kind: "app", key: `app:${p.app.appId}/${p.app.install}` }];
  return [];
}

export type QuotaVerdict = { ok: true } | { ok: false; scope: string; limit: number; used: number; over: number };

export function checkQuotaChange(input: {
  workspace: { limit: number; used: number };
  scopes: Array<{ key: string; limit: number | null; used: number }>;
  delta: number;
}): QuotaVerdict {
  if (input.delta <= 0) return { ok: true };
  const w = input.workspace;
  if (w.used + input.delta > w.limit) return { ok: false, scope: "workspace", limit: w.limit, used: w.used, over: w.used + input.delta - w.limit };
  for (const s of input.scopes) {
    if (s.limit !== null && s.used + input.delta > s.limit) return { ok: false, scope: s.key, limit: s.limit, used: s.used, over: s.used + input.delta - s.limit };
  }
  return { ok: true };
}

/** The per-upload cap is quota-governed: the hard maximum, or the room left if that is smaller. */
export function uploadLimitBytes(input: { hardMax: number; room: number }): number {
  return Math.max(0, Math.min(input.hardMax, input.room));
}
