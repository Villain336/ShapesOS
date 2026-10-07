// ShapesOS — Phase 19B (WS=panel): interviews in.
// Commercial layer (entitlement dress_rehearsal). See lib/panel/README.md.
//
// An uploaded interview becomes ONE verbatim transcript text: speaker turns
// kept, caption timings, cue numbers and NOTE blocks dropped, nothing
// summarized. Text and Markdown are kept as they are; WebVTT voices
// (<v Name>) and SRT "Name:" lines become "Name: …" turns; DOCX goes through
// the app's existing extractor (lib/datasetbuilder/extract.ts — loaded
// lazily: it pulls in adm-zip, which stays out of route bundles).

export const TRANSCRIPT_MAX_CHARS = 400_000;

export type TranscriptFormat = "text" | "vtt" | "srt" | "docx";

export class TranscriptImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptImportError";
  }
}

const TIMING = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

interface Turn {
  speaker: string | null;
  text: string;
}

/** Join consecutive cues of one speaker into turns; "Speaker: text" lines. */
function turnsToText(turns: Turn[]): string {
  const merged: Turn[] = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speaker === t.speaker) prev.text = `${prev.text} ${t.text}`;
    else merged.push({ ...t });
  }
  return merged.map((t) => (t.speaker ? `${t.speaker}: ${t.text}` : t.text)).join("\n");
}

/** Split caption text into cues (blank-line separated), dropping headers, notes, numbers and timings. */
function cues(raw: string): string[][] {
  return raw
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.split("\n").map((l) => l.trim()).filter(Boolean))
    .filter((lines) => lines.length > 0 && !/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0]!))
    .map((lines) => {
      const at = lines.findIndex((l) => TIMING.test(l));
      return at >= 0 ? lines.slice(at + 1) : lines.filter((l) => !/^\d+$/.test(l));
    })
    .filter((lines) => lines.length > 0);
}

/** WebVTT → speaker turns. */
export function parseVtt(raw: string): string {
  const turns: Turn[] = [];
  for (const lines of cues(raw)) {
    const joined = lines.join(" ");
    const voice = /^<v(?:\.[\w.-]+)?\s+([^>]+)>([\s\S]*)$/.exec(joined);
    const text = (voice ? voice[2]! : joined).replace(/<\/?[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text) turns.push({ speaker: voice ? voice[1]!.trim() : null, text });
  }
  return turnsToText(turns);
}

/** SRT → speaker turns ("Name: text" lines stay turns). */
export function parseSrt(raw: string): string {
  const turns: Turn[] = [];
  for (const lines of cues(raw)) {
    const joined = lines.join(" ").replace(/<\/?[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const m = /^([A-Z][\w .'-]{0,40}):\s+(.*)$/.exec(joined);
    if (joined) turns.push(m ? { speaker: m[1]!.trim(), text: m[2]! } : { speaker: null, text: joined });
  }
  return turnsToText(turns);
}

function formatOf(filename: string): TranscriptFormat | null {
  const f = filename.toLowerCase();
  if (/\.(txt|md|markdown|text)$/.test(f)) return "text";
  if (f.endsWith(".vtt")) return "vtt";
  if (f.endsWith(".srt")) return "srt";
  if (f.endsWith(".docx")) return "docx";
  return null;
}

/** One uploaded file → verbatim transcript text. Throws TranscriptImportError with the fix. */
export async function importTranscriptFile(filename: string, bytes: Buffer): Promise<{ text: string; format: TranscriptFormat }> {
  const format = formatOf(filename);
  if (!format) throw new TranscriptImportError("Upload a .txt, .md, .vtt, .srt or .docx file.");
  let text: string;
  if (format === "docx") {
    const { extractTextFromUpload } = await import("@/lib/datasetbuilder/extract");
    try {
      text = extractTextFromUpload(filename, new Uint8Array(bytes)).text;
    } catch (err) {
      throw new TranscriptImportError(`That document couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
    }
  } else {
    const raw = bytes.toString("utf8");
    text = format === "vtt" ? parseVtt(raw) : format === "srt" ? parseSrt(raw) : raw.replace(/\r\n?/g, "\n");
  }
  text = text.trim();
  if (!text) throw new TranscriptImportError("That file is empty.");
  if (text.length > TRANSCRIPT_MAX_CHARS) throw new TranscriptImportError(`That interview is too long (${text.length} characters; the limit is ${TRANSCRIPT_MAX_CHARS}). Split it into parts.`);
  return { text, format };
}
