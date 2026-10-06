// ShapesOS Desktop: put dictated text into the focused app.
//
// The overlay never takes focus (focusable: false), so the app the person was
// typing in keeps it. We send the platform paste keystroke with uiohook-napi
// (keyTap V with Meta/Ctrl). On macOS that needs Accessibility; without it
// (or without uiohook) canPaste() is false and the text is only copied.

import { clipboard, nativeImage, systemPreferences } from "electron";
import type { ClipboardPort, ClipboardSnapshot, PastePort } from "../shared/dictation";
import { loadUiohook } from "./hold-key";

export const electronClipboard: ClipboardPort = {
  snapshot(): ClipboardSnapshot {
    const img = clipboard.readImage();
    return {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: img.isEmpty() ? null : new Uint8Array(img.toPNG()),
    };
  },
  restore(s: ClipboardSnapshot): void {
    clipboard.write({
      text: s.text || undefined,
      html: s.html || undefined,
      rtf: s.rtf || undefined,
      image: s.image ? nativeImage.createFromBuffer(Buffer.from(s.image)) : undefined,
    });
    if (!s.text && !s.html && !s.rtf && !s.image) clipboard.clear();
  },
  writeText(text: string): void {
    clipboard.writeText(text);
  },
  readText(): string {
    return clipboard.readText();
  },
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
