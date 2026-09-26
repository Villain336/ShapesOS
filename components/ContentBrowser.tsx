// Marketr — content browser for WordPress / Webflow sites (milestone 8).
// Browse pages/posts (WP) or collections → items (Webflow), open in an
// editor, save back, delete. Honest banners: content-level access only —
// no theme/plugin file editing (WP), no page-design editing (Webflow).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";

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
    <div className="mt-3 rounded-md border border-zinc-200 p-3">
      <div className="mb-3 rounded-md border border-sky-200 bg-sky-50/40 p-2 text-xs text-sky-800">
        {sourceType === "wordpress"
          ? "Content-level access: pages, posts, and media via the WP REST API. Theme/plugin file editing is not available through this connection — use an SFTP site for that."
          : "Content-level access: CMS collections, items, and site publishing via the Webflow API. Page designs are not API-editable — use the Designer for layout changes."}
        {isMock && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">mock demo data</span>}
      </div>

      <div className="mb-2 flex items-center gap-1 border-b border-stone-200">
        {sourceType === "wordpress" ? (
          (["page", "post"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setOpenId(null); setNewItem(false); }}
              className={`border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${tab === t ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"}`}
            >
              {t === "page" ? "Pages" : "Posts"}
            </button>
          ))
        ) : (
          <>
            <button
              onClick={() => { setTab("collection"); setOpenId(null); setNewItem(false); }}
              className={`border-b-2 px-3 py-2 text-[13px] font-medium transition-colors ${tab === "collection" ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"}`}
            >
              Collections
            </button>
            <button
              onClick={() => void publishSite()}
              disabled={publishBusy}
              className="ml-auto rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 disabled:opacity-50"
            >
              {publishBusy ? "Publishing…" : "Publish site"}
            </button>
          </>
        )}
        {(!isItemTab) && (
          <button
            onClick={startNew}
            className="ml-auto inline-flex items-center gap-1 rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-800 hover:border-zinc-400"
          >
            <Plus size={13} /> New {sourceType === "wordpress" ? (tab === "page" ? "page" : "post") : tab === "collection" ? "item" : "item"}
          </button>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {msg && <p className="mb-2 text-xs text-emerald-700">{msg}</p>}

      {loading ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded border border-zinc-200 px-2 py-1.5 text-xs">
              <button
                onClick={() => (item.kind === "collection" ? setTab(item.id) : void openItem(item))}
                className="text-left text-zinc-800 hover:underline"
              >
                {item.title}
                <span className="ml-2 font-mono text-zinc-500">/{item.slug}</span>
                <span className={`ml-2 rounded px-1 py-0.5 ${item.status === "publish" || item.status === "published" ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"}`}>
                  {item.status}
                </span>
                {item.kind === "collection" && <span className="ml-2 text-zinc-500">→ browse items</span>}
              </button>
              {item.kind !== "collection" && (
                <button onClick={() => void remove(item)} className="text-red-700 hover:text-red-700">
                  Delete
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="text-xs text-zinc-500">Nothing here yet.</li>}
        </ul>
      )}

      {isItemTab && (
        <button onClick={() => { setTab("collection"); setOpenId(null); setNewItem(false); }} className="mt-2 text-xs text-zinc-500 hover:text-zinc-800">
          ← Back to collections
        </button>
      )}

      {editorOpen && (
        <div className="mt-3 rounded-md border border-zinc-200 p-3">
          <h4 className="mb-2 text-xs font-semibold text-zinc-800">
            {newItem ? "New item" : "Edit"} {sourceType === "webflow" && "(fieldData JSON)"}
          </h4>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-zinc-500">
              Title
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900" />
            </label>
            <label className="block text-xs text-zinc-500">
              Slug
              <input value={editSlug} onChange={(e) => setEditSlug(e.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-xs text-zinc-900" />
            </label>
            <label className="block text-xs text-zinc-500">
              Status
              <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900">
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
          <label className="mt-2 block text-xs text-zinc-500">
            {sourceType === "wordpress" ? "Content (HTML)" : "fieldData (JSON)"}
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={10}
              spellCheck={false}
              className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1 font-mono text-xs text-zinc-900"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void save()}
              disabled={editBusy}
              className="rounded bg-accent px-3 py-1 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              {editBusy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setOpenId(null); setNewItem(false); }}
              className="rounded border border-zinc-200 px-3 py-1 text-xs text-zinc-500"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
