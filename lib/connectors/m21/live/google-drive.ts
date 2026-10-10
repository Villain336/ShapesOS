// ShapesOS — Phase 4b live Google Drive client (Drive API v3).
// Phase 21B (WS=drive) adds WRITE and CHANGES calls for the Drive provider
// (lib/drive/providers/google-drive.ts): create folder, upload / replace file
// content, rename / move / trash, delete a folder, byte-range reads, the change
// feed and the storage quota. Writes need the broader `drive` (or `drive.file`)
// OAuth scope, so the integration must be reconnected for them; they are
// UNVERIFIED-LIVE here (tested against a labelled mock of the API).
//   GET https://www.googleapis.com/drive/v3/files?q=…&fields=…&pageToken=…
//   GET https://www.googleapis.com/drive/v3/files/{id}?fields=…
//   GET https://www.googleapis.com/drive/v3/files/{id}/export?mimeType=…  (Google Workspace files)
//   GET https://www.googleapis.com/drive/v3/files/{id}?alt=media          (text-like binaries)
// With only the drive.readonly grant, the write calls fail with `forbidden`.
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


// ===========================================================================
// Phase 21B: write, bytes and changes (Drive provider)
// ===========================================================================

export const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const WRITE_FIELDS = "id,name,mimeType,size,modifiedTime,parents,trashed";
/** Simple multipart upload is for files up to 5 MB (Drive's own guidance); bigger files need the resumable protocol (not wired). */
export const DRIVE_SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024;

export interface DriveFileFull extends DriveFile {
  parents?: string[];
  trashed?: boolean;
}

