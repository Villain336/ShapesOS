// ShapesOS — Phase 21B (WS=drive): provider-relative paths. The same name rules
// as the Drive roots (NFC, no "..", no Windows-reserved names, no trailing
// dot/space), applied by parsing the path under /shared and stripping that.

import { normalizeFolderPath, FS_ROOTS } from "../../filesystem/paths";
import { ProviderError } from "./types";

export interface ParsedProviderPath {
  /** "/" or "/a/b" (NFC, no trailing slash). */
  path: string;
  segments: string[];
}

export function parseProviderPath(input: string): ParsedProviderPath {
  if (typeof input !== "string" || !input.startsWith("/")) throw new ProviderError("invalid_path", "A path starts with /.");
  const trimmed = input.replace(/\/+$/, "");
  if (trimmed === "") return { path: "/", segments: [] };
  const first = trimmed.split("/")[1] ?? "";
  if ((FS_ROOTS as readonly string[]).includes(`/${first.toLowerCase()}`)) {
    throw new ProviderError("invalid_path", `"${first}" is a reserved name.`);
  }
  const r = normalizeFolderPath(`/shared${trimmed}`);
  if (!r.ok) throw new ProviderError("invalid_path", r.reason);
  const rel = r.path.slice("/shared".length);
  return { path: rel, segments: rel.split("/").filter(Boolean) };
}

export const parentOf = (path: string): string => (path.lastIndexOf("/") <= 0 ? "/" : path.slice(0, path.lastIndexOf("/")));
export const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
