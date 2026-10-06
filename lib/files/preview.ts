// ShapesOS — Phase 18.2 (WS=content): which files the browser can preview
// (PURE, client-safe). Used by the Files preview pane, the public share
// viewer, and the share route (a view-only link serves only these).

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "csv" | "markdown" | "office" | "none";

const IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OFFICE = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export function previewKind(mimeType: string, filename = ""): PreviewKind {
  const m = (mimeType || "").toLowerCase();
  const f = filename.toLowerCase();
  if (IMAGE.has(m)) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m === "text/csv" || f.endsWith(".csv")) return "csv";
  if (m === "text/markdown" || /\.(md|markdown)$/.test(f)) return "markdown";
  if (m === "text/plain") return "text";
  if (OFFICE.has(m) || /\.(xlsx|docx)$/.test(f)) return "office";
  return "none";
}

/** A browser can show these from the bytes alone (SVG deliberately not: active content). */
export function isPreviewableMime(mimeType: string, filename = ""): boolean {
  const k = previewKind(mimeType, filename);
  return k !== "office" && k !== "none";
}

/** Split CSV text into rows (quotes, escaped quotes, CRLF); bounded. PURE. */
export function parseCsv(text: string, maxRows = 500, maxCols = 50): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") {
      if (row.length < maxCols) row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (row.length < maxCols) row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if ((cell !== "" || row.length) && rows.length < maxRows) {
    if (row.length < maxCols) row.push(cell);
    rows.push(row);
  }
  return rows;
}
