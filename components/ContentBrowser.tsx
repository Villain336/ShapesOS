// Marketr — content browser for WordPress / Webflow sites (milestone 8).
// Browse pages/posts (WP) or collections → items (Webflow), open in an
// editor, save back, delete. Honest banners: content-level access only —
// no theme/plugin file editing (WP), no page-design editing (Webflow).

"use client";

import { useCallback, useEffect, useState } from "react";

interface ContentItem {
  id: string;
  kind: string;
  title: string;
  slug: string;
  status: string;
  collectionId?: string;
  link?: string | null;
  updatedAt: string | null;
  content?: string;
  mock?: boolean;
}

interface Props {
  projectId: string;
  siteId: string;
  sourceType: "wordpress" | "webflow";
  isMock: boolean;
}

const TABS = {
  wordpress: ["page", "post"] as const,
  webflow: ["collection"] as const,
};

export default function ContentBrowser({ projectId, siteId, sourceType, isMock }: Props) {
  const [tab, setTab] = useState<string>(TABS[sourceType][0]);
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editStatus, setEditStatus] = useState("draft");
  const [editBusy, setEditBusy] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [publishBusy, setPublishBusy] = useState(false);

  const call = useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`/api/websites/${siteId}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      return data;
    },
    [projectId, siteId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (sourceType === "webflow" && tab === "collection") {
        const data = await call("list", { kind: "collection" });
        setItems(data.items);
      } else if (sourceType === "webflow") {
        // items tab: tab holds the collection id
        const data = await call("items", { collectionId: tab });
        setItems(data.items);
        setCollectionId(tab);
      } else {
        const data = await call("list", { kind: tab });
        setItems(data.items);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [call, sourceType, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openItem(item: ContentItem) {
    setError(null);
    setMsg(null);
    try {
      const data = await call("get", {
        kind: sourceType === "webflow" ? "item" : tab,
        id: item.id,
        collectionId: sourceType === "webflow" ? item.collectionId : undefined,
      });
      const d = data.item as ContentItem;
      setOpenId(d.id);
      setNewItem(false);
      setEditTitle(d.title);
      setEditSlug(d.slug);
      setEditContent(d.content ?? "");
      setEditStatus(d.status === "publish" || d.status === "published" ? "publish" : "draft");
      if (sourceType === "webflow") setCollectionId(item.collectionId ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Open failed");
    }
  }

  function startNew() {
    setOpenId(null);
    setNewItem(true);
    setEditTitle("");
    setEditSlug("");
    setEditContent(sourceType === "webflow" ? '{\n  "name": "",\n  "slug": "",\n  "page-html": ""\n}' : "");
    setEditStatus("draft");
    setMsg(null);
    setError(null);
  }

  async function save() {
    setEditBusy(true);
    setError(null);
    try {
      const kind = sourceType === "webflow" ? "item" : tab;
      const data = await call("save", {
        kind,
        id: newItem ? undefined : openId ?? undefined,
        title: editTitle,
        slug: editSlug,
        content: editContent,
        status: editStatus,
        collectionId: sourceType === "webflow" ? collectionId : undefined,
      });
      setMsg(`✓ Saved “${data.item.title}”${isMock ? " (mock)" : ""}`);
      setOpenId(data.item.id);
      setNewItem(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setEditBusy(false);
    }
  }

  async function remove(item: ContentItem) {
    if (!confirm(`Delete “${item.title}”?`)) return;
    try {
      await call("delete", {
        kind: sourceType === "webflow" ? "item" : tab,
        id: item.id,
        collectionId: item.collectionId,
      });
      setMsg("✓ Deleted");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function publishSite() {
    setPublishBusy(true);
    setError(null);
    try {
      await call("publish");
      setMsg(`✓ Webflow site published${isMock ? " (mock)" : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishBusy(false);
    }
  }

  const isItemTab = sourceType === "webflow" && tab !== "collection";
  const editorOpen = openId !== null || newItem;

  return (
    <div className="mt-3 rounded-md border border-zinc-800 p-3">
      <div className="mb-3 rounded-md border border-sky-900 bg-sky-950/40 p-2 text-xs text-sky-200">
        {sourceType === "wordpress"
          ? "Content-level access: pages, posts, and media via the WP REST API. Theme/plugin file editing is not available through this connection — use an SFTP site for that."
          : "Content-level access: CMS collections, items, and site publishing via the Webflow API. Page designs are not API-editable — use the Designer for layout changes."}
        {isMock && <span className="ml-2 rounded bg-amber-900 px-1.5 py-0.5 text-amber-200">mock demo data</span>}
      </div>

      <div className="mb-2 flex items-center gap-2">
        {sourceType === "wordpress" ? (
          (["page", "post"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setOpenId(null); setNewItem(false); }}
              className={`rounded px-2 py-1 text-xs ${tab === t ? "bg-zinc-100 text-zinc-950" : "border border-zinc-700 text-zinc-300"}`}
            >
              {t === "page" ? "Pages" : "Posts"}
            </button>
          ))
        ) : (
          <>
            <button
              onClick={() => { setTab("collection"); setOpenId(null); setNewItem(false); }}
              className={`rounded px-2 py-1 text-xs ${tab === "collection" ? "bg-zinc-100 text-zinc-950" : "border border-zinc-700 text-zinc-300"}`}
            >
              Collections
            </button>
            <button
              onClick={() => void publishSite()}
              disabled={publishBusy}
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
            >
              {publishBusy ? "Publishing…" : "Publish site"}
            </button>
          </>
        )}
        {(!isItemTab) && (
          <button
            onClick={startNew}
            className="ml-auto rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500"
          >
            ＋ New {sourceType === "wordpress" ? (tab === "page" ? "page" : "post") : tab === "collection" ? "item" : "item"}
          </button>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      {msg && <p className="mb-2 text-xs text-emerald-300">{msg}</p>}

      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded border border-zinc-800 px-2 py-1.5 text-xs">
              <button
                onClick={() => (item.kind === "collection" ? setTab(item.id) : void openItem(item))}
                className="text-left text-zinc-200 hover:underline"
              >
                {item.title}
                <span className="ml-2 font-mono text-zinc-500">/{item.slug}</span>
                <span className={`ml-2 rounded px-1 py-0.5 ${item.status === "publish" || item.status === "published" ? "bg-emerald-950 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>
                  {item.status}
                </span>
                {item.kind === "collection" && <span className="ml-2 text-zinc-500">→ browse items</span>}
              </button>
              {item.kind !== "collection" && (
                <button onClick={() => void remove(item)} className="text-red-300 hover:text-red-200">
                  Delete
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="text-xs text-zinc-500">Nothing here yet.</li>}
        </ul>
      )}

      {isItemTab && (
        <button onClick={() => { setTab("collection"); setOpenId(null); setNewItem(false); }} className="mt-2 text-xs text-zinc-400 hover:text-zinc-200">
          ← Back to collections
        </button>
      )}

      {editorOpen && (
        <div className="mt-3 rounded-md border border-zinc-700 p-3">
          <h4 className="mb-2 text-xs font-semibold text-zinc-200">
            {newItem ? "New item" : "Edit"} {sourceType === "webflow" && "(fieldData JSON)"}
          </h4>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-zinc-400">
              Title
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">
              Slug
              <input value={editSlug} onChange={(e) => setEditSlug(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100" />
            </label>
            <label className="block text-xs text-zinc-400">
              Status
              <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100">
                <option value="draft">Draft</option>
                <option value="publish">Publish</option>
              </select>
            </label>
          </div>
          {sourceType === "webflow" && isItemTab && (
            <p className="mt-2 text-xs text-zinc-500">
              Collection: <span className="font-mono">{collectionId}</span>
            </p>
          )}
          <label className="mt-2 block text-xs text-zinc-400">
            {sourceType === "wordpress" ? "Content (HTML)" : "fieldData (JSON)"}
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={10}
              spellCheck={false}
              className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-100"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void save()}
              disabled={editBusy}
              className="rounded bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
            >
              {editBusy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setOpenId(null); setNewItem(false); }}
              className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
