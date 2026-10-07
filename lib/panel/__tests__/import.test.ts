// Phase 19B (WS=panel) — interviews in: text, VTT, SRT and DOCX become one
// verbatim transcript text (speaker turns kept, cue timings and numbering
// dropped). DOCX goes through the app's existing extractor.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { importTranscriptFile, parseSrt, parseVtt, TRANSCRIPT_MAX_CHARS } from "../import";

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v Interviewer>How do you report today?

00:00:04.500 --> 00:00:09.000
<v Priya Nair>Every Monday I spend three hours
in spreadsheets.

NOTE this is a comment

00:00:09.500 --> 00:00:12.000
<v Priya Nair>It drives me mad.
`;

const SRT = `1
00:00:01,000 --> 00:00:04,000
Interviewer: How do you report today?

2
00:00:04,500 --> 00:00:09,000
Priya: Every Monday I spend three hours
in spreadsheets.
`;

describe("interview import", () => {
  it("VTT: voices become speaker turns, consecutive cues of one speaker join, timings and notes go", () => {
    assert.equal(parseVtt(VTT), "Interviewer: How do you report today?\nPriya Nair: Every Monday I spend three hours in spreadsheets. It drives me mad.");
  });

  it("SRT: numbering and timings go, the text stays verbatim", () => {
    assert.equal(parseSrt(SRT), "Interviewer: How do you report today?\nPriya: Every Monday I spend three hours in spreadsheets.");
  });

  it("plain text and Markdown are kept verbatim (line endings normalised)", async () => {
    const r = await importTranscriptFile("call.txt", Buffer.from("Interviewer: Hi\r\nPriya: Hello"));
    assert.deepEqual(r, { text: "Interviewer: Hi\nPriya: Hello", format: "text" });
  });

  it("DOCX goes through the existing extractor", async () => {
    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
    zip.addFile(
      "word/document.xml",
      Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Interviewer: How much do you pay?</w:t></w:r></w:p><w:p><w:r><w:t>Priya: About $49 a month.</w:t></w:r></w:p></w:body></w:document>'),
    );
    const r = await importTranscriptFile("call.docx", zip.toBuffer());
    assert.equal(r.format, "docx");
    assert.match(r.text, /Interviewer: How much do you pay\?\s+Priya: About \$49 a month\./);
  });

  it("refuses an unsupported type, an empty file and an oversized one, saying why", async () => {
    await assert.rejects(importTranscriptFile("call.mp3", Buffer.from("ID3")), /Upload a .txt, .md, .vtt, .srt or .docx/);
    await assert.rejects(importTranscriptFile("call.txt", Buffer.from("   ")), /empty/);
    await assert.rejects(importTranscriptFile("call.txt", Buffer.from("a".repeat(TRANSCRIPT_MAX_CHARS + 1))), /too long/);
  });
});
