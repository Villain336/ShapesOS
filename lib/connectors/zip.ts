// Marketr — zip helpers (milestone 7).
// Upload: extract a .zip into a site working copy with zip-slip protection
// (every entry name is sanitized; absolute paths and ".." are rejected).
// Download: pack a working copy into a .zip buffer for the browser.

import AdmZip from "adm-zip";
import { sanitizePath } from "@/lib/sitefiles/paths";
import type { WorkingCopyProvider } from "./local";

const MAX_ZIP_FILES = 2000;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** Validate an archive entry name and map it to a safe "/..." path. */
function safeEntryPath(name: string): string {
  // Zip entries use forward slashes; normalize backslashes too.
  const cleaned = name.replace(/\\/g, "/");
  if (cleaned.endsWith("/")) throw new Error("directory");
  return sanitizePath("/" + cleaned);
}

/**
 * Extract a zip buffer into the provider's root. Returns the file list.
 * Throws on zip-slip attempts, oversized archives, or too many files.
 */
export async function extractZipToProvider(
  zipBuffer: Buffer,
  provider: WorkingCopyProvider,
): Promise<string[]> {
  if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error("Zip too large (max 50 MB)");
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw new Error("Invalid zip file");
  }
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) throw new Error("Zip is empty");
  if (entries.length > MAX_ZIP_FILES) throw new Error("Zip has too many files (max 2000)");

  const written: string[] = [];
  for (const entry of entries) {
    let safe: string;
    try {
      safe = safeEntryPath(entry.entryName);
    } catch {
      throw new Error(`Unsafe path in zip: ${entry.entryName}`);
    }
    const data = entry.getData();
    if (data.length > 10 * 1024 * 1024) throw new Error(`File too large in zip: ${entry.entryName}`);
    if (data.includes(0)) continue; // skip binaries on upload
    await provider.writeFile(safe, data.toString("utf8"));
    written.push(safe);
  }
  if (written.length === 0) throw new Error("Zip contained no usable text files");
  return written;
}

/** Pack every file in the provider's root into a zip buffer. */
export async function zipProviderFiles(provider: WorkingCopyProvider): Promise<Buffer> {
  const zip = new AdmZip();
  const walk = async (dir: string) => {
    for (const e of await provider.listDir(dir)) {
      if (e.type === "dir") {
        await walk(e.path);
      } else {
        const { content } = await provider.readFile(e.path);
        // Zip paths are relative without a leading slash.
        zip.addFile(e.path.replace(/^\//, ""), Buffer.from(content, "utf8"));
      }
    }
  };
  await walk("/");
  return zip.toBuffer();
}
