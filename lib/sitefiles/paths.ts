// Marketr — path sanitization for site file access.
// Every user-supplied path funnels through sanitizePath() so ".." can never
// escape the connection root, for both the SFTP and mock providers.

export function sanitizePath(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Invalid path");
  let p = raw.trim();
  if (!p || p === "/") return "/";
  // Collapse backslashes, duplicate slashes, and "." segments.
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") throw new Error("Path escapes the connection root");
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

export function joinPath(dir: string, name: string): string {
  return sanitizePath(dir === "/" ? `/${name}` : `${dir}/${name}`);
}

export function parentPath(path: string): string {
  const p = sanitizePath(path);
  if (p === "/") return "/";
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}