/** Every non-trashed child of a folder (paged). */
export async function driveListChildren(auth: TokenSource, parentId: string, deps: LiveDeps = {}): Promise<DriveFileFull[]> {
  const out: DriveFileFull[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 200; page++) {
    const res = await liveRequest<{ files?: DriveFileFull[]; nextPageToken?: string }>(
      {
        provider: PROVIDER,
        url: `${DRIVE_BASE}/files`,
        query: {
          q: `'${escapeDriveQuery(parentId)}' in parents and trashed = false`,
          pageSize: 1000,
          pageToken,
          fields: `nextPageToken,files(${WRITE_FIELDS})`,
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
  return out;
}

export async function driveGetMeta(auth: TokenSource, fileId: string, deps: LiveDeps = {}): Promise<DriveFileFull> {
  return liveRequest<DriveFileFull>({ provider: PROVIDER, url: `${DRIVE_BASE}/files/${fileId}`, query: { fields: WRITE_FIELDS, supportsAllDrives: true }, auth }, deps);
}

export async function driveCreateFolder(auth: TokenSource, parentId: string, name: string, deps: LiveDeps = {}): Promise<DriveFileFull> {
  return liveRequest<DriveFileFull>(
    { provider: PROVIDER, method: "POST", url: `${DRIVE_BASE}/files`, query: { fields: WRITE_FIELDS, supportsAllDrives: true }, json: { name, mimeType: FOLDER_MIME, parents: [parentId] }, auth },
    deps,
  );
}

function multipartRelated(boundary: string, metadata: unknown, mime: string, bytes: Buffer): Uint8Array {
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  return Buffer.concat([head, bytes, tail]);
}

/** Create a file with content (simple multipart upload, up to 5 MB). */
export async function driveCreateFile(auth: TokenSource, parentId: string, name: string, mime: string, bytes: Buffer, deps: LiveDeps = {}): Promise<DriveFileFull> {
  if (bytes.length > DRIVE_SIMPLE_UPLOAD_MAX) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: files over 5 MB need the resumable upload, which is not supported yet.`);
  }
  const boundary = `shapesos-${Math.random().toString(36).slice(2)}`;
  return liveRequest<DriveFileFull>(
    {
      provider: PROVIDER,
      method: "POST",
      url: `${DRIVE_UPLOAD_BASE}/files`,
      query: { uploadType: "multipart", fields: WRITE_FIELDS, supportsAllDrives: true },
      rawBody: multipartRelated(boundary, { name, parents: [parentId], mimeType: mime }, mime, bytes),
      contentType: `multipart/related; boundary=${boundary}`,
      auth,
    },
    deps,
  );
}

/** Replace a file's content (media upload, up to 5 MB). */
export async function driveReplaceContent(auth: TokenSource, fileId: string, mime: string, bytes: Buffer, deps: LiveDeps = {}): Promise<DriveFileFull> {
  if (bytes.length > DRIVE_SIMPLE_UPLOAD_MAX) {
    throw new ConnectorApiError(PROVIDER, "bad_request", `${PROVIDER}: files over 5 MB need the resumable upload, which is not supported yet.`);
  }
  return liveRequest<DriveFileFull>(
    { provider: PROVIDER, method: "PATCH", url: `${DRIVE_UPLOAD_BASE}/files/${fileId}`, query: { uploadType: "media", fields: WRITE_FIELDS, supportsAllDrives: true }, rawBody: bytes, contentType: mime, auth },
    deps,
  );
}

/** Rename and/or move (change parents) and/or trash. */
export async function driveUpdateMeta(
  auth: TokenSource,
  fileId: string,
  change: { name?: string; addParent?: string; removeParent?: string; trashed?: boolean },
  deps: LiveDeps = {},
): Promise<DriveFileFull> {
  return liveRequest<DriveFileFull>(
    {
      provider: PROVIDER,
      method: "PATCH",
      url: `${DRIVE_BASE}/files/${fileId}`,
      query: { fields: WRITE_FIELDS, supportsAllDrives: true, addParents: change.addParent, removeParents: change.removeParent },
      json: { ...(change.name !== undefined ? { name: change.name } : {}), ...(change.trashed !== undefined ? { trashed: change.trashed } : {}) },
      auth,
    },
    deps,
  );
}

/** Permanently delete (no trash). Used for folders only, through the Tier-3 tool. */
export async function driveDeletePermanently(auth: TokenSource, fileId: string, deps: LiveDeps = {}): Promise<void> {
  await liveRequest({ provider: PROVIDER, method: "DELETE", url: `${DRIVE_BASE}/files/${fileId}`, query: { supportsAllDrives: true }, auth }, deps);
}

/** A file's bytes, optionally a range (inclusive). Google-native documents are not downloadable this way. */
export async function driveGetBytes(auth: TokenSource, fileId: string, range: { start: number; end: number } | undefined, deps: LiveDeps = {}): Promise<Buffer> {
  return liveRequest<Buffer>(
    {
      provider: PROVIDER,
      url: `${DRIVE_BASE}/files/${fileId}`,
      query: { alt: "media", supportsAllDrives: true },
      headers: range ? { Range: `bytes=${range.start}-${range.end}` } : undefined,
      auth,
      responseType: "buffer",
    },
    deps,
  );
}

export async function driveChangesStartToken(auth: TokenSource, deps: LiveDeps = {}): Promise<string> {
  const r = await liveRequest<{ startPageToken: string }>({ provider: PROVIDER, url: `${DRIVE_BASE}/changes/startPageToken`, query: { supportsAllDrives: true }, auth }, deps);
  return r.startPageToken;
}

export interface DriveChangeRow {
  fileId: string;
  removed?: boolean;
  file?: DriveFileFull;
}

export async function driveChangesList(auth: TokenSource, pageToken: string, pageSize: number, deps: LiveDeps = {}) {
  return liveRequest<{ changes?: DriveChangeRow[]; nextPageToken?: string; newStartPageToken?: string }>(
    {
      provider: PROVIDER,
      url: `${DRIVE_BASE}/changes`,
      query: { pageToken, pageSize, includeItemsFromAllDrives: true, supportsAllDrives: true, fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${WRITE_FIELDS}))` },
      auth,
    },
    deps,
  );
}

export async function driveStorageQuota(auth: TokenSource, deps: LiveDeps = {}): Promise<{ usedBytes: number; limitBytes: number | null }> {
  const r = await liveRequest<{ storageQuota?: { usage?: string; limit?: string } }>({ provider: PROVIDER, url: `${DRIVE_BASE}/about`, query: { fields: "storageQuota" }, auth }, deps);
  return { usedBytes: Number(r.storageQuota?.usage ?? 0), limitBytes: r.storageQuota?.limit ? Number(r.storageQuota.limit) : null };
}
