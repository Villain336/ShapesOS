// ShapesOS — Phase 18.2 (WS=content): window events between the Notes pieces
// (quick capture, the Notes app, a record's notes panel, the Home widget).

export const NOTE_CAPTURE_EVENT = "shapes:note-capture";
export const NOTES_CHANGED_EVENT = "shapes:notes-changed";

export interface NoteCaptureDetail {
  /** Records the new note is linked to (a record page's "Add a note"). */
  links?: Array<{ kind: string; id: string; label?: string }>;
}

/** Open quick capture (⌥⇧N, the Home widget, a record's notes panel). */
export function openQuickCapture(detail: NoteCaptureDetail = {}): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(NOTE_CAPTURE_EVENT, { detail }));
}

export function notifyNotesChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(NOTES_CHANGED_EVENT));
}
