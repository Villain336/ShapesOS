// Marketr — M21 Google Drive adapter.
//
// LIVE WIRING (not yet implemented): this adapter is MOCK-ONLY today. The
// live pass must call the Google Drive API v3:
//   GET  https://www.googleapis.com/drive/v3/files?q=...&fields=files(id,name,mimeType,size,modifiedTime)
//     → list_files() / search_files()
//   GET  https://www.googleapis.com/drive/v3/files/{fileId}/export?mimeType=text/plain
//     (Google Docs/Sheets/Slides → text) → get_file_text()
//   GET  https://www.googleapis.com/drive/v3/files/{fileId}?alt=media
//     (binary/CSV/PDF) → get_file_text()
// Auth: OAuth2 Bearer access_token (scopes drive.readonly + drive.file);
// refresh via lib/vault/refresh.ts. Docs:
// https://developers.google.com/workspace/drive/api/reference/rest/v3
//
// MOCK MODE: deterministic demo file listing + document text for attaching
// briefs to chat sessions; every row flagged mock: true, titles carry
// "(MOCK)". No network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { strProp, mockOk, fail } from "../types";

const MOCK_FILES = [
  { id: "mock-doc-1", name: "Q3 Content Brief (MOCK)", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-18T09:00:00Z" },
  { id: "mock-doc-2", name: "Brand Voice Guide (MOCK)", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-08-30T14:00:00Z" },
  { id: "mock-sheet-1", name: "Keyword Tracker (MOCK)", mimeType: "application/vnd.google-apps.spreadsheet", modifiedTime: "2026-09-21T11:30:00Z" },
  { id: "mock-slide-1", name: "Client Pitch Deck (MOCK)", mimeType: "application/vnd.google-apps.presentation", modifiedTime: "2026-09-10T16:45:00Z" },
  { id: "mock-pdf-1", name: "SEO Audit Report (MOCK).pdf", mimeType: "application/pdf", sizeBytes: 184320, modifiedTime: "2026-09-05T10:15:00Z" },
];

const MOCK_TEXT: Record<string, string> = {
  "mock-doc-1": "# Q3 Content Brief (MOCK)\n\nPillars: implant guides, whitening explainers, patient stories. Tone: warm, plain-English. CTA: book a consult.",
  "mock-doc-2": "# Brand Voice Guide (MOCK)\n\nVoice: gentle expert. Avoid: jargon, fear. Sign-off: “Smile brighter.”",
};

export class GoogleDriveAdapter implements ConnectorAdapter {
  readonly key = "google-drive";
  readonly displayName = "Google Drive";
  readonly authType = "oauth2" as const;
  readonly configSchema = {
    type: "object",
    properties: {
      folderId: {
        type: "string",
        description: "Default Drive folder to browse. Also accepted per-project via ProjectDataSource.projectConfig.",
      },
    },
  };

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_files",
        description: "List files in a Drive folder (defaults to Drive root).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            folderId: strProp("Drive folder id (optional)."),
            limit: strProp("Max files (default 25)."),
          },
        },
      },
      {
        name: "search_files",
        description: "Search Drive files by name/content keyword.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { query: strProp("Search text, e.g. \"content brief\".") },
          required: ["query"],
        },
      },
      {
        name: "get_file_text",
        description: "Read a Drive file as text (Google Docs exported to plain text; CSV/PDF downloaded). Attach briefs to a chat session with this.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { fileId: strProp("Drive file id.") },
          required: ["fileId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    _credential: DecryptedCredential | null,
    _ctx: InvokeContext,
  ): Promise<InvokeResult> {
    switch (tool) {
      case "list_files": {
        const limit = Math.min(Number(args.limit) || 25, 100);
        return mockOk(
          MOCK_FILES.slice(0, limit).map((f) => ({ ...f, mock: true })),
        );
      }
      case "search_files": {
        const q = String(args.query).toLowerCase();
        return mockOk(
          MOCK_FILES.filter((f) => f.name.toLowerCase().includes(q)).map((f) => ({ ...f, mock: true })),
        );
      }
      case "get_file_text": {
        const id = String(args.fileId);
        const file = MOCK_FILES.find((f) => f.id === id);
        if (!file) return fail(`No file with id "${id}" (mock)`);
        return mockOk({
          fileId: id,
          name: file.name,
          text: `${MOCK_TEXT[id] ?? `Binary content of ${file.name} — not shown in mock mode.`} (MOCK)`,
          mock: true,
        });
      }
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
