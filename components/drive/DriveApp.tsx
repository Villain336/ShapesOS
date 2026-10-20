"use client";

// ShapesOS — Phase 21B (WS=drive): the Files app — a Finder-style window onto the workspace Drive.
// Sidebar (places, favourites, smart folders, tags, storage) · toolbar (back, path, search, view
// switch, upload) · list / icon / column views · selection with bulk actions · Quick Look (Space) ·
// drag-and-drop and folder upload (big files in resumable parts) · trash and restore · folder sharing ·
// "restore this folder as of …". Everything here goes through /api/drive/*; the server decides what
// this person may do, the buttons just follow `canEdit`.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft, FolderOpen, Check, FolderPlus, FolderUp, History, Search, Star, Upload, Users, X, FileArchive, Tag, Pencil, Trash, RotateCcw, Download, FolderInput, PackageCheck, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { FileDetail } from "@/components/files/FileDetail";
import { displayPath } from "@/lib/filesystem/paths";
import { filterRows, rowFromItem, rowFromShared, rowFromTrash, sortRows, type ApiItem, type ApiSharedItem, type ApiTrashItem, type Row, type SortKey } from "@/lib/drive/client/rows";
import { jobsFromDrop, jobsFromFiles, batchPercent, type UploadProgress } from "@/lib/drive/client/uploads";
import { openWithFor, registerOpenWith } from "@/lib/drive/client/open-with";
import { ApiError, getJson, postJson, treeUrl } from "./api";
import { uploadBatch } from "./uploader";
import { DriveSidebar, type SidebarData } from "./DriveSidebar";
import { ColumnsView, IconView, ListView, type SelectEvent } from "./DriveViews";
import { QuickLook } from "./QuickLook";
import { MoveDialog, NameDialog, RestoreAsOfDialog, ShareDialog, TagsDialog } from "./DriveDialogs";
import { samePlace, type Place, type ViewMode } from "./types";

const PAGE = 200;
const VIEW_KEY = "drive.view";

interface Listing {
  path: string;
  items: ApiItem[];
  total: number;
  canEdit: boolean;
  folder: { id: string; color: string | null; tags: string[]; system: boolean } | null;
}

type Dialog =
  | { type: "newFolder" }
  | { type: "rename"; row: Row }
  | { type: "move"; rows: Row[] }
  | { type: "share"; row: Row }
  | { type: "tags"; row: Row }
  | { type: "asOf"; path: string }
  | { type: "saveSmart"; query: string }
  | null;

