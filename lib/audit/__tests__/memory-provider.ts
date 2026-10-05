// ShapesOS Phase 11 (seotools): TEST-ONLY in-memory SiteFileProvider.

import type { FileEntry, SiteFileProvider } from "@/lib/sitefiles/types";

/** In-memory SiteFileProvider over a path → content map. */
export function memoryProvider(files: Record<string, string | { size: number }>): SiteFileProvider {
  const entries = (dir: string): FileEntry[] => {
    const prefix = dir === "/" ? "/" : `${dir.replace(/\/$/, "")}/`;
    const seen = new Map<string, FileEntry>();
    for (const [path, v] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [head, ...tail] = rest.split("/");
      const childPath = prefix + head;
      if (tail.length) seen.set(childPath, { name: head, path: childPath, type: "dir" });
      else seen.set(childPath, { name: head, path: childPath, type: "file", size: typeof v === "string" ? v.length : v.size });
    }
    return [...seen.values()];
  };
  return {
    name: "memory",
    isLive: false,
    async listDir(p) {
      return entries(p || "/");
    },
    async readFile(p) {
      const v = files[p];
      if (typeof v !== "string") throw new Error("binary or missing");
      return { content: v, truncated: false };
    },
    async writeFile(p, c) {
      files[p] = c;
    },
    async stat(p) {
      return { name: p.split("/").pop()!, path: p, type: "file" };
    },
    async test() {
      return { ok: true, message: "ok" };
    },
  };
}
