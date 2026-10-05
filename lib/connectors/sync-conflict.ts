// ShapesOS — Phase 11: the one two-way sync conflict rule (PURE).
//
// Shared by the HubSpot CRM sync (lib/hubspot/sync.ts, wave A) and the
// commerce / accounting connectors (lib/bizsync/*, Phase 11 bizsync), so the
// rule is written — and tested — once:
//
//   - only the remote side changed → a pull applies the remote values;
//   - only the local side changed  → a pull leaves the record ("local_ahead";
//                                    a push sends it);
//   - both changed                 → LAST WRITER WINS by timestamp: the side
//                                    with the newer updatedAt is kept, and the
//                                    pull reports it as a conflict either way;
//   - neither changed              → nothing to do.
//
// What "changed" means is the caller's business (HubSpot compares updatedAt
// with the value remembered at the last sync; bizsync compares a fingerprint
// of the mapped local fields, so a stock move that bumps a product's
// updatedAt is not a catalogue edit). A first match (no link yet) is "both
// changed".

export type SyncDecision = "apply" | "skip_unchanged" | "local_ahead" | "conflict_remote_wins" | "conflict_local_wins";

export function decideSync(input: { remoteChanged: boolean; localChanged: boolean; remoteAt: Date; localAt: Date }): SyncDecision {
  const { remoteChanged, localChanged } = input;
  if (remoteChanged && !localChanged) return "apply";
  if (!remoteChanged && localChanged) return "local_ahead";
  if (!remoteChanged && !localChanged) return "skip_unchanged";
  return input.remoteAt.getTime() >= input.localAt.getTime() ? "conflict_remote_wins" : "conflict_local_wins";
}

/**
 * Whether a push may overwrite the remote record: always when the remote side
 * has not changed since the last sync (or there is no link yet, or force);
 * over a newer remote change only when the local record is newer still.
 */
export function pushAllowedByChanges(input: { linked: boolean; remoteChanged: boolean; remoteAt: Date | null; localAt: Date; force: boolean }): boolean {
  if (input.force || !input.linked || !input.remoteAt) return true;
  if (!input.remoteChanged) return true;
  return input.localAt.getTime() > input.remoteAt.getTime();
}
