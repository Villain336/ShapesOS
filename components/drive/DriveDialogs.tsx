"use client";

// ShapesOS — Phase 21B (WS=drive): the Files app's dialogs — name, move (a small folder browser),
// share a folder, tags, and "restore this folder as of …". Same dialog shell as the rest of the app
// (white lg card on a night scrim, Esc closes, first field focused).

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Folder, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { aosButton } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { type Row } from "@/lib/drive/client/rows";
import { ApiError, getJson, postJson, treeUrl } from "./api";

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={id} className={cn("max-h-[90vh] w-full overflow-auto rounded-lg bg-paper p-4 shadow-overlay", wide ? "max-w-xl" : "max-w-sm")}>
        <div className="flex items-center justify-between gap-2">
          <h3 id={id} className="text-md font-semibold text-ink">
            {title}
          </h3>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className={aosButton({ variant: "quiet", size: "xs", className: "w-8 px-0" })}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls = "h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-base text-ink outline-none focus:border-focus";

export function NameDialog({ title, label, initial = "", confirmLabel, busy, error, onSubmit, onClose }: { title: string; label: string; initial?: string; confirmLabel: string; busy: boolean; error: string | null; onSubmit: (value: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <label htmlFor={inputId} className="mt-3 block text-sm font-medium text-ink">
          {label}
        </label>
        <input id={inputId} ref={ref} value={value} onChange={(e) => setValue(e.target.value)} maxLength={255} aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-err` : undefined} className={cn(inputCls, "mt-1", error && "border-failed")} />
        {error ? (
          <p id={`${inputId}-err`} role="alert" className="mt-1.5 flex items-start gap-2 text-sm font-semibold text-failed-text">
            <span className="mt-1.5 size-2 shrink-0 bg-failed" aria-hidden />
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={aosButton({ variant: "quiet", size: "sm" })}>
            {t("common.cancel")}
          </button>
          <button type="submit" disabled={busy || !value.trim()} className={aosButton({ size: "sm" })}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ListingApi {
  listing: { path: string; items: Array<{ kind: "file" | "folder"; id: string; name: string; path: string }>; canEdit: boolean };
}

/** Pick a destination folder: browse into folders, "Move here". */
export function MoveDialog({ workspaceId, count, startPath, busy, error, onChoose, onClose }: { workspaceId: string; count: number; startPath: string; busy: boolean; error: string | null; onChoose: (dir: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [path, setPath] = useState(startPath === "/" ? "/shared" : startPath);
  const [folders, setFolders] = useState<Array<{ id: string; name: string; path: string }> | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(
    async (p: string) => {
      setFolders(null);
      setFailed(false);
      try {
        const r = await getJson<ListingApi>(treeUrl(workspaceId, "list", { path: p, limit: 500 }));
        setFolders(r.listing.items.filter((i) => i.kind === "folder"));
        setCanWrite(r.listing.canEdit);
      } catch {
        setFailed(true);
        setFolders([]);
        setCanWrite(false);
      }
    },
    [workspaceId],
  );
  useEffect(() => {
    void load(path);
  }, [path, load]);
  const crumbs = path.split("/").filter(Boolean);
  return (
    <Modal title={t("drive.dialogs.moveTitle", { count })} onClose={onClose} wide>
      <nav aria-label={t("drive.breadcrumbs")} className="mt-3 flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3.5 text-subtle" aria-hidden /> : null}
            <button type="button" onClick={() => setPath(`/${crumbs.slice(0, i + 1).join("/")}`)} className={cn("rounded-sm px-1 hover:bg-hover", i === crumbs.length - 1 ? "font-semibold text-ink" : "text-muted")}>
              {c}
            </button>
          </span>
        ))}
      </nav>
      <ul className="mt-2 max-h-64 overflow-auto rounded-md border border-line" aria-label={t("drive.dialogs.folders")}>
        {folders === null ? (
          <li className="px-3 py-2 text-sm text-muted">{t("common.loading")}</li>
        ) : folders.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted">{failed ? t("drive.states.loadFailed") : t("drive.dialogs.noSubfolders")}</li>
        ) : (
          folders.map((f) => (
            <li key={f.id} className="border-b border-line last:border-0">
              <button type="button" onClick={() => setPath(f.path)} className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-sm font-medium text-ink hover:bg-hover-paper">
                <Folder className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="truncate">{f.name}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-2 text-sm font-semibold text-failed-text">
          <span className="mt-1.5 size-2 shrink-0 bg-failed" aria-hidden />
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-xs text-muted">{path}</p>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={aosButton({ variant: "quiet", size: "sm" })}>
            {t("common.cancel")}
          </button>
          <button type="button" disabled={busy || !canWrite} onClick={() => onChoose(path)} className={aosButton({ size: "sm" })}>
            {t("drive.actions.moveHere")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface AccessEntry {
  userId: string;
  name: string | null;
  email: string | null;
  workspaceRole: string;
  override: "viewer" | "editor" | "owner" | null;
  effective: "viewer" | "editor" | "owner" | null;
}

export function ShareDialog({ workspaceId, folder, onClose }: { workspaceId: string; folder: Row; onClose: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<{ entries: AccessEntry[]; canManage: boolean; private: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    getJson<{ entries: AccessEntry[]; canManage: boolean; private: boolean }>(treeUrl(workspaceId, "folder_access", { id: folder.id }))
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : t("drive.states.loadFailed")));
  }, [workspaceId, folder.id, t]);
  async function setRole(userId: string, role: string) {
    setBusy(true);
    setError(null);
    try {
      await postJson("/api/drive/ops", { workspaceId, action: "share_folder", id: folder.id, userId, role: role === "" ? null : role });
      setData(await getJson(treeUrl(workspaceId, "folder_access", { id: folder.id })));
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : t("drive.states.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  const roleLabel = (r: string | null) => (r ? t(`filesApp.roles.${r}` as never) : t("drive.share.inherit"));
  return (
    <Modal title={t("drive.dialogs.shareTitle", { name: folder.name })} onClose={onClose} wide>
      <p className="mt-2 text-sm text-muted">{data?.private ? t("drive.share.privateHint") : t("drive.share.hint")}</p>
      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-2 text-sm font-semibold text-failed-text">
          <span className="mt-1.5 size-2 shrink-0 bg-failed" aria-hidden />
          {error}
        </p>
      ) : null}
      {!data ? (
        <p className="mt-3 text-sm text-muted">{t("common.loading")}</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{t("drive.share.caption")}</caption>
            <thead className="border-b border-line">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left text-xs font-semibold text-muted">{t("drive.share.person")}</th>
                <th scope="col" className="px-2 py-1.5 text-left text-xs font-semibold text-muted">{t("drive.share.effective")}</th>
                <th scope="col" className="px-2 py-1.5 text-left text-xs font-semibold text-muted">{t("drive.share.setHere")}</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.userId} className="border-b border-line last:border-0">
                  <td className="px-2 py-1.5">
                    <p className="font-semibold text-ink">{e.name ?? e.email ?? e.userId}</p>
                    {e.email && e.name ? <p className="text-xs text-muted">{e.email}</p> : null}
                  </td>
                  <td className="px-2 py-1.5 text-muted">{e.effective ? roleLabel(e.effective) : t("drive.share.noAccess")}</td>
                  <td className="px-2 py-1.5">
                    {data.canManage && e.effective !== "owner" || (data.canManage && data.private) ? (
                      <select
                        aria-label={t("drive.share.roleFor", { name: e.name ?? e.email ?? e.userId })}
                        value={e.override ?? ""}
                        disabled={busy}
                        onChange={(ev) => void setRole(e.userId, ev.target.value)}
                        className="h-control-sm rounded-md border-[1.5px] border-control bg-paper px-2 text-sm text-ink"
                      >
                        <option value="">{data.private ? t("drive.share.noShare") : t("drive.share.inherit")}</option>
                        <option value="viewer">{t("filesApp.roles.viewer")}</option>
                        <option value="editor">{t("filesApp.roles.editor")}</option>
                        {!data.private ? <option value="owner">{t("filesApp.roles.owner")}</option> : null}
                      </select>
                    ) : (
                      <span className="text-muted">{roleLabel(e.override)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className={aosButton({ size: "sm" })}>
          {t("common.close")}
        </button>
      </div>
    </Modal>
  );
}

export function TagsDialog({ row, busy, error, onSave, onClose }: { row: Row; busy: boolean; error: string | null; onSave: (tags: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <NameDialog
      title={t("drive.dialogs.tagsTitle", { name: row.name })}
      label={t("drive.dialogs.tagsLabel")}
      initial={row.tags.join(", ")}
      confirmLabel={t("common.save")}
      busy={busy}
      error={error}
      onSubmit={onSave}
      onClose={onClose}
    />
  );
}

interface PlanItem {
  fileId: string;
  path: string;
  action: string;
  toVersion: number | null;
  reason: string | null;
}
interface Plan {
  items: PlanItem[];
  summary: { restoreVersion: number; untrash: number; unchanged: number; skipped: number; unavailable: number; conflicts: number };
}

/** "Restore this folder as of …": pick a time, see the plan (a dry run), then apply. Nothing is ever deleted. */
export function RestoreAsOfDialog({ workspaceId, folderPath, onClose, onDone }: { workspaceId: string; folderPath: string; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [when, setWhen] = useState(() => new Date(Date.now() - 24 * 3600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  const timeId = useId();
  async function run(apply: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ plan: Plan; outcomes: Array<{ result: string }> }>("/api/drive/restore", { workspaceId, folder: folderPath, asOf: new Date(when).toISOString(), apply });
      setPlan(r.plan);
      if (apply) {
        setApplied(r.outcomes.filter((o) => o.result === "restored" || o.result === "untrashed").length);
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("drive.states.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  const s = plan?.summary;
  const todo = s ? s.restoreVersion + s.untrash : 0;
  return (
    <Modal title={t("drive.restoreAsOf.title")} onClose={onClose} wide>
      <p className="mt-2 text-sm text-muted">{t("drive.restoreAsOf.intro", { folder: folderPath })}</p>
      <label htmlFor={timeId} className="mt-3 block text-sm font-medium text-ink">
        {t("drive.restoreAsOf.when")}
      </label>
      <input id={timeId} type="datetime-local" value={when} max={new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)} onChange={(e) => { setWhen(e.target.value); setPlan(null); setApplied(null); }} className={cn(inputCls, "mt-1")} />
      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-2 text-sm font-semibold text-failed-text">
          <span className="mt-1.5 size-2 shrink-0 bg-failed" aria-hidden />
          {error}
        </p>
      ) : null}
      {plan && s ? (
        <div className="mt-3" aria-live="polite">
          <p className="text-sm font-semibold text-ink">
            {applied !== null ? t("drive.restoreAsOf.done", { count: applied }) : todo === 0 ? t("drive.restoreAsOf.nothing") : t("drive.restoreAsOf.plan", { versions: s.restoreVersion, trash: s.untrash })}
          </p>
          <p className="mt-0.5 text-xs text-muted">{t("drive.restoreAsOf.rest", { unchanged: s.unchanged, skipped: s.skipped, unavailable: s.unavailable, conflicts: s.conflicts })}</p>
          <ul className="mt-2 max-h-48 divide-y divide-line overflow-auto rounded-md border border-line text-sm">
            {plan.items.filter((i) => i.action !== "unchanged").map((i) => (
              <li key={i.fileId} className="flex items-start gap-2 px-3 py-1.5">
                <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-ink">{i.path}</span>
                  <span className="block text-xs text-muted">{t(`drive.restoreAsOf.actions.${i.action}` as never, { version: i.toVersion ?? 0 })}{i.reason ? ` · ${i.reason}` : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={aosButton({ variant: "quiet", size: "sm" })}>
          {t("common.close")}
        </button>
        <button type="button" disabled={busy} onClick={() => void run(false)} className={aosButton({ variant: "secondary", size: "sm" })}>
          {busy && !plan ? t("drive.restoreAsOf.checking") : t("drive.restoreAsOf.preview")}
        </button>
        {plan && todo > 0 && applied === null ? (
          <button type="button" disabled={busy} onClick={() => void run(true)} className={aosButton({ size: "sm" })}>
            {busy ? t("drive.restoreAsOf.restoring") : t("drive.restoreAsOf.apply", { count: todo })}
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted">{t("drive.restoreAsOf.safe")}</p>
    </Modal>
  );
}
