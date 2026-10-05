// ShapesOS — one export at a time per key (Phase 4a). An export reads every
// table a workspace owns; the read-tier rate limit (120/min) is far too loose
// for that. In-memory and single-instance, the same stance as the API rate
// limiter (lib/api/rate-limit.ts).

const running = new Set<string>();

/** Claim the slot for `key`; false when an export for it is already running. */
export function claimExportSlot(key: string): boolean {
  if (running.has(key)) return false;
  running.add(key);
  return true;
}

export function releaseExportSlot(key: string): void {
  running.delete(key);
}

/** Wrap a stream so the slot is released when it ends, errors or is cancelled. */
export function releasingStream(stream: ReadableStream<Uint8Array>, key: string): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      releaseExportSlot(key);
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
