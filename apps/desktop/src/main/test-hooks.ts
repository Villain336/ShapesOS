// TEST-ONLY HOOK (labelled; compiled out of production builds).
//
// Only `npm run build:test` defines __TEST_HOOKS__ = true; the production
// build's `if (__TEST_HOOKS__)` branch in index.ts is removed by esbuild, so
// this module is not even in the bundle (scripts/build.mjs asserts that).
// The Playwright smoke drives the app through globalThis.__shapesTestHook:
// it simulates holding the talk key, injects the transcript a microphone
// would have produced, fakes the focused app and the screen capture, and
// reads state back. Nothing here talks to a real provider.

import type { Shot } from "../shared/capture-machine";
import type { FocusedApp } from "../shared/exclusions";
import type { CursorController } from "./controller";
import type { OverlayManager } from "./overlay-manager";
import type { TrayController } from "./tray";
import type { SpeechIn, SpeechOut } from "./speech";
import type { HoldKeyService } from "./hold-key";
import { captureScreens } from "./capture";

export interface TestHookDeps {
  controller: CursorController;
  overlays: OverlayManager;
  tray: TrayController;
  speechOut: SpeechOut;
  speechIn: SpeechIn;
  holdKey: HoldKeyService;
  openSettings: () => void;
  openPalette: () => void;
}

export function installTestHooks(d: TestHookDeps): void {
  let captureCalls: { at: number; heldAtCall: boolean }[] = [];
  let held = false;
  let lastShots: { screen: number; width: number; height: number; scaleFactor: number; bytes: number }[] = [];
  const hook = {
    label: "TEST-ONLY HOOK: compiled out of production builds",
    /** Simulated talk key DOWN (as uiohook would deliver after the hold delay). */
    async holdDown(): Promise<void> {
      held = true;
      await d.controller.holdStart();
    },
    /** Simulated talk key UP. */
    async holdUp(): Promise<void> {
      held = false;
      await d.controller.holdEnd();
    },
    stop(): void {
      d.controller.stop();
    },
    /** What the microphone "heard" (bypasses STT). null = use the server's STT (the labelled mock here). */
    setTranscript(text: string | null): void {
      d.controller.testOverrides.transcript = text;
    },
    setFocusedApp(app: FocusedApp | null): void {
      d.controller.testOverrides.focusedApp = async () => app;
      d.controller.testOverrides.shapesFocused = false;
    },
    /** Treat the ShapesOS window as the app in front (Xvfb has no window manager to decide focus). */
    focusShapes(): void {
      d.controller.testOverrides.shapesFocused = true;
    },
    openSettings(): void {
      d.openSettings();
    },
    /** The spotlight hotkey's action (focus ShapesOS, open ⌘K). */
    openPalette(): void {
      d.openPalette();
    },
    /** The REAL desktopCapturer path, instrumented to record when each capture ran. */
    useRealCapture(): void {
      d.controller.testOverrides.capture = async (): Promise<Shot[]> => {
        captureCalls.push({ at: Date.now(), heldAtCall: held });
        const shots = await captureScreens("all");
        lastShots = shots.map((x) => ({ screen: x.screen, width: x.width, height: x.height, scaleFactor: x.scaleFactor, bytes: x.jpegBase64.length }));
        return shots;
      };
    },
    lastShots() {
      return lastShots;
    },
    /** A labelled fake capture: a tiny JPEG-shaped string per display, recording when it ran. */
    useFakeCapture(): void {
      d.controller.testOverrides.capture = async (): Promise<Shot[]> => {
        captureCalls.push({ at: Date.now(), heldAtCall: held });
        await new Promise((r) => setTimeout(r, 50));
        return [{ screen: 0, width: 1440, height: 900, scaleFactor: 1, primary: true, jpegBase64: "RkFLRS1KUEVHLVRFU1QtT05MWQ==" }];
      };
    },
    captureCalls(): { at: number; heldAtCall: boolean }[] {
      return captureCalls;
    },
    resetCaptureCalls(): void {
      captureCalls = [];
    },
    machineLog() {
      return d.controller.capture.log;
    },
    debug() {
      return d.controller.debug;
    },
    overlayStates() {
      return d.overlays.allStates();
    },
    async refreshTray() {
      return d.tray.refresh();
    },
    trayState() {
      return d.tray.state;
    },
    async typed(text: string) {
      await d.controller.typed(text);
    },
    async click(approvalId: string, decision: "approve" | "reject") {
      await d.controller.clickDecision(approvalId, decision);
    },
    speech() {
      return {
        provider: d.speechOut.provider,
        lastHeader: d.speechOut.lastProviderHeader,
        lastMock: d.speechOut.lastMock,
        sttTransport: d.speechIn.currentTransport,
        sttMock: d.speechIn.lastMock,
        sttError: d.speechIn.error,
      };
    },
    holdMode() {
      return { mode: d.holdKey.mode, error: d.holdKey.error };
    },
  };
  (globalThis as unknown as { __shapesTestHook: typeof hook }).__shapesTestHook = hook;
}
