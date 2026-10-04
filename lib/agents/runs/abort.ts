// ShapesOS — Phase 5: in-process abort handles for live agent runs.
//
// The agent loop registers an AbortController per run while it works; Stop
// (requestAgentRunCancel) records the request in the database AND aborts the
// controller here when the run lives in this process, so an in-flight model
// call ends at once instead of after it returns. A run in another process
// stops at its next step, when it polls isAgentRunCancelRequested().

const controllers = new Map<string, AbortController>();

/** Register (or reuse) the controller for a run; returns its signal. */
export function registerRunAbort(runId: string): AbortSignal {
  let c = controllers.get(runId);
  if (!c) {
    c = new AbortController();
    controllers.set(runId, c);
  }
  return c.signal;
}

/** Abort the run's in-flight work in this process. True when it was live here. */
export function abortRun(runId: string, reason = "Stopped by the user"): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  if (!c.signal.aborted) c.abort(new RunStoppedError(reason));
  return true;
}

/** Forget a finished run's controller. */
export function releaseRunAbort(runId: string): void {
  controllers.delete(runId);
}

/** Thrown into the loop when a run is stopped. */
export class RunStoppedError extends Error {
  constructor(message = "Stopped by the user") {
    super(message);
    this.name = "RunStoppedError";
  }
}

export function isRunStopped(err: unknown): boolean {
  if (err instanceof RunStoppedError) return true;
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    return name === "AbortError" || name === "RunStoppedError";
  }
  return false;
}
