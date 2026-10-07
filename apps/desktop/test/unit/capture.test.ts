import { describe, expect, it, vi } from "vitest";
import { CaptureMachine, fitScreenshots, type Shot } from "../../src/shared/capture-machine";

const shot = (n: number): Shot => ({ screen: n, width: 10, height: 10, scaleFactor: 1, primary: n === 0, jpegBase64: `img${n}` });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function machine(capture: () => Promise<Shot[]>) {
  const timers: { fn: () => void; ms: number }[] = [];
  const indicator = vi.fn();
  const m = new CaptureMachine({
    capture,
    indicator,
    refreshMs: 3000,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimer: (h) => {
      timers[h as number] = { fn: () => undefined, ms: 0 };
    },
  });
  return { m, timers, indicator };
}

describe("capture state machine", () => {
  it("never captures unless the key is held", async () => {
    const capture = vi.fn(async () => [shot(0)]);
    const { m, timers } = machine(capture);
    expect(capture).not.toHaveBeenCalled();
    await m.release(); // release without press
    timers.forEach((t) => t.fn());
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures on press, refreshes while held, stops on release", async () => {
    let n = 0;
    const capture = vi.fn(async () => [shot(n++)]);
    const { m, timers, indicator } = machine(capture);
    m.press({ allowed: true });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(indicator).toHaveBeenLastCalledWith(true);
    await new Promise((r) => setTimeout(r, 0));
    timers[0]!.fn(); // refresh tick while held
    expect(capture).toHaveBeenCalledTimes(2);
    const { shots } = await m.release();
    expect(shots).toEqual([shot(1)]);
    expect(indicator).toHaveBeenLastCalledWith(false);
    // After release the timer is cleared: even a stray tick does nothing.
    timers.forEach((t) => t.fn());
    expect(capture).toHaveBeenCalledTimes(2);
    expect(m.log.every((l) => l.state === "held")).toBe(true);
  });

  it("keeps a capture that started while held and finishes after release", async () => {
    const d = deferred<Shot[]>();
    const capture = vi.fn(() => d.promise);
    const { m } = machine(capture);
    m.press({ allowed: true });
    const released = m.release();
    expect(m.current).toBe("idle");
    d.resolve([shot(0)]);
    expect((await released).shots).toEqual([shot(0)]);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("captures nothing when blocked (excluded app) and reports why", async () => {
    const capture = vi.fn(async () => [shot(0)]);
    const { m, indicator } = machine(capture);
    m.press({ allowed: false, reason: "1Password is on your exclusion list" });
    const r = await m.release();
    expect(capture).not.toHaveBeenCalled();
    expect(indicator).not.toHaveBeenCalled();
    expect(r).toEqual({ shots: [], blockedReason: "1Password is on your exclusion list" });
  });

  it("discard forgets images and a late result never leaks into the next hold", async () => {
    const d = deferred<Shot[]>();
    const capture = vi.fn(() => d.promise);
    const { m } = machine(capture);
    m.press({ allowed: true });
    m.discard();
    d.resolve([shot(9)]);
    await new Promise((r) => setTimeout(r, 0));
    const r = await m.release();
    expect(r.shots).toEqual([]);
  });

  it("ignores key auto-repeat presses", () => {
    const capture = vi.fn(async () => [shot(0)]);
    const { m } = machine(capture);
    m.press({ allowed: true });
    m.press({ allowed: true });
    m.press({ allowed: true });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not touch the disk (no fs import in the capture path)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../../src/shared/capture-machine.ts", import.meta.url), "utf8");
    const main = fs.readFileSync(new URL("../../src/main/capture.ts", import.meta.url), "utf8");
    for (const s of [src, main]) expect(s).not.toMatch(/from "node:fs"|require\("fs"\)|from "fs"/);
  });
});

describe("fitScreenshots (≤ 4 images, ≤ 6 MB)", () => {
  const cand = (screen: number, dist: number, bytesAt: (q: number) => number) => ({
    screen,
    primary: screen === 0,
    cursorDistance: dist,
    encode: (q: number) => ({ jpegBase64: "x".repeat(bytesAt(q)), width: 100, height: 50, scaleFactor: 1 }),
  });

  it("keeps at most 4, the cursor's display first", () => {
    const shots = fitScreenshots(
      [0, 1, 2, 3, 4, 5].map((s) => cand(s, s === 5 ? 0 : s + 1, () => 10)),
      { maxScreenshots: 4, maxTotalBytes: 1000 },
    );
    expect(shots.map((s) => s.screen)).toEqual([0, 1, 2, 5]);
  });

  it("lowers quality until the total fits, then drops far displays", () => {
    const shots = fitScreenshots([cand(0, 0, (q) => q * 10), cand(1, 1, (q) => q * 10)], {
      maxScreenshots: 4,
      maxTotalBytes: 1000,
    });
    expect(shots.reduce((n, s) => n + s.jpegBase64.length, 0)).toBeLessThanOrEqual(1000);
    expect(shots).toHaveLength(2);
    const one = fitScreenshots([cand(0, 0, () => 900), cand(1, 1, () => 900)], { maxScreenshots: 4, maxTotalBytes: 1000 });
    expect(one.map((s) => s.screen)).toEqual([0]);
  });
});
