// ShapesOS — one export at a time per key (Phase 4a). An export reads every
// table a workspace owns; the read-tier rate limit (120/min) is far too loose
// for that.
//
// Deploy PR: the slot is a lease in the shared counter store
// (lib/api/rate-limit-store.ts sharedWindowHit with limit 1), so a second
// export of the same workspace is refused on EVERY replica, not just the one
// running the first. The lease expires after EXPORT_LEASE_MS, so a replica
// that dies mid-export cannot hold the slot forever. A store error falls back
// to the per-process slot (the Phase 6 fail-open-to-local policy).

import { releaseSharedWindow, sharedWindowHit } from "@/lib/api/rate-limit-store";

/** Longest an export may hold its slot (a crashed replica's lease ends here). */
export const EXPORT_LEASE_MS = 30 * 60 * 1000;

const slotKey = (key: string) => `export-slot:${key}`;

/** Claim the slot for `key`; false when an export for it is already running. */
export async function claimExportSlot(key: string, now: number = Date.now()): Promise<boolean> {
  return (await sharedWindowHit(slotKey(key), { limit: 1, windowMs: EXPORT_LEASE_MS }, now)).allowed;
}

export async function releaseExportSlot(key: string): Promise<void> {
  await releaseSharedWindow(slotKey(key));
}

/** Wrap a stream so the slot is released when it ends, errors or is cancelled. */
export function releasingStream(stream: ReadableStream<Uint8Array>, key: string): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      void releaseExportSlot(key);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}
