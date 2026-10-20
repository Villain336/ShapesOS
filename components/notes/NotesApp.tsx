"use client";

// ShapesOS — Phase 18.2 (WS=content): the Notes app (/dashboard/notes).
//
// Left: search, filters (all / pinned / mine / shared), folders and tags, the
// list. Right: the open note — title, pin, who sees it, folder, tags, the
// records it is linked to, version history, and the block editor (live
// co-editing when the collab server is on; autosave otherwise). Everything
// goes through /api/notes (lib/notes/service.ts decides who may do what).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Popover } from "@base-ui/react/popover";
import { FileText, Folder, History, Link2, Pin, PinOff, Plus, Search, Tag, Trash2, Users, X } from "lucide-react";
import { aosButton, FilterPill, NeutralBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { NoteDetail, NoteSummary } from "@/lib/notes/service";
import type { MessageKey } from "@/lib/i18n";
import { LinkRecordPicker, type PickedRecord } from "./LinkRecordPicker";
import { VersionHistory } from "./VersionHistory";
import { VoiceNoteButton } from "./VoiceNoteButton";
import type { CollabConfig, CollabStatus } from "./NoteEditor";
import { recordHref } from "@/lib/notes/links";
import { NOTES_CHANGED_EVENT, notifyNotesChanged } from "./events";
import { ShareMenu } from "@/components/share/ShareMenu";

const NoteEditor = dynamic(() => import("./NoteEditor"), { ssr: false });

type Scope = "all" | "pinned" | "mine" | "shared";

export interface NotesAppProps {
  initialNotes: NoteSummary[];
  initialFacets: { folders: string[]; tags: string[] };
  initialNote: NoteDetail | null;
}

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, data: body };
  } catch {
    return { ok: false, status: 0, error: "network" };
  }
}

function setUrlNote(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("note", id);
  else url.searchParams.delete("note");
  window.history.replaceState(window.history.state, "", url.toString());
}

