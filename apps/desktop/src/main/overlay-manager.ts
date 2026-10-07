// ShapesOS Desktop: one transparent overlay per display, and what each shows.
//
// The controller says WHAT to show in global terms (a point on a display, a
// caption near the cursor); this manager keeps one OverlayState per display
// and sends it to that display's overlay window. Displays come and go
// (screen events); overlays follow.

import { BrowserWindow, screen } from "electron";
import type { Point2 } from "../shared/contract";
import { displayForPoint, globalToLocal, placeCard } from "../shared/coords";
import type { OverlayCard, OverlayDictation, OverlayDrawing, OverlayState } from "../shared/ipc";
import { createOverlayWindow } from "./windows";

const CARD = { width: 360, height: 196 };
const CAPTION_OFFSET = { x: 20, y: 28 };

export class OverlayManager {
  private windows = new Map<number, BrowserWindow>();
  private states = new Map<number, OverlayState>();
  private seq = 0;
  private interactive = new Set<number>();

  start(): void {
    this.sync();
    screen.on("display-added", () => this.sync());
    screen.on("display-removed", () => this.sync());
    screen.on("display-metrics-changed", () => this.sync());
  }

  private sync(): void {
    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [id, w] of this.windows) {
      if (!ids.has(id)) {
        if (!w.isDestroyed()) w.destroy();
        this.windows.delete(id);
        this.states.delete(id);
      }
    }
    for (const d of displays) {
      const existing = this.windows.get(d.id);
      if (existing && !existing.isDestroyed()) {
        existing.setBounds(d.bounds);
      } else {
        const w = createOverlayWindow(d);
        this.windows.set(d.id, w);
        w.webContents.on("did-finish-load", () => this.push(d.id));
      }
      const prev = this.states.get(d.id);
      this.states.set(d.id, { ...(prev ?? empty(d.id)), displayId: d.id, width: d.bounds.width, height: d.bounds.height });
    }
  }

  windowFor(displayId: number): BrowserWindow | undefined {
    return this.windows.get(displayId);
  }

  displayIdOf(webContentsId: number): number | null {
    for (const [id, w] of this.windows) if (!w.isDestroyed() && w.webContents.id === webContentsId) return id;
    return null;
  }

  state(displayId: number): OverlayState | undefined {
    return this.states.get(displayId);
  }

  allStates(): OverlayState[] {
    return [...this.states.values()];
  }

  private push(displayId: number): void {
    const w = this.windows.get(displayId);
    const s = this.states.get(displayId);
    if (w && s && !w.isDestroyed()) w.webContents.send("overlay:state", s);
  }

  private patch(displayId: number, fn: (s: OverlayState) => OverlayState): void {
    const s = this.states.get(displayId);
    if (!s) return;
    this.states.set(displayId, fn(s));
    this.push(displayId);
  }

  private patchAll(fn: (s: OverlayState) => OverlayState): void {
    for (const id of this.states.keys()) this.patch(id, fn);
  }

  /** Click-through off while the pointer is over a card (forwarded mouse events tell us). */
  setInteractive(displayId: number, on: boolean): void {
    const w = this.windows.get(displayId);
    if (!w || w.isDestroyed()) return;
    if (on) {
      this.interactive.add(displayId);
      w.setIgnoreMouseEvents(false);
    } else {
      this.interactive.delete(displayId);
      w.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  private cursorDisplay(): { id: number; local: Point2; bounds: Electron.Rectangle } {
    const p = screen.getCursorScreenPoint();
    const d = screen.getDisplayNearestPoint(p);
    return { id: d.id, local: globalToLocal(p, d), bounds: d.bounds };
  }

  // ---- what to show ----------------------------------------------------------

  pointAt(displayId: number, local: Point2, label: string): void {
    this.seq += 1;
    const seq = this.seq;
    this.patchAll((s) => ({ ...s, pointer: s.displayId === displayId ? { x: local.x, y: local.y, label, seq } : null }));
  }

  draw(displayId: number, d: Omit<OverlayDrawing, "id">): void {
    this.seq += 1;
    const id = `d${this.seq}`;
    this.patch(displayId, (s) => ({ ...s, drawings: [...s.drawings, { ...d, id }].slice(-24) }));
  }

  caption(text: string | null, kind: NonNullable<OverlayState["caption"]>["kind"] = "answering"): void {
    if (!text) {
      this.patchAll((s) => ({ ...s, caption: null }));
      return;
    }
    const c = this.cursorDisplay();
    const x = Math.min(c.local.x + CAPTION_OFFSET.x, c.bounds.width - 380);
    const y = Math.min(c.local.y + CAPTION_OFFSET.y, c.bounds.height - 120);
    this.patchAll((s) => ({
      ...s,
      caption: s.displayId === c.id ? { text: text.slice(-600), kind, x: Math.max(8, x), y: Math.max(8, y) } : null,
    }));
  }

  listening(on: boolean): void {
    const c = this.cursorDisplay();
    this.patchAll((s) => ({ ...s, listening: on && s.displayId === c.id }));
  }

  capturing(on: boolean): void {
    // The indicator shows on every display: every display may be captured.
    this.patchAll((s) => ({ ...s, capturing: on }));
  }

  /** Show a proposal card near a global point (element/point) or the cursor. */
  proposal(card: Omit<OverlayCard, "x" | "y"> | null, anchorGlobal?: Point2): void {
    if (!card) {
      this.patchAll((s) => ({ ...s, proposal: null }));
      for (const id of [...this.interactive]) this.setInteractive(id, false);
      return;
    }
    const target = this.place(anchorGlobal, CARD);
    this.patchAll((s) => ({ ...s, proposal: s.displayId === target.id ? { ...card, x: target.x, y: target.y } : null }));
  }

  updateProposal(fn: (c: OverlayCard) => OverlayCard): void {
    this.patchAll((s) => ({ ...s, proposal: s.proposal ? fn(s.proposal) : null }));
  }

  dictation(d: Omit<OverlayDictation, "x" | "y"> | null): void {
    if (!d) {
      this.patchAll((s) => ({ ...s, dictation: null }));
      for (const id of [...this.interactive]) this.setInteractive(id, false);
      return;
    }
    const existing = this.allStates().find((s) => s.dictation);
    if (existing?.dictation) {
      this.patch(existing.displayId, (s) => ({ ...s, dictation: { ...d, x: existing.dictation!.x, y: existing.dictation!.y } }));
      return;
    }
    const target = this.place(undefined, CARD);
    this.patchAll((s) => ({ ...s, dictation: s.displayId === target.id ? { ...d, x: target.x, y: target.y } : null }));
  }

  private place(anchorGlobal: Point2 | undefined, card: { width: number; height: number }): { id: number; x: number; y: number } {
    const all = screen.getAllDisplays();
    const g = anchorGlobal ?? screen.getCursorScreenPoint();
    const d = displayForPoint(all, g) ?? screen.getPrimaryDisplay();
    const p = placeCard(globalToLocal(g, d), card, d);
    return { id: d.id, x: p.x, y: p.y };
  }

  /** Clear pointer and drawings (a new turn, or the stop key). */
  clearMarks(): void {
    this.patchAll((s) => ({ ...s, pointer: null, drawings: [] }));
  }

  clearAll(): void {
    this.patchAll((s) => ({ ...empty(s.displayId), width: s.width, height: s.height }));
    for (const id of [...this.interactive]) this.setInteractive(id, false);
  }

  destroy(): void {
    for (const w of this.windows.values()) if (!w.isDestroyed()) w.destroy();
    this.windows.clear();
  }
}

function empty(displayId: number): OverlayState {
  return {
    displayId,
    width: 0,
    height: 0,
    pointer: null,
    drawings: [],
    caption: null,
    capturing: false,
    listening: false,
    proposal: null,
    dictation: null,
  };
}
