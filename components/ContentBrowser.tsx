// Marketr — content browser for WordPress / Webflow sites (milestone 8).
// Browse pages/posts (WP) or collections → items (Webflow), open in an
// editor, save back, delete. Honest banners: content-level access only —
// no theme/plugin file editing (WP), no page-design editing (Webflow).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

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
    if (!await confirmAction(`Delete “${item.title}”?`)) return;
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
    <div className="mt-3 rounded-md bg-paper p-3 shadow-hairline">
      <div className="mb-3 rounded-sm bg-canvas p-2 text-xs text-ink">
        {sourceType === "wordpress"
          ? "Content-level access: pages, posts, and media via the WP REST API. Theme/plugin file editing is not available through this connection — use an SFTP site for that."
          : "Content-level access: CMS collections, items, and site publishing via the Webflow API. Page designs are not API-editable — use the Designer for layout changes."}
        {isMock && <span className="ml-2 rounded-full bg-paper px-2 py-0.5 font-semibold text-muted shadow-hairline">Mock demo data</span>}
      </div>

      <div className="mb-2 flex items-center gap-1">
        {sourceType === "wordpress" ? (
          (["page", "post"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setOpenId(null); setNewItem(false); }}
              aria-pressed={tab === t}
              className={`h-8 rounded-full px-3 text-[13px] font-semibold transition-colors ${tab === t ? "bg-ink text-paper" : "text-muted hover:bg-hover-paper hover:text-ink"}`}
            >
              {t === "page" ? "Pages" : "Posts"}
            </button>
          ))
        ) : (
          <>
            <button
              onClick={() => { setTab("collection"); setOpenId(null); setNewItem(false); }}
              aria-pressed={tab === "collection"}
              className={`h-8 rounded-full px-3 text-[13px] font-semibold transition-colors ${tab === "collection" ? "bg-ink text-paper" : "text-muted hover:bg-hover-paper hover:text-ink"}`}
            >
              Collections
            </button>
            <button
              onClick={() => void publishSite()}
              disabled={publishBusy}
              className="ml-auto inline-flex h-8 items-center rounded-full bg-paper px-3 text-xs font-semibold text-ink shadow-control hover:shadow-outline disabled:cursor-not-allowed disabled:opacity-40"
            >
              {publishBusy ? "Publishing…" : "Publish site"}
            </button>
          </>
        )}
        {(!isItemTab) && (
          <button
            onClick={startNew}
            className="ml-auto inline-flex h-8 items-center gap-1 rounded-full bg-paper px-3 text-xs font-semibold text-ink shadow-control hover:shadow-outline"
          >
            <Plus size={13} /> New {sourceType === "wordpress" ? (tab === "page" ? "page" : "post") : tab === "collection" ? "item" : "item"}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-2 flex items-start gap-1.5 text-xs text-failed-text">
          <span className="aos-shape aos-shape--failed mt-0.5 shrink-0 [--aos-shape-size:8px]" aria-hidden="true" />
          {error}
        </p>
      )}
      {msg && <p className="mb-2 text-xs text-ink">{msg}</p>}

      {loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between rounded-sm px-2 py-1.5 text-xs hover:bg-hover-paper">
              <button
                onClick={() => (item.kind === "collection" ? setTab(item.id) : void openItem(item))}
                className="text-left text-ink hover:underline"
              >
                {item.title}
                <span className="ml-2 font-mono text-muted">/{item.slug}</span>
                <span className={`ml-2 rounded-full px-1.5 py-0.5 font-semibold ${item.status === "publish" || item.status === "published" ? "bg-ink text-paper" : "bg-canvas text-muted"}`}>
                  {item.status}
                </span>
                {item.kind === "collection" && <span className="ml-2 text-muted">→ browse items</span>}
              </button>
              {item.kind !== "collection" && (
                <button onClick={() => void remove(item)} className="rounded-full px-2 py-0.5 font-semibold text-failed-text hover:bg-failed-tint">
                  Delete
                </button>
              )}
            </li>
          ))}
          {items.length === 0 && <li className="text-xs text-muted">Nothing here yet.</li>}
        </ul>
      )}

      {isItemTab && (
        <button onClick={() => { setTab("collection"); setOpenId(null); setNewItem(false); }} className="mt-2 text-xs text-muted hover:text-ink">
          ← Back to collections
        </button>
      )}

      {editorOpen && (
        <div className="mt-3 rounded-md bg-canvas p-3">
          <h4 className="mb-2 text-xs font-semibold text-ink">
            {newItem ? "New item" : "Edit"} {sourceType === "webflow" && "(fieldData JSON)"}
          </h4>
          <div className="grid grid-cols-3 gap-2">
            <label className="block text-xs text-muted">
              Title
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1 focus:border-focus focus:outline-none text-xs text-ink" />
            </label>
            <label className="block text-xs text-muted">
              Slug
              <input value={editSlug} onChange={(e) => setEditSlug(e.target.value)} className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1 focus:border-focus focus:outline-none font-mono text-xs text-ink" />
            </label>
            <label className="block text-xs text-muted">
              Status
              <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1 focus:border-focus focus:outline-none text-xs text-ink">
                <option value="draft">Draft</option>
                <option value="publish">Publish</option>
              </select>
            </label>
          </div>
          {sourceType === "webflow" && isItemTab && (
            <p className="mt-2 text-xs text-muted">
              Collection: <span className="font-mono">{collectionId}</span>
            </p>
          )}
          <label className="mt-2 block text-xs text-muted">
            {sourceType === "wordpress" ? "Content (HTML)" : "fieldData (JSON)"}
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={10}
              spellCheck={false}
              className="mt-1 w-full rounded-md border-[1.5px] border-control bg-paper px-2 py-1 focus:border-focus focus:outline-none font-mono text-xs text-ink"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void save()}
              disabled={editBusy}
              className="inline-flex h-8 items-center rounded-full bg-ink px-4 text-xs font-semibold text-paper aos-press hover:bg-night-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editBusy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => { setOpenId(null); setNewItem(false); }}
              className="inline-flex h-8 items-center rounded-full bg-paper px-4 text-xs font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
