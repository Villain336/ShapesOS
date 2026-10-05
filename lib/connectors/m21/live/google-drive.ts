// ShapesOS — Phase 4b live Google Drive client (Drive API v3, read-only).
//   GET https://www.googleapis.com/drive/v3/files?q=…&fields=…&pageToken=…
//   GET https://www.googleapis.com/drive/v3/files/{id}?fields=…
//   GET https://www.googleapis.com/drive/v3/files/{id}/export?mimeType=…  (Google Workspace files)
//   GET https://www.googleapis.com/drive/v3/files/{id}?alt=media          (text-like binaries)
// Only what the drive.readonly grant can see is reachable; nothing writes.
// Query text is escaped per the Drive search grammar (\\ and ').

import { liveRequest, ConnectorApiError, type LiveDeps, type TokenSource } from "./http";

export const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const PROVIDER = "Google Drive";
const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink";
/** Text returned to the agent is capped (Drive export itself caps at 10 MB). */
export const DRIVE_TEXT_CAP = 200_000;

export interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

/** Escape a literal for the Drive `q` grammar. */
export function escapeDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function normalizeDriveId(raw: unknown, field: string): string {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(s)) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: ${field} is not a valid Drive id.`);
  }
  return s;
}

function shapeFile(f: DriveFile) {
  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    ...(f.size ? { sizeBytes: Number(f.size) } : {}),
    modifiedTime: f.modifiedTime ?? null,
    webViewLink: f.webViewLink ?? null,
  };
}

/** files.list with pageToken pagination up to `limit` files. */
export async function driveListFiles(auth: TokenSource, q: string, limit: number, deps: LiveDeps = {}) {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const res = await liveRequest<{ files?: DriveFile[]; nextPageToken?: string }>(
      {
        provider: PROVIDER,
        url: `${DRIVE_BASE}/files`,
        query: {
          q,
          pageSize: Math.min(100, limit - out.length),
          pageToken,
          fields: `nextPageToken,files(${FILE_FIELDS})`,
          orderBy: "modifiedTime desc",
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        auth,
      },
      deps,
    );
    out.push(...(res.files ?? []));
    pageToken = res.nextPageToken || undefined;
    if (!pageToken) break;
  }
  return out.slice(0, limit).map(shapeFile);
}

export function folderQuery(folderId: string | undefined): string {
  const parent = folderId ? `'${escapeDriveQuery(folderId)}' in parents` : "'root' in parents";
  return `${parent} and trashed = false`;
}

export function searchQuery(text: string): string {
  const t = escapeDriveQuery(text);
  return `(name contains '${t}' or fullText contains '${t}') and trashed = false`;
}

/** Workspace types → the export format the agent can read. */
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.drawing": "image/svg+xml",
};

function isTextLike(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/csv" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

export async function driveGetFileText(auth: TokenSource, fileId: string, deps: LiveDeps = {}) {
  const meta = await liveRequest<DriveFile>(
    {
      provider: PROVIDER,
      url: `${DRIVE_BASE}/files/${fileId}`,
      query: { fields: FILE_FIELDS, supportsAllDrives: true },
      auth,
    },
    deps,
  );
  const mime = meta.mimeType ?? "";
  const base = { fileId, name: meta.name ?? "", mimeType: mime };
  let text: string;
  if (EXPORTS[mime]) {
    text = await liveRequest<string>(
      {
        provider: PROVIDER,
        url: `${DRIVE_BASE}/files/${fileId}/export`,
        query: { mimeType: EXPORTS[mime] },
        auth,
        responseType: "text",
        maxTextBytes: DRIVE_TEXT_CAP + 1,
      },
      deps,
    );
  } else if (isTextLike(mime)) {
    text = await liveRequest<string>(
      {
        provider: PROVIDER,
        url: `${DRIVE_BASE}/files/${fileId}`,
        query: { alt: "media", supportsAllDrives: true },
        auth,
        responseType: "text",
        maxTextBytes: DRIVE_TEXT_CAP + 1,
      },
      deps,
    );
  } else {
    return {
      ...base,
      text: null,
      note: `Binary file (${mime || "unknown type"}) — text extraction is not available; open it in Drive instead.`,
      webViewLink: meta.webViewLink ?? null,
    };
  }
  const truncated = text.length > DRIVE_TEXT_CAP;
  return { ...base, text: truncated ? text.slice(0, DRIVE_TEXT_CAP) : text, truncated };
}

/** Health check: the about resource (user only). */
export async function drivePing(auth: TokenSource, deps: LiveDeps = {}) {
  await liveRequest({ provider: PROVIDER, url: `${DRIVE_BASE}/about`, query: { fields: "user" }, auth }, deps);
  return { reachable: true };
}
