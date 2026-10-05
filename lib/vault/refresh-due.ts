// ShapesOS — the connector token refresh sweep (cron body of
// POST /api/cron/connector-refresh; lifted out of the route in Phase 14 so it
// can be tested against one workspace).
//
// Due connections: status=active with a credential whose expiresAt is
// within 15 minutes (or already passed), OR status=active with a credential
// that has no expiresAt and a lastRefreshAt older than 24h (stale — some
// providers omit expires_in).
//
// Phase 14 fix: the stale branch only refreshes credentials that CAN be
// renewed (renewableWithoutExpiry). Before, every API-key connection
// (WordPress, Resend, DataForSEO, …) and every non-expiring OAuth token
// without a refresh token matched it, and refreshConnection — finding no
// refresh token — flipped the working connection to needs_reauth on the
// first cron tick after it was connected.

import { prisma } from "@/lib/prisma";
import { getDecryptedCredential, refreshConnection, renewableWithoutExpiry, type RefreshDeps } from "./refresh";

const REFRESH_WINDOW_MS = 15 * 60 * 1000;
const STALE_REFRESH_MS = 24 * 60 * 60 * 1000;

export interface RefreshSweepResult {
  checked: number;
  refreshed: number;
  needsReauth: number;
  /** stale-branch matches with nothing to renew (left untouched) */
  skipped: number;
  errors: { connectionId: string; error: string }[];
}

export async function refreshDueConnections(
  opts: { now?: number; deps?: RefreshDeps; /** tests: limit the sweep to one workspace */ workspaceId?: string } = {},
): Promise<RefreshSweepResult> {
  const now = opts.now ?? Date.now();
  const due = await prisma.connectorConnection.findMany({
    where: {
      status: "active",
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      OR: [
        { credential: { expiresAt: { lte: new Date(now + REFRESH_WINDOW_MS) } } },
        {
          credential: { expiresAt: null },
          OR: [{ lastRefreshAt: null }, { lastRefreshAt: { lte: new Date(now - STALE_REFRESH_MS) } }],
        },
      ],
    },
    select: { id: true, connectorKey: true, credential: { select: { expiresAt: true } } },
  });

  const result: RefreshSweepResult = { checked: due.length, refreshed: 0, needsReauth: 0, skipped: 0, errors: [] };
  for (const conn of due) {
    try {
      if (!conn.credential?.expiresAt) {
        const cred = await getDecryptedCredential(conn.id);
        if (!(await renewableWithoutExpiry(conn.connectorKey, cred?.payload))) {
          result.skipped += 1;
          continue;
        }
      }
      const outcome = await refreshConnection(conn.id, opts.deps);
      if (outcome === "refreshed") result.refreshed += 1;
      else result.needsReauth += 1;
    } catch (err) {
      result.errors.push({ connectionId: conn.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
