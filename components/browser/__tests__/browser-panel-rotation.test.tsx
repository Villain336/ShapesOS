// ShapesOS — BrowserPanel token-rotation behavior (real DOM, happy-dom).
// Pins the no-silent-reload amendment: when the status poll returns a
// ROTATED capability URL while a live document is mounted, the iframe src
// must NOT change (unsaved state survives); an explicit reload affordance
// appears; clicking it (and only that) advances the iframe to the new URL.
// Run: npx tsx --test --experimental-test-module-mocks components/browser/__tests__/browser-panel-rotation.test.tsx

import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const URL_A = "/api/projects/p1/dev-preview/3000/cap/TOKEN_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/";
const URL_B = "/api/projects/p1/dev-preview/3000/cap/TOKEN_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB/";

let currentUrl = URL_A;
let fetchCount = 0;

// DOM globals BEFORE importing react-dom / the component.
const window = new Window({ url: "http://localhost/dashboard/browser" });
for (const [k, v] of Object.entries({
  window, document: window.document, navigator: window.navigator,
  localStorage: window.localStorage, HTMLElement: window.HTMLElement,
  MouseEvent: window.MouseEvent,
})) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).fetch = async () => {
  fetchCount += 1;
  return {
    ok: true,
    json: async () => ({ status: "running", exposedPorts: [3000], previews: [{ port: 3000, url: currentUrl }] }),
  } as Response;
};

const LABELS = {
  newTab: "New tab", closeTab: "Close", project: "Project", pickProject: "Pick", port: "Port",
  openTab: "Open", start: "Start", starting: "Starting", resume: "Resume", resuming: "Resuming",
  pause: "Pause", paused: "Paused", none: "None", empty: "Empty", stopsItself: "Stops",
  sessionExpired: "Session expired", reloadPreview: "Reload preview",
};

describe("BrowserPanel token rotation", () => {
  let root: import("react-dom/client").Root;
  let container: HTMLElement;
  let act: typeof import("react").act;

  before(async () => {
    window.localStorage.setItem("shapes.dev-preview.tabs.v1", JSON.stringify([{ key: "p1:3000", projectId: "p1", port: 3000 }]));
    const React = await import("react");
    act = React.act;
    const { createRoot } = await import("react-dom/client");
    const { BrowserPanel } = await import("../BrowserPanel");
    container = window.document.createElement("div");
    window.document.body.appendChild(container);
    mock.timers.enable({ apis: ["setInterval"] });
    await act(async () => {
      root = createRoot(container);
      root.render(<BrowserPanel projects={[{ id: "p1", name: "proj" }]} labels={LABELS} />);
    });
  });
  after(async () => {
    await act(async () => root.unmount());
    mock.timers.reset();
  });

  const iframe = () => container.querySelector("iframe");
  const affordance = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reload preview")) ?? null;

  it("first load: iframe mounts on the issued capability URL, no affordance", () => {
    assert.ok(fetchCount >= 1, "status fetched");
    assert.equal(iframe()?.getAttribute("src"), URL_A);
    assert.equal(affordance() ?? null, null);
  });

  it("rotation while live: iframe src DOES NOT change; explicit affordance appears", async () => {
    currentUrl = URL_B; // next poll returns a rotated token
    await act(async () => { mock.timers.tick(5 * 60 * 1000); });
    assert.equal(iframe()?.getAttribute("src"), URL_A, "OLD document stays mounted (no silent reload)");
    assert.ok(affordance(), "expired-session reload affordance is shown");
  });

  it("explicit reload: advances to the rotated URL and clears the affordance", async () => {
    const btn = affordance();
    assert.ok(btn);
    await act(async () => { btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    assert.equal(iframe()?.getAttribute("src"), URL_B);
    assert.equal(affordance() ?? null, null);
  });

  it("stable token across later polls: src stays put, no affordance", async () => {
    await act(async () => { mock.timers.tick(5 * 60 * 1000); });
    assert.equal(iframe()?.getAttribute("src"), URL_B);
    assert.equal(affordance() ?? null, null);
  });
});