export function NotesApp({ initialNotes, initialFacets, initialNote }: NotesAppProps) {
  const { t, format } = useI18n();
  const [notes, setNotes] = useState(initialNotes);
  const [facets, setFacets] = useState(initialFacets);
  const [scope, setScope] = useState<Scope>("all");
  const [folder, setFolder] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [current, setCurrent] = useState<NoteDetail | null>(initialNote);
  const [loadingNote, setLoadingNote] = useState(false);

  const refresh = useCallback(async () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (scope === "pinned") p.set("pinned", "1");
    if (scope === "mine" || scope === "shared") p.set("scope", scope);
    if (folder) p.set("folder", folder);
    if (tag) p.set("tag", tag);
    const res = await api<{ notes: NoteSummary[]; facets: { folders: string[]; tags: string[] } }>(`/api/notes?${p.toString()}`);
    if (res.ok) {
      setNotes(res.data.notes);
      if (res.data.facets) setFacets(res.data.facets);
    }
  }, [q, scope, folder, tag]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(() => void refresh(), 200);
    return () => clearTimeout(timer);
  }, [refresh]);

  // A note saved elsewhere (quick capture, a voice note) refreshes the list.
  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener(NOTES_CHANGED_EVENT, on);
    return () => window.removeEventListener(NOTES_CHANGED_EVENT, on);
  }, [refresh]);

  const open = useCallback(
    async (id: string) => {
      setLoadingNote(true);
      const res = await api<{ note: NoteDetail }>(`/api/notes/${encodeURIComponent(id)}`);
      setLoadingNote(false);
      if (!res.ok) {
        toastError(t("notes.openFailed"));
        return;
      }
      setCurrent(res.data.note);
      setUrlNote(id);
    },
    [t],
  );

  async function createBlank() {
    const res = await api<{ note: NoteDetail }>("/api/notes", { method: "POST", body: JSON.stringify({ title: t("notes.untitled"), folder: folder ?? undefined, tags: tag ? [tag] : undefined }) });
    if (!res.ok) {
      toastError(t("notes.createFailed"), res.error);
      return;
    }
    setCurrent(res.data.note);
    setUrlNote(res.data.note.id);
    void refresh();
  }

  const onNoteChanged = useCallback((n: NoteDetail) => {
    setCurrent(n);
    setNotes((list) => {
      const i = list.findIndex((x) => x.id === n.id);
      const summary: NoteSummary = { ...n };
      if (i < 0) return [summary, ...list];
      const copy = list.slice();
      copy[i] = summary;
      return copy;
    });
  }, []);

  const onDeleted = useCallback(
    (id: string) => {
      setCurrent(null);
      setUrlNote(null);
      setNotes((list) => list.filter((n) => n.id !== id));
      void refresh();
    },
    [refresh],
  );

  const scopes: Array<{ value: Scope; label: string }> = [
    { value: "all", label: t("notes.filters.all") },
    { value: "pinned", label: t("notes.filters.pinned") },
    { value: "mine", label: t("notes.filters.mine") },
    { value: "shared", label: t("notes.filters.shared") },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="aos-heading">{t("notes.title")}</h1>
          <p className="mt-1 text-md text-muted">{t("notes.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VoiceNoteButton
            onSaved={(n) => {
              onNoteChanged(n);
              setUrlNote(n.id);
              void refresh();
            }}
          />
          <button type="button" onClick={() => void createBlank()} className={aosButton({ size: "sm" })}>
            <Plus className="size-4" aria-hidden />
            {t("notes.new")}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section aria-label={t("notes.listLabel")} className="flex min-h-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline">
          <label className="relative block">
            <span className="sr-only">{t("notes.searchLabel")}</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("notes.searchPlaceholder")}
              className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
            />
          </label>
          <div role="group" aria-label={t("notes.filters.label")} className="flex flex-wrap gap-1.5">
            {scopes.map((s) => (
              <FilterPill key={s.value} selected={scope === s.value} onClick={() => setScope(s.value)}>
                {s.label}
              </FilterPill>
            ))}
          </div>
          {facets.folders.length || facets.tags.length ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("notes.filters.foldersAndTags")}>
              {facets.folders.map((f) => (
                <FilterPill key={`f:${f}`} selected={folder === f} onClick={() => setFolder(folder === f ? null : f)}>
                  <Folder className="size-3.5" aria-hidden />
                  {f}
                </FilterPill>
              ))}
              {facets.tags.map((x) => (
                <FilterPill key={`t:${x}`} selected={tag === x} onClick={() => setTag(tag === x ? null : x)}>
                  <Tag className="size-3.5" aria-hidden />
                  {x}
                </FilterPill>
              ))}
            </div>
          ) : null}
          {notes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
              <FileText className="size-6 text-subtle" aria-hidden />
              <p className="text-md font-semibold text-ink">{q || scope !== "all" || folder || tag ? t("notes.emptyFiltered") : t("notes.emptyTitle")}</p>
              <p className="max-w-[28ch] text-sm text-muted">{t("notes.emptyBody")}</p>
            </div>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {notes.map((n) => {
                const active = current?.id === n.id;
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => void open(n.id)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full flex-col gap-0.5 rounded-sm px-2.5 py-2 text-left ${active ? "bg-ink text-paper" : "hover:bg-hover-paper"}`}
                    >
                      <span className="flex items-center gap-1.5">
                        {n.pinned ? <Pin className={`size-3.5 shrink-0 ${active ? "text-on-ink-muted" : "text-muted"}`} aria-label={t("notes.pinned")} /> : null}
                        <span className="truncate text-md font-semibold">{n.title}</span>
                      </span>
                      {n.preview ? <span className={`line-clamp-2 text-sm ${active ? "text-on-ink-muted" : "text-muted"}`}>{n.preview}</span> : null}
                      {/* Relative time: the server's "now" and the browser's differ by the render gap. */}
                      <span suppressHydrationWarning className={`text-xs ${active ? "text-on-ink-muted" : "text-muted"}`}>
                        {format.relative(n.updatedAt)}
                        {n.shareState === "workspace" ? ` · ${t("notes.sharedShort")}` : ""}
                        {n.links.length ? ` · ${t("notes.linkCount", { count: n.links.length })}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label={t("notes.editorLabel")} className="min-w-0 rounded-lg bg-paper p-4 shadow-hairline sm:p-6">
          {current ? (
            <NotePane key={current.id} note={current} onChanged={onNoteChanged} onDeleted={onDeleted} />
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
              <FileText className="size-7 text-subtle" aria-hidden />
              <h2 className="aos-subheading">{loadingNote ? t("common.loading") : t("notes.pickTitle")}</h2>
              <p className="max-w-[40ch] text-md text-muted">{t("notes.pickBody")}</p>
              <button type="button" onClick={() => void createBlank()} className={aosButton({ size: "sm" })}>
                <Plus className="size-4" aria-hidden />
                {t("notes.new")}
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

interface CollabTokenResponse {
  enabled: boolean;
  reason?: string;
  url?: string;
  docName?: string;
  token?: string;
  readOnly?: boolean;
  user?: { name: string; color: string };
}

function NotePane({
  note,
  onChanged,
  onDeleted,
}: {
  note: NoteDetail;
  onChanged: (n: NoteDetail) => void;
  onDeleted: (id: string) => void;
}) {
  const { t, format } = useI18n();
  const [title, setTitle] = useState(note.title);
  const [folderText, setFolderText] = useState(note.folder ?? "");
  const [tagsText, setTagsText] = useState(note.tags.join(", "));
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error" | "conflict">("saved");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [collab, setCollab] = useState<CollabConfig | null | undefined>(undefined);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>("connecting");
  const [peers, setPeers] = useState<string[]>([]);
  // Awareness fires on every caret move: keep the same array unless the names changed.
  const onPeers = useCallback((names: string[]) => setPeers((p) => (p.length === names.length && p.every((x, i) => x === names[i]) ? p : names)), []);
  const [editorKey, setEditorKey] = useState(0);
  const [content, setContent] = useState<unknown>(note.content);
  const version = useRef(note.version);
  const pending = useRef<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live collaboration when the server is configured (one token per connection).
  const fetchToken = useCallback(async () => {
    const res = await api<CollabTokenResponse>("/api/collab/token", { method: "POST", body: JSON.stringify({ kind: "note", id: note.id }) });
    if (!res.ok || !res.data.token) throw new Error("collab token refused");
    return res.data.token;
  }, [note.id]);

  useEffect(() => {
    let cancelled = false;
    void api<CollabTokenResponse>("/api/collab/token", { method: "POST", body: JSON.stringify({ kind: "note", id: note.id }) }).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data.enabled && res.data.url && res.data.docName && res.data.user) {
        setCollab({ url: res.data.url, docName: res.data.docName, readOnly: !!res.data.readOnly, user: res.data.user, fetchToken });
      } else setCollab(null);
    });
    return () => {
      cancelled = true;
    };
  }, [note.id, fetchToken]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await api<{ note: NoteDetail }>(`/api/notes/${encodeURIComponent(note.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      if (!res.ok) {
        if (res.status === 409) setSaveState("conflict");
        else {
          setSaveState("error");
          toastError(t("notes.saveFailed"), res.error);
        }
        return null;
      }
      version.current = res.data.note.version;
      onChanged(res.data.note);
      return res.data.note;
    },
    [note.id, onChanged, t],
  );

  // Single-editor mode: debounced autosave with optimistic concurrency.
  const flush = useCallback(async () => {
    if (pending.current === null) return;
    const json = pending.current;
    pending.current = null;
    setSaveState("saving");
    const saved = await patch({ content: json, expectedVersion: version.current });
    if (saved) setSaveState(pending.current === null ? "saved" : "saving");
  }, [patch]);

  const onEditorChange = useCallback(
    (json: unknown) => {
      pending.current = json;
      setSaveState("saving");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 800);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    [flush],
  );

  async function saveTitle() {
    const clean = title.trim();
    if (!clean || clean === note.title) {
      setTitle(note.title);
      return;
    }
    await patch({ title: clean });
  }

  async function saveMeta(body: Record<string, unknown>) {
    const n = await patch(body);
    if (n) {
      setFolderText(n.folder ?? "");
      setTagsText(n.tags.join(", "));
      notifyNotesChanged();
    }
  }

  async function addLink(r: PickedRecord) {
    setLinkOpen(false);
    const res = await api<{ note: NoteDetail }>(`/api/notes/${encodeURIComponent(note.id)}/links`, {
      method: "POST",
      body: JSON.stringify({ kind: r.kind, id: r.id, label: r.title }),
    });
    if (!res.ok) {
      toastError(t("notes.links.linkFailed"), res.error);
      return;
    }
    onChanged(res.data.note);
    toast({ title: t("notes.links.linked", { title: r.title }) });
  }

  async function removeLink(kind: string, id: string) {
    const res = await api<{ note: NoteDetail }>(`/api/notes/${encodeURIComponent(note.id)}/links?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.ok) onChanged(res.data.note);
    else toastError(t("notes.links.unlinkFailed"), res.error);
  }

  async function remove() {
    const ok = await confirmAction({
      title: t("notes.deleteConfirmTitle"),
      description: t("notes.deleteConfirmBody", { title: note.title }),
      confirmLabel: t("notes.delete"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!ok) return;
    const res = await api<{ ok: boolean }>(`/api/notes/${encodeURIComponent(note.id)}`, { method: "DELETE" });
    if (!res.ok) {
      toastError(t("notes.deleteFailed"), res.error);
      return;
    }
    toast({ title: t("notes.deleted") });
    onDeleted(note.id);
  }

  const kindLabel = (kind: string) => {
    const key = `records.kinds.${kind}` as MessageKey;
    const label = t(key);
    return label === key ? kind : label;
  };

  const readOnly = !note.canEdit || (collab?.readOnly ?? false);
  const statusText = collab
    ? collabStatus === "connected"
      ? peers.length
        ? t("notes.collab.withPeers", { names: peers.join(", ") })
        : t("notes.collab.live")
      : collabStatus === "denied"
        ? t("notes.collab.denied")
        : collabStatus === "disconnected"
          ? t("notes.collab.offline")
          : t("notes.collab.connecting")
    : saveState === "saving"
      ? t("common.saving")
      : saveState === "error"
        ? t("notes.saveFailed")
        : saveState === "conflict"
          ? t("notes.conflict")
          : t("common.saved");

  const excludeLinks = useMemo(() => note.links.map((l) => ({ kind: l.kind, id: l.id })), [note.links]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="sr-only">{t("notes.titleLabel")}</span>
          <input
            value={title}
            maxLength={200}
            readOnly={!note.canEdit}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-full rounded-md bg-transparent px-1 py-1 text-2xl font-bold tracking-[-0.01em] text-ink outline-none stretch-heading focus:bg-hover-paper"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={note.pinned}
            disabled={!note.canEdit}
            onClick={() => void saveMeta({ pinned: !note.pinned })}
            className={aosButton({ variant: note.pinned ? "primary" : "secondary", size: "xs" })}
          >
            {note.pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
            {note.pinned ? t("notes.unpin") : t("notes.pin")}
          </button>
          {note.canShare || note.shareState === "workspace" ? (
            <Segmented
              label={t("notes.shareLabel")}
              value={note.shareState}
              disabled={!note.canShare}
              onChange={(v) => void saveMeta({ shareState: v })}
              options={[
                { value: "private", label: t("notes.share.private") },
                { value: "workspace", label: t("notes.share.workspace") },
              ]}
            />
          ) : (
            <NeutralBadge size="sm" label={t("notes.share.private")} />
          )}
          <button type="button" onClick={() => setHistoryOpen(true)} className={aosButton({ variant: "quiet", size: "xs" })}>
            <History className="size-3.5" aria-hidden />
            {t("notes.history")}
          </button>
          {/* Phase 18.3 (WS=flow): the share sheet (Send to… / Open with). */}
          <ShareMenu record={{ kind: "note", id: note.id, title: note.title || t("notes.untitled"), href: `/dashboard/notes?note=${encodeURIComponent(note.id)}` }} role={note.canEdit ? "editor" : "viewer"} />
          {note.canDelete ? (
            <button type="button" onClick={() => void remove()} className={aosButton({ variant: "deny", size: "xs" })}>
              <Trash2 className="size-3.5" aria-hidden />
              {t("notes.delete")}
            </button>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5 text-sm text-muted" role="status" aria-live="polite">
            {collab && peers.length ? <Users className="size-4" aria-hidden /> : null}
            {statusText}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex h-control-sm items-center gap-2 rounded-md border-[1.5px] border-control bg-paper px-3 focus-within:border-focus">
            <Folder className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="sr-only">{t("notes.folderLabel")}</span>
            <input
              value={folderText}
              maxLength={120}
              readOnly={!note.canEdit}
              placeholder={t("notes.folderPlaceholder")}
              onChange={(e) => setFolderText(e.target.value)}
              onBlur={() => {
                if ((note.folder ?? "") !== folderText.trim()) void saveMeta({ folder: folderText.trim() || null });
              }}
              data-focus-ring="container"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-subtle"
            />
          </label>
          <label className="flex h-control-sm items-center gap-2 rounded-md border-[1.5px] border-control bg-paper px-3 focus-within:border-focus">
            <Tag className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="sr-only">{t("notes.tagsLabel")}</span>
            <input
              value={tagsText}
              readOnly={!note.canEdit}
              placeholder={t("notes.tagsPlaceholder")}
              onChange={(e) => setTagsText(e.target.value)}
              onBlur={() => {
                const next = tagsText.split(",").map((s) => s.trim()).filter(Boolean);
                if (next.join(",") !== note.tags.join(",")) void saveMeta({ tags: next });
              }}
              data-focus-ring="container"
              className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-subtle"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t("notes.links.label")} role="group">
          {note.links.map((l) => (
            <span key={`${l.kind}:${l.id}`} className="inline-flex h-chip items-center gap-1.5 rounded-full bg-paper pr-1 pl-3 text-sm font-semibold text-ink shadow-control">
              <Link2 className="size-3.5 text-muted" aria-hidden />
              <Link href={recordHref(l.kind, l.id)} className="max-w-[16rem] truncate hover:underline">
                {l.label ?? l.id}
              </Link>
              <span className="text-xs font-normal text-muted">{kindLabel(l.kind)}</span>
              {note.canEdit ? (
                <button
                  type="button"
                  onClick={() => void removeLink(l.kind, l.id)}
                  aria-label={t("notes.links.remove", { title: l.label ?? l.id })}
                  className="inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-hover"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </span>
          ))}
          {note.canEdit ? (
            <Popover.Root open={linkOpen} onOpenChange={setLinkOpen}>
              <Popover.Trigger className={aosButton({ variant: "quiet", size: "xs" })}>
                <Link2 className="size-3.5" aria-hidden />
                {t("notes.links.add")}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner sideOffset={6} align="start" className="z-50">
                  <Popover.Popup className="w-[min(26rem,calc(100vw-2rem))] rounded-lg bg-paper p-3 shadow-raised">
                    <Popover.Title className="mb-2 text-md font-semibold text-ink">{t("notes.links.title")}</Popover.Title>
                    <LinkRecordPicker onPick={(r) => void addLink(r)} exclude={excludeLinks} />
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          ) : null}
        </div>
        {!note.canEdit ? (
          <p className="rounded-md bg-canvas px-3 py-2 text-sm text-muted">{t("notes.readOnly")}</p>
        ) : null}
        {saveState === "conflict" ? (
          <p className="flex items-center gap-2 rounded-md bg-canvas px-3 py-2 text-sm font-semibold text-failed-text" role="alert">
            <span aria-hidden className="size-2 shrink-0 bg-failed" />
            {t("notes.conflictBody")}
          </p>
        ) : null}
      </div>
      <div className="border-t border-line pt-3">
        {collab === undefined ? (
          <p className="min-h-[360px] py-2 text-md text-muted">{t("notes.editor.loading")}</p>
        ) : (
          <NoteEditor
            key={`${note.id}:${editorKey}`}
            initialContent={content}
            editable={!readOnly}
            collab={collab}
            placeholder={t("notes.editor.placeholder")}
            ariaLabel={t("notes.editor.label", { title: title || note.title })}
            onChange={onEditorChange}
            onCollabStatus={setCollabStatus}
            onPeers={onPeers}
            onReset={() => setEditorKey((k) => k + 1)}
          />
        )}
      </div>
      <p suppressHydrationWarning className="text-xs text-subtle">
        {t("notes.meta", { updated: format.relative(note.updatedAt), created: format.date(note.createdAt, "date") })}
        {note.sourceRef === "voice" ? ` · ${t("notes.fromVoice")}` : note.sourceRef?.startsWith("agent") ? ` · ${t("notes.fromAgent")}` : ""}
        {note.sourceRef?.startsWith("meeting:") ? (
          // A Meet summary (lib/comms/meet applySummary): back to its meeting.
          <>
            {" · "}
            <Link href={`/dashboard/meet?m=${encodeURIComponent(note.sourceRef.slice("meeting:".length))}`} className="text-ink underline underline-offset-2">
              {t("notes.fromMeeting")}
            </Link>
          </>
        ) : note.sourceRef?.startsWith("meet") ? (
          ` · ${t("notes.fromMeeting")}`
        ) : null}
      </p>
      <VersionHistory
        apiBase={`/api/notes/${encodeURIComponent(note.id)}`}
        canEdit={note.canEdit}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onRestored={async () => {
          const res = await api<{ note: NoteDetail }>(`/api/notes/${encodeURIComponent(note.id)}`);
          if (res.ok) {
            version.current = res.data.note.version;
            setContent(res.data.note.content);
            setTitle(res.data.note.title);
            onChanged(res.data.note);
          }
          setEditorKey((k) => k + 1);
        }}
      />
    </div>
  );
}

export default NotesApp;
