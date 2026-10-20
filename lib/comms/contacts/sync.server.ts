// ShapesOS — Phase 18.2 (WS=comms): when the address book syncs.
//
// The identity links are refreshed (lib/comms/contacts/store.ts
// syncContactIdentities) by the comms-contacts cron (every 30 minutes, every
// workspace) and, so a record created a minute ago is in the address book,
// when someone opens Contacts — at most once a minute per workspace per
// process (a second replica may sync again; the sync is idempotent).

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { syncContactIdentities, type SyncResult } from "./store";

const lastSync = new Map<string, number>();
const inFlight = new Map<string, Promise<SyncResult>>();
export const OPEN_SYNC_EVERY_MS = 60_000;

export async function syncWorkspaceContacts(workspaceId: string): Promise<SyncResult> {
  const running = inFlight.get(workspaceId);
  if (running) return running;
  const p = withWorkspaceScope(workspaceId, (tx) => syncContactIdentities(tx, workspaceId), { timeoutMs: 120_000 }).finally(() => {
    inFlight.delete(workspaceId);
    lastSync.set(workspaceId, Date.now());
  });
  inFlight.set(workspaceId, p);
  return p;
}

/** Sync when this process has not in the last minute (Contacts page / API open). Never throws. */
export async function ensureFreshContacts(workspaceId: string): Promise<void> {
  const at = lastSync.get(workspaceId) ?? 0;
  if (Date.now() - at < OPEN_SYNC_EVERY_MS) return;
  await syncWorkspaceContacts(workspaceId).catch((err) => {
    console.warn("[contacts] sync failed:", err instanceof Error ? err.message : err);
  });
}

/** Every workspace (cron). */
export async function syncAllContacts(workspaceIds: readonly string[]): Promise<{ workspaces: number; linked: number; suggested: number; errors: number }> {
  const out = { workspaces: 0, linked: 0, suggested: 0, errors: 0 };
  for (const ws of workspaceIds) {
    out.workspaces++;
    try {
      const r = await syncWorkspaceContacts(ws);
      out.linked += r.linked;
      out.suggested += r.suggested;
    } catch (err) {
      out.errors++;
      console.warn("[contacts] sync failed for a workspace:", err instanceof Error ? err.message : err);
    }
  }
  return out;
}
