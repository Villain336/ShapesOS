// ShapesOS — Phase 18.2 (WS=content): the note editor's document schema.
//
// ONE list of the Tiptap extensions that define what a note can contain, used
// by the browser editor (components/notes/NoteEditor.tsx) AND the collab
// server (lib/collab/server.ts), which converts between the live yjs
// document and the JSON snapshot stored on univer_docs. If the two disagreed,
// content the server can't represent would be dropped — so neither side
// declares its own. UI-only extensions (placeholder, slash menu, carets,
// collaboration itself) add no nodes or marks and stay in the editor.

import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";

/** The yjs fragment a note's content lives in (Collaboration's `field`). */
export const NOTE_YJS_FIELD = "default";

/** Schema-defining extensions. `history: false` when yjs owns undo (collaboration). */
export function noteSchemaExtensions(opts: { history?: boolean } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      link: { openOnClick: false, autolink: true },
      ...(opts.history === false ? { undoRedo: false } : {}),
    }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableCell,
    TableHeader,
    TextStyle,
    Color,
    Highlight.configure({ multicolor: true }),
  ];
}
