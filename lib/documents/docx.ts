// ShapesOS Phase 11 (seotools): DOCX writer (the `docx` package — no
// templates, no network). Renders DocBlocks (./blocks.ts): headings,
// paragraphs with bold / italic / code / links, bulleted and numbered lists
// (nested), quotes, code blocks, tables (header row repeats across pages),
// dividers and page breaks. Fonts are Word defaults; the title (when given)
// becomes the document title property and a Title-styled first line.

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { parseInline, type DocBlock } from "./blocks";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface DocxInput {
  title?: string | null;
  /** Shown in File → Properties. */
  author?: string | null;
  blocks: DocBlock[];
}

const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 } as const;
const MONO = "Consolas";

function runs(text: string, opts: { italics?: boolean } = {}): ParagraphChild[] {
  return parseInline(text).map((r) => {
    const run = new TextRun({ text: r.text, bold: r.bold, italics: r.italic || opts.italics, font: r.code ? MONO : undefined, style: r.link ? "Hyperlink" : undefined });
    return r.link ? new ExternalHyperlink({ link: r.link, children: [run] }) : run;
  });
}

function cell(text: string, header: boolean): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: header ? [new TextRun({ text, bold: true })] : runs(text) })],
    shading: header ? { type: ShadingType.CLEAR, fill: "F3F3F1", color: "auto" } : undefined,
  });
}

function table(rows: string[][], header: boolean): Table {
  const width = Math.max(1, ...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (r, i) =>
        new TableRow({
          tableHeader: header && i === 0,
          children: Array.from({ length: width }, (_, c) => cell(r[c] ?? "", header && i === 0)),
        }),
    ),
  });
}

function render(blocks: DocBlock[]): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(new Paragraph({ heading: HEADINGS[b.level], children: runs(b.text) }));
        break;
      case "paragraph":
        out.push(
          new Paragraph({
            children: b.runs ? b.runs.map((r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italic, font: r.code ? MONO : undefined })) : runs(b.text),
            spacing: { after: 120 },
          }),
        );
        break;
      case "bullet":
        out.push(new Paragraph({ bullet: { level: b.level ?? 0 }, children: runs(b.text) }));
        break;
      case "numbered":
        out.push(new Paragraph({ numbering: { reference: "shapes-numbered", level: b.level ?? 0 }, children: runs(b.text) }));
        break;
      case "quote":
        out.push(
          new Paragraph({
            children: runs(b.text, { italics: true }),
            indent: { left: 567 },
            border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } },
            spacing: { after: 120 },
          }),
        );
        break;
      case "code":
        for (const line of b.text.split("\n")) {
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || " ", font: MONO, size: 18 })],
              shading: { type: ShadingType.CLEAR, fill: "F3F3F1", color: "auto" },
              spacing: { after: 0 },
            }),
          );
        }
        out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case "table":
        if (b.rows.length) {
          out.push(table(b.rows, b.header !== false));
          out.push(new Paragraph({ children: [] }));
        }
        break;
      case "divider":
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "BBBBBB", space: 1 } } }));
        break;
      case "pageBreak":
        out.push(new Paragraph({ children: [new PageBreak()] }));
        break;
    }
  }
  return out;
}

/** Build a .docx file. */
export async function buildDocx(input: DocxInput): Promise<Buffer> {
  const title = input.title?.trim() || undefined;
  const body = render(input.blocks);
  const doc = new Document({
    title,
    creator: input.author?.trim() || "ShapesOS",
    numbering: {
      config: [
        {
          reference: "shapes-numbered",
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER][level],
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        children: [...(title ? [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })] : []), ...(body.length ? body : [new Paragraph({ children: [] })])],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
