// ShapesOS Desktop: put dictated text into the focused app.
//
// The overlay never takes focus (focusable: false), so the app the person was
// typing in keeps it. We send the platform paste keystroke with uiohook-napi
// (keyTap V with Meta/Ctrl). On macOS that needs Accessibility; without it
// (or without uiohook) canPaste() is false and the text is only copied.

import { clipboard, ClipboardItem, systemPreferences } from "electron";
import type { ClipboardPort, PastePort } from "../shared/dictation";
import { loadUiohook } from "./hold-key";

type Snapshot = Record<string, Blob | string>[];

/**
 * Electron 44's async clipboard. The snapshot copies every MIME type of
 * every item (text, HTML, RTF, images, files) so restore() puts back exactly
 * what the person had.
 */
export const electronClipboard: ClipboardPort<Snapshot> = {
  async snapshot(): Promise<Snapshot> {
    const items = await clipboard.read().catch(() => []);
    const out: Snapshot = [];
    for (const item of items) {
      const rec: Record<string, Blob | string> = {};
      for (const type of item.types) {
        try {
          const v = await item.getType(type);
          if (v instanceof Blob) rec[type] = v;
        } catch {
          /* a type the platform can't hand back */
        }
      }
      if (Object.keys(rec).length) out.push(rec);
    }
    return out;
  },
  async restore(s: Snapshot): Promise<void> {
    if (!s.length) {
      await clipboard.clear();
      return;
    }
    await clipboard.write(s.map((rec) => new ClipboardItem(rec)));
  },
  writeText: (text) => clipboard.writeText(text),
  readText: () => clipboard.readText(),
};

export function pastePort(platform = process.platform): PastePort {
  return {
    canPaste(): boolean {
      if (platform === "darwin" && !systemPreferences.isTrustedAccessibilityClient(false)) return false;
      return loadUiohook() !== null;
    },
    async paste(): Promise<void> {
      const h = loadUiohook();
      if (!h) throw new Error("No key injector");
      const mod = platform === "darwin" ? h.UiohookKey.Meta : h.UiohookKey.Ctrl;
      const v = h.UiohookKey.V;
      if (mod === undefined || v === undefined) throw new Error("Unknown key codes");
      h.uIOhook.keyTap(v, [mod]);
    },
  };
}