// The chosen view survives reloads (localStorage), and falls back to memory where storage is blocked.
let memoryView: ViewMode = "list";
const viewListeners = new Set<() => void>();
function readView(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    if (v === "icons" || v === "columns" || v === "list") return v;
  } catch {
    /* private window */
  }
  return memoryView;
}
function writeView(v: ViewMode): void {
  memoryView = v;
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* the choice just isn't remembered */
  }
  viewListeners.forEach((cb) => cb());
}
function subscribeView(cb: () => void): () => void {
  viewListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    viewListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

interface Loaded {
  /** Which place/sort/reload this answer is for; a stale one is ignored. */
  key: string;
  rows: Row[];
  total: number;
  canEdit: boolean;
  error: string | null;
}

type SideAnswer = {
  roots: { roots: SidebarData["roots"] } | null;
  favorites: { items: ApiItem[] } | null;
  tags: { tags: SidebarData["tags"] } | null;
  smart: { smartFolders: SidebarData["smart"] } | null;
  usage: { usage: NonNullable<SidebarData["usage"]> } | null;
};

/** The sidebar's five reads; each one that fails is null (the sidebar keeps what it had). */
async function sideData(workspaceId: string): Promise<SideAnswer> {
  const [roots, favorites, tags, smart, usage] = await Promise.all([
    getJson<{ roots: SidebarData["roots"] }>(treeUrl(workspaceId, "roots")).catch(() => null),
    getJson<{ items: ApiItem[] }>(treeUrl(workspaceId, "favorites")).catch(() => null),
    getJson<{ tags: SidebarData["tags"] }>(treeUrl(workspaceId, "tags")).catch(() => null),
    getJson<{ smartFolders: SidebarData["smart"] }>(treeUrl(workspaceId, "smart")).catch(() => null),
    getJson<{ usage: NonNullable<SidebarData["usage"]> }>(treeUrl(workspaceId, "usage")).catch(() => null),
  ]);
  return { roots, favorites, tags, smart, usage };
}

/** A selection-bar action: an icon button that shows its label when the bar is wide enough (container query). */
function Act({ icon: Icon, label, onClick, href, disabled, variant, pressed }: { icon: LucideIcon; label: string; onClick?: () => void; href?: string; disabled?: boolean; variant?: "deny"; pressed?: boolean }) {
  const cls = cn(aosButton({ variant, size: "xs" }), "shrink-0");
  const inner = (
    <>
      <Icon className={cn("size-3.5", pressed && "fill-current")} aria-hidden />
      <span className="hidden @4xl:inline">{label}</span>
    </>
  );
  return href ? (
    <a href={href} aria-label={label} title={label} className={cls}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={pressed} title={label} className={cls}>
      {inner}
    </button>
  );
}

export function DriveApp({
  workspaceId,
  canEdit,
  canPurge,
  canAdmin = false,
  initialFileId = null,
  initialPath = null,
}: {
  workspaceId: string;
  canEdit: boolean;
  canPurge: boolean;
  canAdmin?: boolean;
  initialFileId?: string | null;
  initialPath?: string | null;
}) {
  const { t } = useI18n();
  const [place, setPlace] = useState<Place>({ t: "folder", path: initialPath ?? "" });
  const [back, setBack] = useState<Place[]>([]);
  const view = useSyncExternalStore(subscribeView, readView, () => "list" as ViewMode);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [side, setSide] = useState<SidebarData>({ roots: [], favorites: [], tags: [], smart: [], usage: null });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [colFile, setColFile] = useState<Row | null>(null);
  const [colDeep, setColDeep] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [searchText, setSearchText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [quick, setQuick] = useState<Row | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(initialFileId);
  const [uploads, setUploads] = useState<UploadProgress[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [retention, setRetention] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);

  const changeView = (v: ViewMode) => {
    writeView(v);
    setColFile(null);
    setColDeep(null);
  };

  const homePath = side.roots.find((r) => r.key === "home")?.path ?? null;
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // ---- sidebar data ----
  const applySide = useCallback((d: SideAnswer) => {
    const { roots, favorites, tags, smart, usage } = d;
    setSide((s) => ({
      roots: roots?.roots ?? s.roots,
      favorites: favorites ? favorites.items.map((i) => ({ id: i.id, kind: i.kind, name: i.name, path: i.path })) : s.favorites,
      tags: tags?.tags ?? s.tags,
      smart: smart?.smartFolders ?? s.smart,
      usage: usage?.usage ?? s.usage,
    }));
    const home = roots?.roots.find((r) => r.key === "home")?.path;
    if (home) setPlace((p) => (p.t === "folder" && p.path === "" ? { t: "folder", path: home } : p));
  }, []);
  const loadSide = useCallback(() => sideData(workspaceId).then(applySide), [workspaceId, applySide]);
  useEffect(() => {
    let live = true;
    sideData(workspaceId).then((d) => live && applySide(d));
    return () => {
      live = false;
    };
  }, [workspaceId, reloadKey, applySide]);

  useEffect(() => {
    if (!canAdmin) return;
    void fetch(`/api/files/settings?workspaceId=${encodeURIComponent(workspaceId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { versionRetention?: number } | null) => b?.versionRetention && setRetention(b.versionRetention))
      .catch(() => undefined);
  }, [canAdmin, workspaceId]);

  // ---- the rows of the current place ----
  const fetchPlace = useCallback(
    async (p: Place, offset: number): Promise<{ rows: Row[]; total: number; canEdit: boolean; folder: Listing["folder"] }> => {
      switch (p.t) {
        case "folder": {
          const r = await getJson<{ listing: Listing }>(treeUrl(workspaceId, "list", { path: p.path, sort: sort.key, dir: sort.dir, limit: PAGE, offset }), t("filesApp.loadFailed"));
          return { rows: r.listing.items.map((i) => rowFromItem(i)), total: r.listing.total, canEdit: r.listing.canEdit, folder: r.listing.folder };
        }
        case "recents": {
          const r = await getJson<{ items: ApiItem[] }>(treeUrl(workspaceId, "recents"));
          return { rows: r.items.map((i) => rowFromItem(i)), total: r.items.length, canEdit: false, folder: null };
        }
        case "shared": {
          const r = await getJson<{ items: ApiSharedItem[] }>(treeUrl(workspaceId, "shared"));
          return { rows: r.items.map(rowFromShared), total: r.items.length, canEdit: false, folder: null };
        }
        case "trash": {
          const r = await getJson<{ items: ApiTrashItem[] }>(treeUrl(workspaceId, "trash"));
          return { rows: r.items.map(rowFromTrash), total: r.items.length, canEdit: true, folder: null };
        }
        case "tag": {
          const r = await getJson<{ items: ApiItem[] }>(treeUrl(workspaceId, "tag", { tag: p.tag }));
          return { rows: r.items.map((i) => rowFromItem(i)), total: r.items.length, canEdit: false, folder: null };
        }
        case "search":
        case "smart": {
          const q = p.query;
          const r = await getJson<{ results: Array<{ kind: string; id: string; title: string; subtitle: string | null }> }>(`/api/search/records?${new URLSearchParams({ q, kinds: "file,file_content,folder", limit: "20" }).toString()}`);
          const seen = new Set<string>();
          const out: Row[] = [];
          for (const h of r.results) {
            if (seen.has(h.id)) continue;
            seen.add(h.id);
            const folder = h.kind === "folder";
            const shown = h.subtitle && h.subtitle.startsWith("/") ? displayPath(h.subtitle) : (h.subtitle ?? "");
            out.push({ kind: folder ? "folder" : "file", id: h.id, name: h.title, path: shown, mimeType: null, sizeBytes: null, modifiedAt: null, version: null, tags: [], color: null, system: false, favorite: false, canEdit: false, note: shown });
          }
          return { rows: out, total: out.length, canEdit: false, folder: null };
        }
      }
    },
    [workspaceId, sort.key, sort.dir, t],
  );

  const placeKey = place.t === "folder" && place.path === "" ? null : JSON.stringify([place, sort.key, sort.dir, reloadKey]); // "" = waiting for the roots to name the home folder
  useEffect(() => {
    if (placeKey === null) return;
    let live = true;
    fetchPlace(place, 0)
      .then((r) => live && setLoaded({ key: placeKey, rows: r.rows, total: r.total, canEdit: r.canEdit, error: null }))
      .catch((e) => live && setLoaded({ key: placeKey, rows: [], total: 0, canEdit: false, error: e instanceof Error ? e.message : t("filesApp.loadFailed") }));
    return () => {
      live = false;
    };
  }, [place, placeKey, fetchPlace, t]);
  const current = loaded && loaded.key === placeKey ? loaded : null;
  const rows = current ? current.rows : null;
  const total = current?.total ?? 0;
  const folderCanEdit = current?.canEdit ?? false;
  const loadError = current?.error ?? null;

  // Stable identity: the columns view reloads when this changes.
  const loadColumn = useCallback((path: string) => fetchPlace({ t: "folder", path }, 0).then((r) => r.rows), [fetchPlace]);

  async function loadMore() {
    if (!rows || place.t !== "folder") return;
    setLoadingMore(true);
    try {
      const r = await fetchPlace(place, rows.length);
      setLoaded((cur) => (cur && cur.key === placeKey ? { ...cur, rows: [...cur.rows, ...r.rows] } : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("filesApp.loadFailed"));
    } finally {
      setLoadingMore(false);
    }
  }

  // ---- navigation ----
  const go = useCallback((p: Place) => {
    setPlace((cur) => {
      if (!samePlace(cur, p)) setBack((b) => [...b.slice(-30), cur]);
      return p;
    });
    setColDeep(null);
    setColFile(null);
    setSelected(new Set());
    setError(null);
    setFilter("");
    if (p.t !== "search") setSearchText("");
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("file");
      if (p.t === "folder") url.searchParams.set("path", p.path);
      else url.searchParams.delete("path");
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      /* the address bar is a nicety */
    }
  }, []);
  function goBack() {
    setBack((b) => {
      const prev = b[b.length - 1];
      if (prev) {
        setPlace(prev);
        setColDeep(null);
      }
      return b.slice(0, -1);
    });
  }
  const setFileParam = useCallback((id: string | null) => {
    setOpenFile(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("file", id);
    else url.searchParams.delete("file");
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  // ---- the "Open with" built-ins ----
  useEffect(() => {
    const offs = [
      registerOpenWith({ id: "drive:quick-look", label: t("drive.actions.quickLook"), order: 0, accepts: (r) => r.kind === "file", open: (r) => setQuick(r) }),
      registerOpenWith({ id: "drive:details", label: t("drive.actions.details"), order: 1, accepts: (r) => r.kind === "file", open: (r) => setFileParam(r.id) }),
      registerOpenWith({ id: "drive:download", label: t("filesApp.download"), order: 2, accepts: (r) => r.kind === "file", open: (r) => {
          const a = document.createElement("a");
          a.href = `/api/files/${encodeURIComponent(r.id)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`;
          a.click();
        } }),
    ];
    return () => offs.forEach((off) => off());
  }, [t, workspaceId, setFileParam]);

  // ---- what is shown ----
  const shown = useMemo(() => {
    if (!rows) return null;
    const f = filterRows(rows, filter);
    return place.t === "folder" ? f : sortRows(f, sort.key, sort.dir);
  }, [rows, filter, place.t, sort.key, sort.dir]);

  const selRows: Row[] = useMemo(() => (view === "columns" && place.t === "folder" ? (colFile ? [colFile] : []) : (shown ?? []).filter((r) => selected.has(r.id))), [view, place.t, colFile, shown, selected]);
  const dir = place.t === "folder" ? (view === "columns" && colDeep ? colDeep : place.path) : null;
  const inTrash = place.t === "trash";
  const writableHere = canEdit && place.t === "folder" && folderCanEdit && !!dir;

  function onSelect(row: Row, ev: SelectEvent) {
    const list = shown ?? [];
    setSelected((cur) => {
      const next = new Set(ev.additive || ev.range ? cur : []);
      if (ev.range && anchor.current) {
        const a = list.findIndex((r) => r.id === anchor.current);
        const b = list.findIndex((r) => r.id === row.id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(list[i]!.id);
          return next;
        }
      }
      if (ev.additive && cur.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      anchor.current = row.id;
      return next;
    });
  }

  function open(row: Row) {
    if (row.kind === "folder") go({ t: "folder", path: row.path });
    else setFileParam(row.id);
  }

  // ---- doing things ----
  async function run<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    setDialogError(null);
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : fallback;
      if (dialog) setDialogError(msg);
      else setError(msg);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const items = (rs: Row[]) => rs.map((r) => ({ kind: r.kind, id: r.id }));

  async function trashSelected() {
    if (selRows.length === 0) return;
    const r = await run(() => postJson<{ trashed: number }>("/api/drive/ops", { workspaceId, action: "trash", items: items(selRows) }), t("filesApp.actionFailed"));
    if (r) {
      toast({ title: t("drive.toasts.trashed", { count: selRows.length }) });
      setSelected(new Set());
      setColFile(null);
      reload();
    }
  }
  async function restoreSelected() {
    const r = await run(() => postJson("/api/drive/ops", { workspaceId, action: "restore", items: items(selRows) }), t("filesApp.actionFailed"));
    if (r) {
      toast({ title: t("drive.toasts.restored", { count: selRows.length }) });
      reload();
    }
  }
  async function purgeSelected() {
    const files = selRows.filter((r) => r.kind === "file");
    if (files.length === 0) return;
    const ok = await confirmAction({ title: t("drive.confirm.purgeTitle", { count: files.length }), description: t("filesApp.purgeConfirm"), confirmLabel: t("filesApp.deleteForever"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    const r = await run(async () => {
      for (const f of files) await postJson("/api/drive/ops", { workspaceId, action: "purge", id: f.id });
      return true;
    }, t("filesApp.deleteFailed"));
    if (r) reload();
  }
  async function createFolder(name: string) {
    if (!dir) return;
    const r = await run(() => postJson("/api/drive/ops", { workspaceId, action: "create_folder", path: `${dir === "/" ? "" : dir}/${name}` }), t("filesApp.actionFailed"));
    if (r) {
      setDialog(null);
      reload();
    }
  }
  async function renameRow(row: Row, name: string) {
    const r = await run(() => postJson("/api/drive/ops", { workspaceId, action: "rename", kind: row.kind, id: row.id, name }), t("filesApp.actionFailed"));
    if (r) {
      setDialog(null);
      reload();
    }
  }
  async function moveRows(rs: Row[], toDir: string) {
    const r = await run(() => postJson("/api/drive/ops", { workspaceId, action: "move", items: items(rs), toDir }), t("filesApp.actionFailed"));
    if (r) {
      setDialog(null);
      toast({ title: t("drive.toasts.moved", { count: rs.length }) });
      setSelected(new Set());
      setColFile(null);
      reload();
    }
  }
  async function toggleFavorite(row: Row) {
    const r = await run(() => postJson("/api/drive/ops", { workspaceId, action: "favorite", kind: row.kind, id: row.id, on: !row.favorite }), t("filesApp.actionFailed"));
    if (r) {
      setLoaded((cur) => (cur ? { ...cur, rows: cur.rows.map((x) => (x.id === row.id ? { ...x, favorite: !row.favorite } : x)) } : cur));
      void loadSide();
    }
  }
  async function saveTags(row: Row, raw: string) {
    const tags = raw.split(",").map((x) => x.trim()).filter(Boolean);
    const r = await run(() => (row.kind === "file" ? postJson("/api/drive/ops", { workspaceId, action: "set_tags", id: row.id, tags: raw }) : postJson("/api/drive/ops", { workspaceId, action: "set_folder", id: row.id, tags })), t("filesApp.actionFailed"));
    if (r) {
      setDialog(null);
      reload();
    }
  }
  async function saveSmart(name: string, query: string) {
    const r = await run(() => postJson("/api/drive/ops", { workspaceId, action: "smart_save", name, query }), t("filesApp.actionFailed"));
    if (r) {
      setDialog(null);
      void loadSide();
    }
  }
  async function removeSmart(id: string) {
    await run(() => postJson("/api/drive/ops", { workspaceId, action: "smart_remove", id }), t("filesApp.actionFailed"));
    if (place.t === "smart" && place.id === id) go(homePath ? { t: "folder", path: homePath } : { t: "recents" });
    void loadSide();
  }
  async function applyProposal(row: Row) {
    const r = await run(() => postJson<{ version: number; path: string }>("/api/drive/proposals", { workspaceId, fileId: row.id }), t("filesApp.actionFailed"));
    if (r) {
      toast({ title: t("drive.toasts.applied", { path: displayPath(r.path) }) });
      reload();
    }
  }
  async function saveRetention(n: number) {
    const res = await fetch("/api/files/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, versionRetention: n }) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { versionRetention?: number; purged?: number; error?: string } | null;
    if (!res?.ok || !body?.versionRetention) {
      toastError(t("filesApp.retention.failed"), body?.error);
      return;
    }
    setRetention(body.versionRetention);
    toast({ title: t("filesApp.retention.saved", { n: body.versionRetention }), ...(body.purged ? { description: t("filesApp.retention.purged", { count: body.purged }) } : {}) });
  }

  // ---- uploading ----
  async function startUpload(jobs: ReturnType<typeof jobsFromFiles>) {
    if (!writableHere || !dir || jobs.length === 0) return;
    setBusy(true);
    setError(null);
    const done = await uploadBatch(jobs, {
      workspaceId,
      dir,
      onProgress: setUploads,
      onConflict: async (name) =>
        (await confirmAction({ title: t("filesApp.replace.title", { name }), description: t("filesApp.replace.body"), confirmLabel: t("filesApp.replace.confirm"), cancelLabel: t("filesApp.replace.keep") })) ? "replace" : "skip",
    });
    setBusy(false);
    const ok = done.filter((d) => d.status === "done").length;
    const failed = done.filter((d) => d.status === "failed");
    if (ok > 0) toast({ title: t("drive.toasts.uploaded", { count: ok }) });
    if (failed.length > 0) setError(t("drive.upload.failedSome", { count: failed.length, first: `${failed[0]!.name}: ${failed[0]!.error ?? ""}` }));
    reload();
  }
  async function unpackZip(file: File) {
    if (!writableHere || !dir) return;
    const form = new FormData();
    form.append("workspaceId", workspaceId);
    form.append("dir", dir);
    form.append("file", file);
    const r = await run(async () => {
      const res = await fetch("/api/drive/extract", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { created?: unknown[]; rejected?: unknown[]; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? t("filesApp.uploadFailed"));
      return body;
    }, t("filesApp.uploadFailed"));
    if (r) {
      toast({ title: t("drive.toasts.unpacked", { count: r.created?.length ?? 0, skipped: r.rejected?.length ?? 0 }) });
      reload();
    }
  }
  function onDrop(e: DragEvent) {
    setDragOver(false);
    if (!writableHere) return;
    e.preventDefault();
    void jobsFromDrop(e.dataTransfer as unknown as Parameters<typeof jobsFromDrop>[0]).then(startUpload);
  }

  // ---- keyboard (Finder-ish) ----
  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.key === " " && selRows.length === 1 && selRows[0]!.kind === "file") {
      e.preventDefault();
      setQuick(selRows[0]!);
    } else if ((e.key === "Delete" || e.key === "Backspace") && !inTrash && selRows.length > 0 && selRows.every((r) => r.canEdit) && canEdit) {
      e.preventDefault();
      void trashSelected();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && shown) {
      e.preventDefault();
      setSelected(new Set(shown.map((r) => r.id)));
    } else if (e.key === "Escape" && selected.size > 0) {
      setSelected(new Set());
    }
  }

  // ---- labels ----
  const placeTitle = (() => {
    switch (place.t) {
      case "recents":
        return t("drive.sidebar.recents");
      case "shared":
        return t("drive.sidebar.sharedWithMe");
      case "trash":
        return t("drive.roots.trash");
      case "tag":
        return t("drive.places.tag", { tag: place.tag });
      case "search":
        return t("drive.places.search", { query: place.query });
      case "smart":
        return place.name;
      default:
        return t("filesApp.folderLabel");
    }
  })();
  const crumbs = useMemo(() => {
    if (place.t !== "folder" || !dir) return [] as Array<{ name: string; path: string }>;
    const segs = dir.split("/").filter(Boolean);
    return segs.map((s, i) => {
      const path = `/${segs.slice(0, i + 1).join("/")}`;
      const name = homePath && path === homePath ? t("drive.roots.home") : i === 0 && ["shared", "agents", "apps", "mounts"].includes(s) ? t(`drive.roots.${s}` as never) : s;
      return { name, path };
    });
  }, [place.t, dir, homePath, t]);
  const dateLabel = inTrash ? t("drive.table.trashedOn") : place.t === "shared" ? t("drive.table.sharedOn") : t("drive.table.modified");
  const noteLabel = place.t === "folder" ? undefined : place.t === "shared" ? t("drive.table.access") : t("drive.table.where");

  const single = selRows.length === 1 ? selRows[0]! : null;
  const allEditable = selRows.length > 0 && selRows.every((r) => r.canEdit) && canEdit;
  const isProposal = !!single && single.kind === "file" && /^\/agents\/[^/]+\/proposed\//.test(single.path);
  const appHandlers = single && single.kind === "file" ? openWithFor(single).filter((h) => h.appId) : [];
  const empty = place.t === "trash" ? t("filesApp.trashEmpty") : place.t === "recents" ? t("drive.states.noRecents") : place.t === "shared" ? t("drive.states.noShared") : place.t === "tag" ? t("drive.states.noTagged") : place.t === "search" || place.t === "smart" ? t("drive.states.noResults") : writableHere ? t("filesApp.emptyEditable") : t("filesApp.empty");
  const caption = place.t === "folder" ? t("filesApp.folderLabel") : placeTitle;

  const btn = (variant: "secondary" | "quiet" | "deny" | "primary" = "secondary") => aosButton({ variant: variant === "primary" ? undefined : variant, size: "xs" });
  const retentionOpts = retention ? [...new Set([1, 5, 10, 20, 50, 100, 200, retention])].sort((a, b) => a - b) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]" onKeyDown={onKeyDown}>
      <aside className="max-lg:order-last">
        <DriveSidebar place={place} data={side} onGo={go} onRemoveSmart={(id) => void removeSmart(id)} />
      </aside>

      <div className="flex min-w-0 flex-col gap-3">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={goBack} disabled={back.length === 0} aria-label={t("common.back")} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })}>
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          {place.t === "folder" ? (
            <nav aria-label={t("filesApp.breadcrumbs")} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-1">
                  {i > 0 ? (
                    <span className="text-subtle" aria-hidden>
                      /
                    </span>
                  ) : null}
                  {i === crumbs.length - 1 ? (
                    <span className="font-semibold text-ink" aria-current="location">
                      {c.name}
                    </span>
                  ) : (
                    <button type="button" onClick={() => go({ t: "folder", path: c.path })} className="rounded-sm text-muted hover:text-ink">
                      {c.name}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          ) : (
            <h2 className="text-md font-semibold text-ink">{placeTitle}</h2>
          )}
          <form
            role="search"
            className="ml-auto flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              const q = searchText.trim();
              if (q) go({ t: "search", query: q });
            }}
          >
            <label className="relative">
              <span className="sr-only">{t("drive.toolbar.search")}</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
              <input
                type="search"
                value={searchText}
                onChange={(e) => {
                  setSearchText(e.target.value);
                  setFilter(e.target.value);
                }}
                placeholder={t("drive.toolbar.searchPlaceholder")}
                className="h-control-sm w-44 rounded-full border-[1.5px] border-control bg-paper pl-8 pr-3 text-sm text-ink outline-none focus:border-focus sm:w-56"
              />
            </label>
            <button type="submit" disabled={!searchText.trim()} className={btn("quiet")}>
              {t("drive.toolbar.searchAll")}
            </button>
          </form>
          {place.t === "folder" ? (
            <Segmented<ViewMode>
              value={view}
              onChange={changeView}
              label={t("drive.toolbar.view")}
              options={[
                { value: "list", label: t("drive.toolbar.viewList") },
                { value: "icons", label: t("drive.toolbar.viewIcons") },
                { value: "columns", label: t("drive.toolbar.viewColumns") },
              ]}
            />
          ) : null}
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("drive.toolbar.actions")}>
          {writableHere ? (
            <>
              <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { void startUpload(jobsFromFiles(e.target.files ?? [])); e.target.value = ""; }} />
              <input ref={folderInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(e) => { void startUpload(jobsFromFiles(e.target.files ?? [])); e.target.value = ""; }} />
              <input ref={zipInput} type="file" accept=".zip,application/zip" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void unpackZip(f); e.target.value = ""; }} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy} className={aosButton({ size: "xs" })}>
                <Upload className="size-3.5" aria-hidden /> {busy && uploads ? t("filesApp.uploading") : t("filesApp.upload")}
              </button>
              <button type="button" onClick={() => folderInput.current?.click()} disabled={busy} className={btn()}>
                <FolderUp className="size-3.5" aria-hidden /> {t("drive.actions.uploadFolder")}
              </button>
              <button type="button" onClick={() => { setDialogError(null); setDialog({ type: "newFolder" }); }} className={btn()}>
                <FolderPlus className="size-3.5" aria-hidden /> {t("drive.actions.newFolder")}
              </button>
              <button type="button" onClick={() => zipInput.current?.click()} disabled={busy} className={btn("quiet")}>
                <FileArchive className="size-3.5" aria-hidden /> {t("drive.actions.unpackZip")}
              </button>
            </>
          ) : null}
          {place.t === "folder" && dir && canEdit ? (
            <button type="button" onClick={() => setDialog({ type: "asOf", path: dir })} className={btn("quiet")}>
              <History className="size-3.5" aria-hidden /> {t("drive.actions.restoreAsOf")}
            </button>
          ) : null}
          {place.t === "search" ? (
            <button type="button" onClick={() => setDialog({ type: "saveSmart", query: place.query })} className={btn("quiet")}>
              <Star className="size-3.5" aria-hidden /> {t("drive.actions.saveSmart")}
            </button>
          ) : null}
        </div>

        {/* selection bar: a fixed-height row (icon buttons that gain labels when there is room) so the rows never jump between the two clicks of a double click */}
        {selRows.length > 0 ? (
          <div className="@container flex h-12 items-center gap-1.5 overflow-x-auto rounded-lg bg-canvas px-3" role="toolbar" aria-label={t("drive.selection.actions")}>
            <span className="mr-1 shrink-0 text-sm font-semibold text-ink" role="status">
              {t("drive.selection.count", { count: selRows.length })}
            </span>
            {inTrash ? (
              <>
                <Act icon={RotateCcw} label={t("filesApp.restore")} onClick={() => void restoreSelected()} disabled={busy} />
                {canPurge && selRows.some((r) => r.kind === "file") ? <Act icon={Trash} label={t("filesApp.deleteForever")} onClick={() => void purgeSelected()} disabled={busy} variant="deny" /> : null}
              </>
            ) : (
              <>
                {single && single.kind === "file" ? (
                  <>
                    <Act icon={Eye} label={t("drive.actions.quickLook")} onClick={() => setQuick(single)} />
                    <Act icon={Download} label={t("filesApp.download")} href={`/api/files/${encodeURIComponent(single.id)}?workspaceId=${encodeURIComponent(workspaceId)}&download=1`} />
                  </>
                ) : null}
                {single ? <Act icon={FolderOpen} label={t("filesApp.open")} onClick={() => open(single)} /> : null}
                {appHandlers.map((h) => (
                  <button key={h.id} type="button" onClick={() => void h.open(single!)} className={cn(btn(), "shrink-0")}>
                    {h.label}
                  </button>
                ))}
                {single && !single.system ? <Act icon={Star} label={single.favorite ? t("drive.actions.unfavoriteShort") : t("drive.actions.favoriteShort")} onClick={() => void toggleFavorite(single)} pressed={single.favorite} /> : null}
                {isProposal && canEdit ? <Act icon={PackageCheck} label={t("drive.actions.applyProposal")} onClick={() => void applyProposal(single!)} disabled={busy} /> : null}
                {single && single.kind === "folder" && canEdit && !single.system ? <Act icon={Users} label={t("drive.actions.share")} onClick={() => setDialog({ type: "share", row: single })} /> : null}
                {single && canEdit && !single.system ? (
                  <Act icon={Tag} label={t("drive.actions.tags")} onClick={() => { setDialogError(null); setDialog({ type: "tags", row: single }); }} />
                ) : null}
                {single && allEditable && !single.system ? (
                  <Act icon={Pencil} label={t("filesApp.rename")} onClick={() => { setDialogError(null); setDialog({ type: "rename", row: single }); }} />
                ) : null}
                {allEditable && !selRows.some((r) => r.system) ? (
                  <>
                    <Act icon={FolderInput} label={t("filesApp.move")} onClick={() => { setDialogError(null); setDialog({ type: "move", rows: selRows }); }} />
                    <Act icon={Trash} label={t("filesApp.trashAction")} onClick={() => void trashSelected()} disabled={busy} variant="deny" />
                  </>
                ) : null}
              </>
            )}
            <button type="button" onClick={() => { setSelected(new Set()); setColFile(null); }} aria-label={t("drive.selection.clear")} className={aosButton({ variant: "quiet", size: "xs", className: "ml-auto w-8 shrink-0 px-0" })}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ) : (
          <div className="flex h-12 items-center rounded-lg bg-canvas px-3">
            <p className="truncate text-sm text-muted">{t("drive.selection.hint")}</p>
          </div>
        )}

        {error ?? loadError ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-failed-tint px-3 py-2 text-sm font-semibold text-failed-text">
            <span className="mt-1 size-2 shrink-0 bg-failed" aria-hidden="true" />
            <span>{error ?? loadError}</span>
          </div>
        ) : null}

        {uploads ? (
          <section aria-label={t("drive.upload.title")} className="rounded-lg bg-paper px-4 py-3 shadow-hairline">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">{t("drive.upload.title")}</h2>
              <p className="text-xs text-muted" role="status">
                {t("drive.upload.progress", { percent: batchPercent(uploads), done: uploads.filter((u) => u.status === "done").length, count: uploads.length })}
              </p>
              {!busy ? (
                <button type="button" onClick={() => setUploads(null)} aria-label={t("common.close")} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })}>
                  <X className="size-4" aria-hidden />
                </button>
              ) : null}
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={batchPercent(uploads)} aria-label={t("drive.upload.title")}>
              <div className="h-full rounded-full bg-ink" style={{ width: `${batchPercent(uploads)}%` }} />
            </div>
            <ul className="mt-2 max-h-32 divide-y divide-line overflow-auto text-sm">
              {uploads.slice(0, 50).map((u) => (
                <li key={u.id} className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{u.name}</span>
                  <span className={cn("text-xs", u.status === "failed" ? "font-semibold text-failed-text" : "text-muted")}>
                    {u.status === "done" ? <Check className="inline size-3.5" aria-label={t("drive.upload.done")} /> : u.status === "failed" ? (u.error ?? t("drive.upload.failed")) : t(`drive.upload.${u.status}` as never)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* the folder */}
        <section
          aria-label={caption}
          className={cn("min-w-0 rounded-lg bg-paper", dragOver ? "shadow-outline" : "shadow-hairline")}
          onDragOver={(e) => {
            if (writableHere) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {shown === null ? (
            <p className="px-4 py-8 text-center text-sm text-muted">{t("common.loading")}</p>
          ) : view === "columns" && place.t === "folder" ? (
            <ColumnsView key={`${place.path}:${reloadKey}`} startPath={place.path} load={loadColumn} onNavigate={setColDeep} onSelectFile={setColFile} onOpenFile={(r) => setFileParam(r.id)} caption={t("filesApp.folderLabel")} />
          ) : shown.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted">{empty}</p>
          ) : view === "icons" && place.t === "folder" ? (
            <IconView rows={shown} selected={selected} onSelect={onSelect} onOpen={open} caption={caption} />
          ) : (
            <ListView
              rows={shown}
              selected={selected}
              onSelect={onSelect}
              onOpen={open}
              onToggleFavorite={inTrash ? undefined : (r) => void toggleFavorite(r)}
              sort={sort}
              onSort={(key) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }))}
              dateLabel={dateLabel}
              noteLabel={noteLabel}
              caption={caption}
              showKind={place.t !== "shared"}
            />
          )}
          {rows && place.t === "folder" && view !== "columns" && rows.length < total ? (
            <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
              <p className="text-xs text-muted">{t("drive.states.showing", { shown: rows.length, total })}</p>
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className={btn()}>
                {loadingMore ? t("common.loading") : t("drive.actions.loadMore")}
              </button>
            </div>
          ) : null}
        </section>

        {canAdmin && retention ? (
          <label className="flex flex-wrap items-center gap-2 text-sm text-muted">
            {t("filesApp.retention.label")}
            <select value={retention} onChange={(e) => void saveRetention(Number(e.target.value))} className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink">
              {retentionOpts.map((n) => (
                <option key={n} value={n}>
                  {t("filesApp.retention.option", { n })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {dialog?.type === "newFolder" ? <NameDialog title={t("drive.actions.newFolder")} label={t("drive.dialogs.folderName")} confirmLabel={t("drive.actions.create")} busy={busy} error={dialogError} onSubmit={(v) => void createFolder(v)} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === "rename" ? <NameDialog title={t("filesApp.renameTitle")} label={t("filesApp.newName")} initial={dialog.row.name} confirmLabel={t("filesApp.rename")} busy={busy} error={dialogError} onSubmit={(v) => void renameRow(dialog.row, v)} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === "saveSmart" ? <NameDialog title={t("drive.actions.saveSmart")} label={t("drive.dialogs.smartName")} initial={dialog.query} confirmLabel={t("common.save")} busy={busy} error={dialogError} onSubmit={(v) => void saveSmart(v, dialog.query)} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === "move" ? <MoveDialog workspaceId={workspaceId} count={dialog.rows.length} startPath={dir ?? homePath ?? "/shared"} busy={busy} error={dialogError} onChoose={(d) => void moveRows(dialog.rows, d)} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === "share" ? <ShareDialog workspaceId={workspaceId} folder={dialog.row} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === "tags" ? <TagsDialog row={dialog.row} busy={busy} error={dialogError} onSave={(v) => void saveTags(dialog.row, v)} onClose={() => setDialog(null)} /> : null}
      {dialog?.type === "asOf" ? <RestoreAsOfDialog workspaceId={workspaceId} folderPath={dialog.path} onClose={() => setDialog(null)} onDone={reload} /> : null}
      {quick ? <QuickLook workspaceId={workspaceId} row={quick} onClose={() => setQuick(null)} onDetails={() => { const id = quick.id; setQuick(null); setFileParam(id); }} /> : null}
      {openFile ? <FileDetail workspaceId={workspaceId} fileId={openFile} onClose={() => setFileParam(null)} onChanged={reload} /> : null}
    </div>
  );
}

