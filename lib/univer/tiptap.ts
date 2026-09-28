// Marketr — Phase 14 slice 8: tiptap JSON → Univer IDocumentData.
//
// Lets a report template (the client deliverable) open as an editable Univer
// doc. Conservative mapping: paragraphs, headings, bullet/ordered lists,
// hard breaks, bold/italic marks. Unknown nodes flatten to their text.

import type { IDocumentData } from "@univerjs/core";
import { buildDocSnapshot } from "./snapshots";
import type { DocParagraphInput } from "./snapshots";

interface TiptapNode {
  type?: string;
  text?: string;
  marks?: Array<{ type?: string }>;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
}

interface Run {
  text: string;
  bold: boolean;
}

function inlineRuns(node: TiptapNode): Run[] {
  const out: Run[] = [];
  const walk = (n: TiptapNode, bold: boolean) => {
    const isBold = bold || (n.marks ?? []).some((m) => m.type === "bold");
    if (n.type === "text") {
      if (n.text) out.push({ text: n.text, bold: isBold });
      return;
    }
    if (n.type === "hardBreak") { out.push({ text: "\n", bold: false }); return; }
    for (const c of n.content ?? []) walk(c, isBold);
  };
  for (const c of node.content ?? []) walk(c, false);
  return out;
}

function plainText(node: TiptapNode): string {
  return inlineRuns({ content: [node] } as TiptapNode).map((r) => r.text).join("");
}

interface Para {
  runs: Run[];
  headingLevel: number; // 0 = body
}

/** Flatten a tiptap doc into styled paragraphs. */
export function tiptapToParagraphs(tiptap: unknown): Para[] {
  const root = tiptap as TiptapNode | null;
  if (!root || root.type !== "doc" || !Array.isArray(root.content)) return [];
  const paras: Para[] = [];

  const pushPara = (node: TiptapNode, headingLevel: number, prefix = "") => {
    const runs = inlineRuns(node);
    if (prefix) runs.unshift({ text: prefix, bold: false });
    paras.push({ runs, headingLevel });
  };

  const visitList = (node: TiptapNode, ordered: boolean) => {
    let i = 1;
    for (const item of node.content ?? []) {
      if (item.type !== "listItem") continue;
      const prefix = ordered ? `${i}. ` : "• ";
      for (const c of item.content ?? []) {
        if (c.type === "paragraph") pushPara(c, 0, prefix);
        else if (c.type === "bulletList" || c.type === "orderedList") visitList(c, c.type === "orderedList");
        else if (plainText(c).trim()) pushPara(c, 0, prefix);
      }
      i++;
    }
  };

  for (const node of root.content) {
    switch (node.type) {
      case "paragraph":
        pushPara(node, 0);
        break;
      case "heading": {
        const level = Math.min(3, Math.max(1, Number(node.attrs?.level ?? 1)));
        pushPara(node, level);
        break;
      }
      case "bulletList":
        visitList(node, false);
        break;
      case "orderedList":
        visitList(node, true);
        break;
      case "blockquote":
        for (const c of node.content ?? []) pushPara(c, 0, "“ ");
        break;
      default: {
        const text = plainText(node).trim();
        if (text) paras.push({ runs: [{ text, bold: false }], headingLevel: 0 });
      }
    }
  }
  return paras;
}

/**
 * Report template content → Univer document snapshot. The doc title becomes
 * the first heading; paragraphs carry heading ids so the editor shows the
 * outline.
 */
export function tiptapToDocSnapshot(tiptap: unknown, title: string): IDocumentData {
  const paras = tiptapToParagraphs(tiptap);
  const input: DocParagraphInput[] = paras.map((p) => {
    const ranges: Array<[number, number]> = [];
    let i = 0;
    let rs: number | null = null;
    for (const r of p.runs) {
      for (let k = 0; k < r.text.length; k++) {
        if (r.bold && rs === null) rs = i;
        if (!r.bold && rs !== null) { ranges.push([rs, i]); rs = null; }
        i++;
      }
    }
    if (rs !== null) ranges.push([rs, i]);
    return {
      text: p.runs.map((r) => r.text).join(""),
      boldRanges: ranges,
      headingLevel: (p.headingLevel <= 3 ? p.headingLevel : 3) as 0 | 1 | 2 | 3,
    };
  });
  return buildDocSnapshot({ title, paragraphs: input });
}
