// ShapesOS Desktop: the capture state machine.
//
// THE RULE: the screen is captured ONLY while the talk key is held.
//   * press (allowed)  → capture at once, then refresh every `refreshMs`
//                        while still held (the latest set wins);
//   * release          → no new capture ever starts; a capture already in
//                        flight (it started while held) may finish and is
//                        kept, so a quick press still has its press-time
//                        screen; the indicator turns off when nothing is in
//                        flight;
//   * press (blocked)  → the focused app is excluded, vision is not
//                        configured, or capture permission is missing:
//                        nothing is captured and the reason is reported.
// Images live only in memory: `release()` hands them to the turn and forgets
// them; there is no disk path in this module or its callers.

export interface Shot {
  screen: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
  jpegBase64: string;
}

export interface CaptureDeps {
  /** Takes one set of screenshots (desktopCapturer in production, a fake in tests). */
  capture: () => Promise<Shot[]>;
  /** Visible capture indicator on/off. */
  indicator: (on: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  refreshMs?: number;
  onError?: (e: unknown) => void;
}

export type CaptureState = "idle" | "held" | "blocked";

export interface PressOptions {
  allowed: boolean;
  /** Why not (shown and spoken): "1Password is on your exclusion list". */
  reason?: string;
}

export class CaptureMachine {
  private state: CaptureState = "idle";
  private generation = 0;
  private latest: Shot[] = [];
  private inFlight = 0;
  private inFlightPromise: Promise<void> | null = null;
  private timer: unknown = null;
  private blockedReason: string | null = null;
  /** Every capture start, for tests and the smoke (state at the time). */
  readonly log: { at: number; state: CaptureState }[] = [];

  constructor(private deps: CaptureDeps) {}

  get current(): CaptureState {
    return this.state;
  }

  get capturing(): boolean {
    return this.inFlight > 0;
  }

  press(opts: PressOptions): void {
    if (this.state === "held") return; // auto-repeat
    this.generation += 1;
    this.latest = [];
    if (!opts.allowed) {
      this.state = "blocked";
      this.blockedReason = opts.reason ?? "Capture is off.";
      return;
    }
    this.state = "held";
    this.blockedReason = null;
    this.shoot();
    const refresh = this.deps.refreshMs ?? 0;
    if (refresh > 0) {
      const set = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
      this.timer = set(() => this.shoot(), refresh);
    }
  }

  /** Key released: stop capturing; resolve with what was captured while held. */
  async release(): Promise<{ shots: Shot[]; blockedReason: string | null }> {
    const wasBlocked = this.state === "blocked";
    const reason = this.blockedReason;
    this.stopTimer();
    this.state = "idle";
    const gen = this.generation;
    if (this.inFlightPromise) await this.inFlightPromise.catch(() => undefined);
    // A new press during the wait owns the buffer now.
    if (gen !== this.generation) return { shots: [], blockedReason: null };
    const shots = this.latest;
    this.latest = [];
    this.blockedReason = null;
    return { shots: wasBlocked ? [] : shots, blockedReason: wasBlocked ? reason : null };
  }

  /** Forget everything (stop key, app quitting). */
  discard(): void {
    this.stopTimer();
    this.state = "idle";
    this.generation += 1;
    this.latest = [];
    this.blockedReason = null;
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      const clear = this.deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
      clear(this.timer);
      this.timer = null;
    }
  }

  private shoot(): void {
    // Never start a capture unless the key is held right now.
    if (this.state !== "held") return;
    if (this.inFlight > 0) return; // one at a time; the refresh catches up
    const gen = this.generation;
    this.log.push({ at: Date.now(), state: this.state });
    this.inFlight += 1;
    this.deps.indicator(true);
    const p = this.deps
      .capture()
      .then((shots) => {
        if (gen === this.generation) this.latest = shots;
      })
      .catch((e) => this.deps.onError?.(e))
      .finally(() => {
        this.inFlight -= 1;
        if (this.inFlight === 0) {
          this.inFlightPromise = null;
          this.deps.indicator(false);
        }
      });
    this.inFlightPromise = p;
  }
}

// ---------------------------------------------------------------------------
// Fit screenshots into the turn limits (≤ 4 images, ≤ 6 MB total)
// ---------------------------------------------------------------------------

export interface EncodableShot {
  screen: number;
  primary: boolean;
  /** Distance of this display from the cursor (0 = the cursor is on it). */
  cursorDistance: number;
  encode: (quality: number) => { jpegBase64: string; width: number; height: number; scaleFactor: number };
}

/**
 * Pick and encode screenshots under the limits: the display under the
 * cursor first, then the primary, then the nearest; lower the JPEG quality
 * step by step until the total base64 length fits; drop the farthest
 * displays if even the lowest quality does not.
 */
export function fitScreenshots(
  candidates: readonly EncodableShot[],
  limits: { maxScreenshots: number; maxTotalBytes: number },
  qualities: readonly number[] = [72, 60, 48, 36],
): Shot[] {
  const ordered = [...candidates].sort(
    (a, b) => a.cursorDistance - b.cursorDistance || Number(b.primary) - Number(a.primary) || a.screen - b.screen,
  );
  let pick = ordered.slice(0, limits.maxScreenshots);
  while (pick.length > 0) {
    for (const q of qualities) {
      const shots = pick.map((c) => ({ screen: c.screen, primary: c.primary, ...c.encode(q) }));
      const total = shots.reduce((n, s) => n + s.jpegBase64.length, 0);
      if (total <= limits.maxTotalBytes) return shots.sort((a, b) => a.screen - b.screen);
    }
    pick = pick.slice(0, -1);
  }
  return [];
}
