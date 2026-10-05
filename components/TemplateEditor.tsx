// Marketr — editable report template editor (milestone 12).
// Wraps the editorcn Notion-style block editor (Tiptap). Client-only:
// loaded with ssr:false from the reports page.

"use client";

import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import {
  BlockEditor,
  SlashCommand,
  getSlashCommandSuggestion,
} from "@/components/block-editor";
import "@/components/block-editor/style.css";

export interface TemplateEditorProps {
  initialContent: unknown;
  onChange: (json: unknown) => void;
}

const PLACEHOLDER_HINT =
  "Write the report template… Tip: a paragraph containing only {{rankings_table}} becomes the keyword rankings table. Tokens like {{period}}, {{project_domain}}, {{avg_position}} fill in at generation.";

export default function TemplateEditor({ initialContent, onChange }: TemplateEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: PLACEHOLDER_HINT }),
      TaskList,
      TaskItem,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      SlashCommand.configure({ suggestion: getSlashCommandSuggestion() }),
    ],
    content: (initialContent as object) ?? { type: "doc", content: [] },
    editorProps: {
      attributes: {
        class:
          "min-h-[420px] rounded-lg border border-control bg-paper p-6 text-ink outline-none prose prose-invert max-w-none",
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getJSON()),
  });

  if (!editor) {
    return (
      <div className="min-h-[420px] rounded-lg border border-control bg-paper p-6 text-sm text-muted">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-control bg-paper">
      <BlockEditor editor={editor} />
    </div>
  );
}
