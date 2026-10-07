// ShapesOS Desktop smoke: the real Electron app (test build, with the
// labelled test-only hook) against the FAKE ShapesOS server fixture.
//
//   1. launch → the main window loads ShapesOS (fixture) with its cookie;
//      voice in through the server's labelled mock STT (SSE)
//   2. simulated hold-to-talk: capture happens only while held
//   3. a turn streams a `point` → the overlay pointer moves there (screenshot)
//      (+ an elementId point inside ShapesOS maps through the uiMap)
//   4. a Tier 1 proposal is approved by a simulated voice "yes"
//   5. a Tier 3 proposal ignores the voice "yes" and needs the click
//   6. agent mode creates a capped run
//   7. the tray count updates
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeServer } from "../fake-server";

const SHOTS = process.env.SHOTS_DIR ?? join(tmpdir(), "p19a-desktop-shots");
mkdirSync(SHOTS, { recursive: true });

let app: ElectronApplication;
let fake: Awaited<ReturnType<typeof startFakeServer>>;
let userData: string;

type Hook = Record<string, (...a: unknown[]) => unknown>;
async function hook<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
  return (await app.evaluate(
    async (_electron, { name, args }) => {
      const h = (globalThis as unknown as { __shapesTestHook: Hook }).__shapesTestHook;
      return await h[name]!(...args);
    },
    { name, args },
  )) as T;
}

