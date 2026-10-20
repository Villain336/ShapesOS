"use client";

// ShapesOS — Phase 21B (WS=drive): the Files sidebar — places, favourites, tags, smart folders,
// storage. Dense list of pills' worth of rows; the current place is the white... on a light page it is
// the ink-outlined row (aria-current), the same way the app's other secondary navs mark "here".

import { Bot, Clock, Folder, HardDrive, Home, Star, Tag, Trash, Users, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/I18nProvider";
import { fmtSize } from "@/lib/drive/client/rows";
import type { Place } from "./types";

export interface SidebarData {
  roots: Array<{ key: string; name: string; path: string }>;
  favorites: Array<{ id: string; kind: "file" | "folder"; name: string; path: string }>;
  tags: Array<{ tag: string; count: number }>;
  smart: Array<{ id: string; name: string; query: string }>;
  usage: { workspace: { usedBytes: number; limitBytes: number }; personal: { usedBytes: number; limitBytes: number | null } } | null;
}

export function DriveSidebar({
  place,
  data,
  onGo,
  onRemoveSmart,
}: {
  place: Place;
  data: SidebarData;
  onGo: (p: Place) => void;
  onRemoveSmart: (id: string) => void;
}) {
  const { t } = useI18n();
  const row = (here: boolean) =>
    cn(
      "flex min-h-9 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm font-medium transition-colors",
      here ? "bg-hover text-ink shadow-outline" : "text-ink hover:bg-hover-paper",
    );
  const rootIcon = (key: string) => (key === "home" ? Home : key === "shared" ? Users : key === "agents" ? Bot : key === "trash" ? Trash : key === "mounts" ? HardDrive : Folder);
  const pct = data.usage && data.usage.workspace.limitBytes > 0 ? Math.min(100, (data.usage.workspace.usedBytes / data.usage.workspace.limitBytes) * 100) : 0;

  return (
    <nav aria-label={t("drive.sidebar.label")} className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        {data.roots
          .filter((r) => r.key !== "trash")
          .map((r) => {
            const Icon = rootIcon(r.key);
            const target: Place = { t: "folder", path: r.path };
            const here = place.t === "folder" && (place.path === r.path || place.path.startsWith(`${r.path}/`));
            return (
              <button key={r.key} type="button" onClick={() => onGo(target)} aria-current={here ? "page" : undefined} className={row(here)}>
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{t(`drive.roots.${r.key}` as never)}</span>
              </button>
            );
          })}
        <button type="button" onClick={() => onGo({ t: "recents" })} aria-current={place.t === "recents" ? "page" : undefined} className={row(place.t === "recents")}>
          <Clock className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{t("drive.sidebar.recents")}</span>
        </button>
        <button type="button" onClick={() => onGo({ t: "shared" })} aria-current={place.t === "shared" ? "page" : undefined} className={row(place.t === "shared")}>
          <Users className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{t("drive.sidebar.sharedWithMe")}</span>
        </button>
        <button type="button" onClick={() => onGo({ t: "trash" })} aria-current={place.t === "trash" ? "page" : undefined} className={row(place.t === "trash")}>
          <Trash className="size-4 shrink-0" aria-hidden />
          <span className="truncate">{t("drive.roots.trash")}</span>
        </button>
      </div>

      <section aria-labelledby="drive-fav-h">
        <h2 id="drive-fav-h" className="px-2.5 pb-1 text-xs font-semibold text-muted">{t("drive.sidebar.favorites")}</h2>
        {data.favorites.length === 0 ? (
          <p className="px-2.5 text-sm text-muted">{t("drive.sidebar.noFavorites")}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {data.favorites.map((f) => (
              <button key={f.id} type="button" onClick={() => onGo(f.kind === "folder" ? { t: "folder", path: f.path } : { t: "folder", path: f.path.slice(0, f.path.lastIndexOf("/")) || "/" })} className={row(false)}>
                <Star className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="drive-smart-h">
        <h2 id="drive-smart-h" className="px-2.5 pb-1 text-xs font-semibold text-muted">{t("drive.sidebar.smartFolders")}</h2>
        {data.smart.length === 0 ? (
          <p className="px-2.5 text-sm text-muted">{t("drive.sidebar.noSmart")}</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {data.smart.map((s) => {
              const here = place.t === "smart" && place.id === s.id;
              return (
                <div key={s.id} className="group flex items-center">
                  <button type="button" onClick={() => onGo({ t: "smart", id: s.id, name: s.name, query: s.query })} aria-current={here ? "page" : undefined} className={cn(row(here), "flex-1")}>
                    <Search className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{s.name}</span>
                  </button>
                  <button type="button" onClick={() => onRemoveSmart(s.id)} aria-label={t("drive.sidebar.removeSmart", { name: s.name })} className="ml-0.5 grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-ink">
                    <X className="size-3.5" aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {data.tags.length > 0 ? (
        <section aria-labelledby="drive-tags-h">
          <h2 id="drive-tags-h" className="px-2.5 pb-1 text-xs font-semibold text-muted">{t("drive.sidebar.tags")}</h2>
          <div className="flex flex-col gap-0.5">
            {data.tags.slice(0, 12).map((x) => {
              const here = place.t === "tag" && place.tag === x.tag;
              return (
                <button key={x.tag} type="button" onClick={() => onGo({ t: "tag", tag: x.tag })} aria-current={here ? "page" : undefined} className={row(here)}>
                  <Tag className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{x.tag}</span>
                  <span className="text-xs text-muted">{x.count}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {data.usage ? (
        <section aria-labelledby="drive-usage-h" className="rounded-lg bg-paper px-3 py-2.5 shadow-hairline">
          <h2 id="drive-usage-h" className="text-xs font-semibold text-muted">{t("drive.usage.title")}</h2>
          <p className="mt-1 text-sm text-ink">{t("drive.usage.workspace", { used: fmtSize(data.usage.workspace.usedBytes), limit: fmtSize(data.usage.workspace.limitBytes) })}</p>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={t("drive.usage.title")}>
            <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {data.usage.personal.limitBytes === null
              ? t("drive.usage.yours", { used: fmtSize(data.usage.personal.usedBytes) })
              : t("drive.usage.yoursOf", { used: fmtSize(data.usage.personal.usedBytes), limit: fmtSize(data.usage.personal.limitBytes) })}
          </p>
        </section>
      ) : null}
    </nav>
  );
}

