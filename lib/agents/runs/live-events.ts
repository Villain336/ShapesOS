// ShapesOS — Phase 17 (latency): the in-process run-event bus.
//
// Before: a streamed model delta went model → run-event row → the AG-UI
// adapter's 200 ms database poll → SSE. This bus removes the poll from the
// common case: appendAgentRunEvent (lib/agents/runs/service.ts) publishes
// every event it wrote, with its seq, to the listeners of that run IN THIS
// PROCESS, so the chat stream forwards it the moment the row is durable.
//
// The database write stays — it is the durability and hand-off path: a turn
// handed to the worker, or a stream resumed on another replica, is tailed
// from the rows exactly as before (lib/agents/agui/adapter.ts keeps its poll
// as the fallback and uses it whenever no producer for the run lives here).
//
//   claimRunProducer(runId)   the loop that runs the run registers itself
//                             (runTrackedAgentTurn / continueTrackedAgentTurn)
//                             so a tail in this process knows the bus is live
//                             and can stop polling; released when it ends
//   hasRunProducer(runId)     is the run's loop running in this process?
//   subscribeRunEvents(id,fn) events as they are written, in write order,
//                             each with its seq (the tail applies them in
//                             seq order and fills a gap from the database)
//   publishRunEvent(id, ev)   called by the service after the insert
//
// Bounded: a run's listener set is dropped when its last listener leaves,
// producers are released in a finally. One registry per process even if the
// module is bundled twice (route code and instrumentation can be separate
// module graphs in Next), the same trick as lib/runtime/shutdown.ts.

export interface LiveRunEvent {
  seq: number;
  type: string;
  summary: string;
  payload: unknown;
}

export type LiveRunListener = (event: LiveRunEvent) => void;

interface Registry {
  listeners: Map<string, Set<LiveRunListener>>;
  producers: Map<string, number>;
}

const KEY = Symbol.for("shapesos.agents.runs.live-events");
const g = globalThis as unknown as Record<symbol, Registry | undefined>;
const reg: Registry = (g[KEY] ??= { listeners: new Map(), producers: new Map() });

/** Subscribe to a run's events as this process writes them. Returns the unsubscribe. */
export function subscribeRunEvents(runId: string, listener: LiveRunListener): () => void {
  let set = reg.listeners.get(runId);
  if (!set) {
    set = new Set();
    reg.listeners.set(runId, set);
  }
  set.add(listener);
  return () => {
    const cur = reg.listeners.get(runId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) reg.listeners.delete(runId);
  };
}

/** Deliver one written event to the run's listeners (never throws into the writer). */
export function publishRunEvent(runId: string, event: LiveRunEvent): void {
  const set = reg.listeners.get(runId);
  if (!set || set.size === 0) return;
  for (const l of [...set]) {
    try {
      l(event);
    } catch {
      // A listener's failure is its own; the writer carries on.
    }
  }
}

/** The run's loop runs here: its events reach this process's bus. Returns the release. */
export function claimRunProducer(runId: string): () => void {
  reg.producers.set(runId, (reg.producers.get(runId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (reg.producers.get(runId) ?? 1) - 1;
    if (n <= 0) reg.producers.delete(runId);
    else reg.producers.set(runId, n);
  };
}

/** Is the run's loop running in this process (so its events arrive on the bus)? */
export function hasRunProducer(runId: string): boolean {
  return (reg.producers.get(runId) ?? 0) > 0;
}

/** How many listeners a run has here (tests, diagnostics). */
export function runListenerCount(runId: string): number {
  return reg.listeners.get(runId)?.size ?? 0;
}

/** Test seam: forget every listener and producer. */
export function _resetLiveRunEventsForTests(): void {
  reg.listeners.clear();
  reg.producers.clear();
}
