// ShapesOS Desktop: dictation (preview → paste → restore the clipboard).
//
// A `dictation { text }` event shows a preview card. Nothing is typed until
// the person confirms. On confirm: save what is on the clipboard, put the
// text there, send the platform paste keystroke to the focused app, wait for
// it to land, then put the original clipboard back. Without Accessibility
// permission (macOS) or a key injector, the text stays on the clipboard and
// the card says "Copied. Press ⌘V to paste." instead of pretending.

/**
 * The clipboard, async (Electron 44's clipboard is the W3C-style async API:
 * read() → ClipboardItem[], write(items), readText(), writeText()).
 * A snapshot is opaque to this module: whatever restore() needs to put
 * every format back (text, HTML, RTF, images, files).
 */
export interface ClipboardPort<S = unknown> {
  snapshot(): Promise<S>;
  restore(s: S): Promise<void>;
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

export interface PastePort {
  /** Can we inject the paste keystroke right now (permission + injector)? */
  canPaste(): boolean;
  /** Send ⌘V (mac) or Ctrl+V (Windows/Linux) to the focused app. */
  paste(): Promise<void>;
}

export type DictationResult =
  | { status: "pasted"; say: string }
  | { status: "copied"; say: string }
  | { status: "failed"; say: string };

export const PASTE_SETTLE_MS = 350;

export async function confirmDictation(
  text: string,
  ports: { clipboard: ClipboardPort; paste: PastePort; sleep?: (ms: number) => Promise<void>; platform: string },
): Promise<DictationResult> {
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const combo = ports.platform === "darwin" ? "⌘V" : "Ctrl+V";
  if (!ports.paste.canPaste()) {
    await ports.clipboard.writeText(text);
    return { status: "copied", say: `Copied. Press ${combo} to paste.` };
  }
  const saved = await ports.clipboard.snapshot();
  await ports.clipboard.writeText(text);
  try {
    await ports.paste.paste();
    await sleep(PASTE_SETTLE_MS);
  } catch {
    // The text is still on the clipboard; leave it there so nothing is lost.
    return { status: "failed", say: `Couldn't paste. The text is on your clipboard; press ${combo}.` };
  }
  // Only restore if nobody else changed the clipboard while we pasted.
  if ((await ports.clipboard.readText()) === text) await ports.clipboard.restore(saved);
  return { status: "pasted", say: "Pasted." };
}

/** The preview card trims to something readable; the full text is pasted. */
export function previewText(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
