// ShapesOS — Phase 21B (WS=drive): where the person is in the Files app.
export type Place =
  | { t: "folder"; path: string }
  | { t: "recents" }
  | { t: "shared" }
  | { t: "trash" }
  | { t: "tag"; tag: string }
  | { t: "search"; query: string }
  | { t: "smart"; id: string; name: string; query: string };

export type ViewMode = "list" | "icons" | "columns";

export function samePlace(a: Place, b: Place): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "folder":
      return a.path === (b as typeof a).path;
    case "tag":
      return a.tag === (b as typeof a).tag;
    case "search":
      return a.query === (b as typeof a).query;
    case "smart":
      return a.id === (b as typeof a).id;
    default:
      return true;
  }
}
