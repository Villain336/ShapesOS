// ShapesOS Desktop: the preload for the ShapesOS page (remote content).
//
// Sandboxed + contextIsolation: the page never sees Node or ipcRenderer.
// The bridge is minimal and only active on the configured ShapesOS origin:
//   * getUiMap — main asks; we call the page's window.__shapesUiMap() in the
//     MAIN world (webFrame.executeJavaScript) and send the entries back;
//   * open ⌘K — dispatch the page's own ⌘K / Ctrl+K shortcut;
//   * notifications — window.shapesDesktop.notify({ title, body, href }).

import { contextBridge, ipcRenderer, webFrame } from "electron";

const CH = {
  getUiMap: "page:get-ui-map",
  uiMap: "page:ui-map",
  openPalette: "page:open-palette",
  notify: "page:notify",
} as const;

const originArg = process.argv.find((a) => a.startsWith("--shapes-origin="));
const allowedOrigin = originArg ? originArg.slice("--shapes-origin=".length) : null;
const onShapes = () => allowedOrigin !== null && window.location.origin === allowedOrigin;

ipcRenderer.on(CH.getUiMap, async (_e, msg: { id: number }) => {
  let entries: unknown = null;
  if (onShapes()) {
    try {
      entries = await webFrame.executeJavaScript(
        "(typeof window.__shapesUiMap === 'function') ? window.__shapesUiMap() : null",
        false,
      );
    } catch {
      entries = null;
    }
  }
  ipcRenderer.send(CH.uiMap, { id: msg.id, entries });
});

ipcRenderer.on(CH.openPalette, (_e, msg: { mac: boolean }) => {
  if (!onShapes()) return;
  const init: KeyboardEventInit = { key: "k", code: "KeyK", bubbles: true, cancelable: true };
  if (msg.mac) init.metaKey = true;
  else init.ctrlKey = true;
  (document.activeElement ?? document.body ?? document).dispatchEvent(new KeyboardEvent("keydown", init));
});

contextBridge.exposeInMainWorld("shapesDesktop", {
  isDesktop: true,
  platform: process.platform,
  notify(n: { title: string; body?: string; href?: string }): void {
    if (!onShapes() || !n || typeof n.title !== "string") return;
    ipcRenderer.send(CH.notify, {
      title: n.title.slice(0, 120),
      body: typeof n.body === "string" ? n.body.slice(0, 300) : undefined,
      href: typeof n.href === "string" ? n.href.slice(0, 300) : undefined,
    });
  },
});