async function windowByUrl(part: string, timeout = 20_000): Promise<Page> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const w = app.windows().find((p) => p.url().includes(part));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No window with ${part}: ${app.windows().map((w) => w.url()).join(", ")}`);
}

async function primaryOverlay(): Promise<Page> {
  const id = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id);
  return windowByUrl(`overlay.html?display=${id}`);
}

async function talk(transcript: string, holdMs = 300): Promise<void> {
  await hook("setTranscript", transcript);
  await hook("holdDown");
  await new Promise((r) => setTimeout(r, holdMs));
  await hook("holdUp");
}

test.beforeAll(async () => {
  fake = await startFakeServer();
  userData = mkdtempSync(join(tmpdir(), "shapes-desktop-smoke-"));
  app = await electron.launch({
    args: ["--no-sandbox", "--disable-gpu", "."],
    cwd: join(__dirname, "..", ".."),
    env: {
      ...process.env,
      SHAPES_TEST_SERVER_URL: fake.url,
      SHAPES_TEST_USER_DATA: userData,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    timeout: 60_000,
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  await fake?.close();
  rmSync(userData, { recursive: true, force: true });
});

test("ShapesOS Desktop against the fake server", async () => {
  // 1 ── launch: the main window loads ShapesOS (fixture) in persist:shapesos.
  const main = await windowByUrl(fake.url);
  await expect(main).toHaveTitle("FAKE ShapesOS (test fixture)");
  await main.screenshot({ path: join(SHOTS, "01-main-window.png") });
  const hookLabel = await app.evaluate(() => (globalThis as unknown as { __shapesTestHook: { label: string } }).__shapesTestHook.label);
  expect(hookLabel).toContain("TEST-ONLY HOOK");
  const tray0 = await hook<{ signedIn: boolean; needsYou: number }>("refreshTray");
  expect(tray0.signedIn).toBe(true); // the partition's cookie reached /api/approvals/count
  expect(tray0.needsYou).toBe(2);
  console.log("hold mode:", JSON.stringify(await hook("holdMode")));

  // Spotlight action: focus ShapesOS and open ⌘K through the preload bridge.
  await hook("openPalette");
  await expect(main.locator("#palette")).toHaveClass(/open/);

  // Voice in through the server's STT: the amended contract's labelled mock
  // (an SSE transcript at /api/cursor/mock-stt, read by the main process with
  // the signed-in session; no microphone under the mock).
  await hook("useFakeCapture");
  await hook("setFocusedApp", { name: "TextEdit" });
  fake.state.mockSttTranscript = "what does this button do";
  await hook("setTranscript", null);
  await hook("holdDown");
  await new Promise((r) => setTimeout(r, 1200));
  await hook("holdUp");
  await expect.poll(() => fake.state.turns.at(-1)?.transcript).toBe("what does this button do");
  expect(fake.state.sttStreams).toBe(1);
  expect(fake.state.talkSeconds.at(-1)).toBeGreaterThanOrEqual(1); // talkSeconds rides with the turn
  const sp = await hook<{ sttTransport: string; sttMock: boolean }>("speech");
  expect(sp).toMatchObject({ sttTransport: "main-sse", sttMock: true });

  // 2 ── hold-to-talk: capture only while held (real desktopCapturer under Xvfb).
  await hook("useRealCapture");
  await hook("setFocusedApp", { name: "TextEdit", title: "notes.txt" });
  await hook("resetCaptureCalls");
  const overlay = await primaryOverlay();
  await hook("setTranscript", "point at the corner");
  await hook("holdDown");
  const heldAt = Date.now();
  // Held for ~4.5 s: the press-time capture plus one refresh (every 4 s).
  await new Promise((r) => setTimeout(r, 4500));
  const duringHold = await hook<{ at: number; heldAtCall: boolean }[]>("captureCalls");
  await hook("holdUp");
  const releasedAt = Date.now();
  await new Promise((r) => setTimeout(r, 5000)); // past another refresh interval
  const afterRelease = await hook<{ at: number; heldAtCall: boolean }[]>("captureCalls");
  console.log("capture calls:", JSON.stringify(afterRelease.map((c) => ({ msAfterPress: c.at - heldAt, held: c.heldAtCall }))));
  console.log("last shots:", JSON.stringify(await hook("lastShots")));
  expect(duringHold.length).toBeGreaterThanOrEqual(2);
  expect(afterRelease.length).toBe(duringHold.length); // nothing after release
  expect(afterRelease.every((c) => c.heldAtCall && c.at < releasedAt)).toBe(true);
  expect(fake.state.turns.at(-1)).toMatchObject({ transcript: "point at the corner", app: "TextEdit" });
  expect(fake.state.turns.at(-1)!.screenshots).toBeGreaterThanOrEqual(1);

  // Excluded app: nothing captured, and the turn says so.
  await hook("resetCaptureCalls");
  await hook("setFocusedApp", { name: "1Password" });
  await talk("what is this", 600);
  expect(await hook<unknown[]>("captureCalls")).toHaveLength(0);
  expect(fake.state.turns.at(-1)).toMatchObject({ transcript: "what is this", screenshots: 0, app: "1Password" });
  const dbg1 = await hook<{ captions: string[] }>("debug");
  expect(dbg1.captions.some((c) => c.includes("1Password is on your exclusion list"))).toBe(true);

  // 3 ── the turn's `point { screen: 0, x: 400, y: 300 }` moved the overlay pointer.
  await hook("setFocusedApp", { name: "TextEdit" });
  await talk("point at the corner");
  const pointer = overlay.getByTestId("pointer");
  await expect(pointer).toHaveAttribute("data-x", "400");
  await expect(pointer).toHaveAttribute("data-y", "300");
  await expect(overlay.getByTestId("mark-circle")).toBeVisible();
  await expect(overlay.getByTestId("mark-arrow")).toBeVisible();
  await expect(overlay.getByTestId("mark-step")).toBeVisible();
  await overlay.waitForTimeout(700); // let the flight finish
  await overlay.screenshot({ path: join(SHOTS, "03-overlay-point-and-draw.png") });
  const box = await pointer.boundingBox();
  expect(Math.round(box!.x)).toBe(398); // arrow tip offset (2, 2) lands on (400, 300)
  expect(Math.round(box!.y)).toBe(298);

  // Inside ShapesOS: `point { elementId }` maps through the uiMap + window bounds.
  await hook("focusShapes");
  await talk("where do I approve a pay run?");
  expect(fake.state.turns.at(-1)!.uiMap).toBeGreaterThanOrEqual(3);
  expect(fake.state.turns.at(-1)!.app).toBe("ShapesOS");
  const rect = await main.locator('[data-cursor-id="nav:/dashboard/approvals"]').boundingBox();
  const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http"))!;
    const d = screen.getDisplayMatching(w.getBounds());
    return { content: w.getContentBounds(), display: d.bounds, displayId: d.id, zoom: w.webContents.getZoomFactor() };
  });
  const expectX = Math.round(bounds.content.x + (rect!.x + rect!.width / 2) * bounds.zoom - bounds.display.x);
  const expectY = Math.round(bounds.content.y + (rect!.y + rect!.height / 2) * bounds.zoom - bounds.display.y);
  const elOverlay = await windowByUrl(`overlay.html?display=${bounds.displayId}`);
  await expect(elOverlay.getByTestId("pointer")).toHaveAttribute("data-x", String(expectX));
  await expect(elOverlay.getByTestId("pointer")).toHaveAttribute("data-y", String(expectY));
  await elOverlay.waitForTimeout(700);
  await elOverlay.screenshot({ path: join(SHOTS, "03b-overlay-element-point.png") });
  await hook("setFocusedApp", { name: "TextEdit" });

  // 4 ── Tier 1 proposal approved by a simulated voice "yes".
  await talk("draft an invoice for Acme for $200");
  const card1 = overlay.getByTestId("proposal");
  await expect(card1).toHaveAttribute("data-voice", "true");
  await expect(overlay.getByTestId("proposal-hint")).toHaveText("Say yes or no, or click.");
  await overlay.screenshot({ path: join(SHOTS, "04-tier1-proposal.png") });
  const t1 = await card1.getAttribute("data-approval");
  await talk("yes");
  await expect(card1).toHaveAttribute("data-status", "approved");
  expect(fake.state.approvals.find((a) => a.approvalId === t1)).toMatchObject({ decision: "approve", via: "voice", status: 200 });
  await overlay.waitForTimeout(2200); // the approved card clears

  // 5 ── Tier 3 proposal: voice "yes" is ignored, the click approves.
  await talk("run payroll for October");
  const card3 = overlay.getByTestId("proposal");
  await expect(card3).toHaveAttribute("data-voice", "false");
  const t3 = (await card3.getAttribute("data-approval"))!;
  await expect(overlay.getByTestId("proposal-hint")).toHaveText("Click to approve; voice can't approve this.");
  await talk("yes");
  const dbg = await hook<{ voiceIgnored: { approvalId: string }[] }>("debug");
  expect(dbg.voiceIgnored.map((v) => v.approvalId)).toContain(t3);
  expect(fake.state.approvals.filter((a) => a.approvalId === t3)).toHaveLength(0); // nothing was sent
  await expect(card3).toHaveAttribute("data-status", "pending");
  await overlay.screenshot({ path: join(SHOTS, "05-tier3-proposal-voice-ignored.png") });
  await overlay.getByTestId("approve").click();
  await expect(card3).toHaveAttribute("data-status", "approved");
  expect(fake.state.approvals.find((a) => a.approvalId === t3)).toMatchObject({ decision: "approve", via: "click", status: 200 });

  // 6 ── agent mode creates a capped run, tracked to "done".
  await talk("research our competitors in the background, max $3");
  await expect.poll(() => fake.state.agents.length).toBe(1);
  expect(fake.state.agents[0]).toMatchObject({ goal: "research our competitors", maxUsd: 3 });
  await expect
    .poll(async () => (await hook<{ background: { status: string }[] }>("trayState")).background[0]?.status, { timeout: 15_000 })
    .toBe("done");

  // 7 ── the tray count updates.
  fake.state.needsYou = 4;
  const tray = await hook<{ needsYou: number; title: string; tooltip: string; running: unknown[] }>("refreshTray");
  expect(tray.needsYou).toBe(4);
  expect(tray.title).toBe("4");
  expect(tray.tooltip).toContain("4 need you");
  console.log("tray:", JSON.stringify(tray));

  // Speech out went through the labelled mock (X-Shapes-Mock: 1).
  console.log("speech:", JSON.stringify(await hook("speech")), "tts requests:", fake.state.tts);
  expect(fake.state.tts).toBeGreaterThan(0);

  // Settings window, light and dark.
  await hook("openSettings");
  const settings = await windowByUrl("settings.html");
  await expect(settings.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(settings.getByText("Fixture voice (mock)")).toBeVisible();
  // Voice choice comes from the server (GET/PUT /api/cursor/voices).
  const voice = settings.locator("select#voice");
  await expect(voice.locator("option", { hasText: "Verse (fixture)" })).toHaveCount(1);
  await voice.selectOption("fixture-verse");
  await expect.poll(() => fake.state.voice?.id).toBe("fixture-verse");
  await settings.emulateMedia({ colorScheme: "light" });
  await settings.screenshot({ path: join(SHOTS, "08-settings-light.png"), fullPage: true });
  await settings.emulateMedia({ colorScheme: "dark" });
  await settings.screenshot({ path: join(SHOTS, "08-settings-dark.png"), fullPage: true });
});
