"use client";

// ShapesOS — Phase 18.2 (WS=content): the note editor.
//
// The existing Tiptap block editor (components/block-editor: slash menu,
// bubble menu, drag handle) over the shared note schema (lib/notes/schema.ts).
// Two modes:
//   - live collaboration (when the collab server is configured): the content
//     is a yjs document synced through Hocuspocus (lib/collab); every editor
//     sees the others' carets with their names. The server persists it and
//     writes the JSON snapshot back to the note. A viewer's connection is
//     read-only on the server, and the editor is read-only here too.
//   - single editor (no collab server): the parent autosaves the JSON with
//     optimistic concurrency (PATCH /api/notes/[id] with expectedVersion).
// When the server says the document was replaced (a version restore), the
// parent remounts this editor with a fresh yjs document (onReset).

import { useEffect, useRef, useState } from "react";
import { useEditor } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { BlockEditor, SlashCommand, getSlashCommandSuggestion } from "@/components/block-editor";
import "@/components/block-editor/style.css";
import "./notes.css";
import { NOTE_YJS_FIELD, noteSchemaExtensions } from "@/lib/notes/schema";
import { useT } from "@/components/i18n/I18nProvider";

export interface CollabConfig {
  /** wss://… of the collab server. */
  url: string;
  /** "note:<id>" — the server re-checks it against the token. */
  docName: string;
  readOnly: boolean;
  user: { name: string; color: string };
  /** A fresh short-lived token for each (re)connection. */
  fetchToken: () => Promise<string>;
}

export type CollabStatus = "connecting" | "connected" | "disconnected" | "denied";

export interface NoteEditorProps {
  initialContent: unknown;
  editable: boolean;
  collab: CollabConfig | null;
  placeholder: string;
  /** Single-editor mode: the JSON after each change (the parent debounces the save). */
  onChange?: (json: unknown) => void;
  onCollabStatus?: (s: CollabStatus) => void;
  /** Names of the other people editing right now. */
  onPeers?: (names: string[]) => void;
  /** The server replaced the document (version restore): remount with a fresh one. */
  onReset?: () => void;
  ariaLabel: string;
}

/** The caret label: the member's name in an ink pill; the caret line in their (neutral token) colour. */
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const cursor = document.createElement("span");
  cursor.classList.add("collaboration-carets__caret");
  cursor.setAttribute("style", `border-color: ${String(user.color ?? "var(--aos-ink)")}`);
  const label = document.createElement("div");
  label.classList.add("collaboration-carets__label");
  label.textContent = String(user.name ?? "");
  cursor.insertBefore(label, null);
  return cursor;
}

export function NoteEditor(props: NoteEditorProps) {
  return props.collab ? <CollabNoteEditor {...props} collab={props.collab} /> : <PlainNoteEditor {...props} />;
}

function editorAttributes(label: string) {
  return {
    class: "note-editor min-h-[360px] px-1 py-2 text-ink outline-none max-w-none",
    "aria-label": label,
    role: "textbox",
    "aria-multiline": "true",
  };
}

function PlainNoteEditor({ initialContent, editable, placeholder, onChange, ariaLabel }: NoteEditorProps) {
  const t = useT();
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      ...noteSchemaExtensions(),
      Placeholder.configure({ placeholder }),
      SlashCommand.configure({ suggestion: getSlashCommandSuggestion() }),
    ],
    content: (initialContent as object) ?? { type: "doc", content: [{ type: "paragraph" }] },
    editorProps: { attributes: editorAttributes(ariaLabel) },
    onUpdate: ({ editor }) => onChangeRef.current?.(editor.getJSON()),
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  if (!editor) return <p className="min-h-[360px] py-2 text-md text-muted">{t("notes.editor.loading")}</p>;
  return <BlockEditor editor={editor} />;
}

function CollabNoteEditor({ collab, editable, placeholder, onCollabStatus, onPeers, onReset, ariaLabel }: NoteEditorProps & { collab: CollabConfig }) {
  const t = useT();
  const cbs = useRef({ onCollabStatus, onPeers, onReset, fetchToken: collab.fetchToken });
  useEffect(() => {
    cbs.current = { onCollabStatus, onPeers, onReset, fetchToken: collab.fetchToken };
  }, [onCollabStatus, onPeers, onReset, collab.fetchToken]);

  // One yjs document + provider per mount (the parent remounts on reset).
  // Created in an effect, never during render: the provider connects at once
  // and reports its status to the parent (a state update), and React's
  // StrictMode double render must not open a second connection.
  const [session, setSession] = useState<{ ydoc: Y.Doc; provider: HocuspocusProvider } | null>(null);
  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: collab.url,
      name: collab.docName,
      document: ydoc,
      token: () => cbs.current.fetchToken(),
      onStatus: ({ status }) => cbs.current.onCollabStatus?.(status === "connected" ? "connected" : status === "connecting" ? "connecting" : "disconnected"),
      onAuthenticationFailed: () => cbs.current.onCollabStatus?.("denied"),
      onStateless: ({ payload }) => {
        try {
          if ((JSON.parse(payload) as { type?: string }).type === "reset") cbs.current.onReset?.();
        } catch {
          // not ours
        }
      },
    });
    setSession({ ydoc, provider });
    return () => {
      setSession(null);
      provider.destroy();
      ydoc.destroy();
    };
  }, [collab.url, collab.docName]);

  if (!session) return <p className="min-h-[360px] py-2 text-md text-muted">{t("notes.editor.loading")}</p>;
  return (
    <CollabEditorBody
      key={session.ydoc.guid}
      ydoc={session.ydoc}
      provider={session.provider}
      user={collab.user}
      writable={editable && !collab.readOnly}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      onPeers={(names) => cbs.current.onPeers?.(names)}
    />
  );
}

function CollabEditorBody({
  ydoc,
  provider,
  user,
  writable,
  placeholder,
  ariaLabel,
  onPeers,
}: {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  user: CollabConfig["user"];
  writable: boolean;
  placeholder: string;
  ariaLabel: string;
  onPeers: (names: string[]) => void;
}) {
  const t = useT();
  const peersCb = useRef(onPeers);
  useEffect(() => {
    peersCb.current = onPeers;
  }, [onPeers]);

  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    const update = () => {
      const names: string[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return;
        const name = (state as { user?: { name?: string } }).user?.name;
        if (name && !names.includes(name)) names.push(name);
      });
      peersCb.current(names);
    };
    awareness.on("change", update);
    update();
    return () => {
      awareness.off("change", update);
    };
  }, [provider, ydoc]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: writable,
      extensions: [
        ...noteSchemaExtensions({ history: false }),
        Placeholder.configure({ placeholder }),
        SlashCommand.configure({ suggestion: getSlashCommandSuggestion() }),
        Collaboration.configure({ document: ydoc, field: NOTE_YJS_FIELD }),
        CollaborationCaret.configure({ provider, user, render: renderCaret }),
      ],
      editorProps: { attributes: editorAttributes(ariaLabel) },
    },
    [ydoc, provider],
  );
  useEffect(() => {
    editor?.setEditable(writable);
  }, [editor, writable]);

  const [synced, setSynced] = useState(provider.isSynced);
  useEffect(() => {
    const on = () => setSynced(true);
    provider.on("synced", on);
    return () => {
      provider.off("synced", on);
    };
  }, [provider]);

  if (!editor) return <p className="min-h-[360px] py-2 text-md text-muted">{t("notes.editor.loading")}</p>;
  return (
    <div aria-busy={!synced}>
      <BlockEditor editor={editor} />
    </div>
  );
}

export default NoteEditor;
