// Phase 18.2 (WS=content): @tiptap/y-tiptap 3.0.x ships JavaScript only (its
// package.json "types" points at dist/src/y-tiptap.d.ts, which is not in the
// published package). The collab server (lib/collab/persistence.ts) uses two
// of its converters; these are their signatures (y-prosemirror's API).
declare module "@tiptap/y-tiptap" {
  import type { Schema } from "@tiptap/pm/model";
  import type * as Y from "yjs";
  /** A ProseMirror JSON document → a new yjs document (content in `xmlFragment`). */
  export function prosemirrorJSONToYDoc(schema: Schema, state: unknown, xmlFragment?: string): Y.Doc;
  /** A yjs document's `xmlFragment` → ProseMirror JSON ({ type: "doc", content }). */
  export function yDocToProsemirrorJSON(ydoc: Y.Doc, xmlFragment?: string): Record<string, unknown>;
}
