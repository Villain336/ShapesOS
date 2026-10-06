// Marketr — workspace skills manager (milestone 21, part D1).
// Client component: Installed / Registry / Install from URL / Upload tabs.
// URL installs are pinned to a commit SHA and flagged as untrusted;
// re-pinning to a newer commit is a deliberate one-click action.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Link2, PackageCheck, Store, Upload, type LucideIcon } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const labelCls = "mb-1 block text-xs font-medium text-muted";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source: "registry" | "url" | "upload";
  sourceRef: string | null;
  version: string | null;
  shaPin: string | null;
  trustTier: string;
  installedBy: string | null;
  installedAt: string;
}

interface Pack {
  key: string;
  name: string;
  description: string;
  version: string;
  declaredTools: string[];
}

interface UrlPreview {
  name: string;
  description: string;
  version: string | null;
  sha: string;
  warnings: string[];
}

type Tab = "installed" | "registry" | "url" | "upload";

const TABS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: "installed", label: "Installed", icon: PackageCheck },
  { key: "registry", label: "Registry", icon: Store },
  { key: "url", label: "Install from URL", icon: Link2 },
  { key: "upload", label: "Upload", icon: Upload },
];

export default function SkillsManager({ workspaceId }: { workspaceId: string }) {
  const [tab, setTab] = useState<Tab>("installed");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<UrlPreview | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [skillMd, setSkillMd] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    const [sr, pr] = await Promise.all([
      fetch(`/api/skills?${q}`),
      fetch(`/api/skills/registry?${q}`),
    ]);
    if (sr.ok) {
      const j = await sr.json();
      setSkills(j.skills ?? []);
    }
    if (pr.ok) {
      const j = await pr.json();
      setPacks(j.packs ?? []);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  function err(j: unknown, fallback: string): NoticeState {
    const msg =
      j && typeof j === "object" && "error" in j && typeof j.error === "string"
        ? j.error
        : fallback;
    return { kind: "error", message: msg };
  }

  async function installPack(packKey: string) {
    setBusy(packKey);
    setNotice(null);
    try {
      const r = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, source: "registry", packKey }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Install failed."));
        return;
      }
      setNotice({ kind: "ok", message: `Installed "${j.skill?.name ?? packKey}".` });
      await load();
      setTab("installed");
    } finally {
      setBusy(null);
    }
  }

  async function previewUrl() {
    if (!url.trim()) return;
    setBusy("preview");
    setNotice(null);
    setPreview(null);
    try {
      const r = await fetch("/api/skills/preview-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, url: url.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Could not fetch that URL."));
        return;
      }
      setPreview(j as UrlPreview);
    } finally {
      setBusy(null);
    }
  }

  async function installUrl() {
    if (!preview) return;
    setBusy("install-url");
    setNotice(null);
    try {
      const r = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          source: "url",
          url: url.trim(),
          sha: preview.sha,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Install failed."));
        return;
      }
      setNotice({
        kind: "ok",
        message: `Installed "${j.skill?.name ?? preview.name}" pinned to ${preview.sha.slice(0, 7)}.`,
      });
      setUrl("");
      setPreview(null);
      await load();
      setTab("installed");
    } finally {
      setBusy(null);
    }
  }

  async function installUpload() {
    if (!skillMd.trim()) {
      setNotice({ kind: "error", message: "Paste or choose a SKILL.md file first." });
      return;
    }
    setBusy("upload");
    setNotice(null);
    try {
      const r = await fetch("/api/skills/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          source: "upload",
          skillMd,
          filename: uploadName.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Install failed."));
        return;
      }
      setNotice({ kind: "ok", message: `Installed "${j.skill?.name ?? "skill"}" from upload.` });
      setSkillMd("");
      setUploadName("");
      await load();
      setTab("installed");
    } finally {
      setBusy(null);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploadName(f.name);
    const reader = new FileReader();
    reader.onload = () => setSkillMd(String(reader.result ?? ""));
    reader.readAsText(f);
  }

  async function repin(id: string, name: string) {
    if (!await confirmAction(`Re-pin "${name}" to the latest commit? This updates its SHA pin.`)) return;
    setBusy(id);
    setNotice(null);
    try {
      const r = await fetch(`/api/skills/${encodeURIComponent(id)}/repin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Re-pin failed."));
        return;
      }
      setNotice({
        kind: "ok",
        message: `Re-pinned "${name}" to ${String(j.skill?.shaPin ?? "").slice(0, 7)}.`,
      });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function removeSkill(id: string, name: string) {
    if (!await confirmAction(`Delete the "${name}" skill from this workspace?`)) return;
    setBusy(id);
    setNotice(null);
    try {
      const r = await fetch(`/api/skills/${encodeURIComponent(id)}?${q}`, {
        method: "DELETE",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice(err(j, "Delete failed."));
        return;
      }
      setNotice({ kind: "ok", message: `Deleted "${name}".` });
      await load();
    } finally {
      setBusy(null);
    }
  }

  // Source/trust badges are provider states, not agent states — neutral chips.
  function trustBadge(s: Skill) {
    if (s.trustTier === "built-in") {
      return <span className={chipCls}>Built-in</span>;
    }
    return (
      <span className={chipCls}>
        Untrusted source — pinned to {(s.shaPin ?? "").slice(0, 7) || "unknown"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-4 flex gap-1 border-b border-line">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition ${
                tab === t.key
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>

      <Notice notice={notice} />

      {tab === "installed" && (
        <div className="overflow-hidden rounded-lg border border-line bg-paper">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-medium">Skill</th>
                <th className="px-4 py-2.5 font-medium">Version</th>
                <th className="px-4 py-2.5 font-medium">Source</th>
                <th className="px-4 py-2.5 font-medium">Trust</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-4 py-3">
                    <div className="font-medium text-ink">{s.name}</div>
                    {s.description && (
                      <div className="mt-0.5 max-w-md text-xs text-muted">
                        {s.description}
                      </div>
                    )}
                    <div className="mt-0.5 font-mono text-xs text-subtle">{s.slug}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink">{s.version ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className={chipCls}>{s.source}</span>
                    {s.sourceRef && (
                      <div className="mt-1 max-w-48 truncate font-mono text-xs text-subtle">
                        {s.sourceRef}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">{trustBadge(s)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      {s.source === "url" && (
                        <button
                          onClick={() => repin(s.id, s.name)}
                          disabled={busy === s.id}
                          className={btnGhost}
                        >
                          {busy === s.id ? "Working…" : "Re-pin"}
                        </button>
                      )}
                      <button
                        onClick={() => removeSkill(s.id, s.name)}
                        disabled={busy === s.id}
                        className={btnDeny}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {skills.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted">
                    No skills installed yet. Install one from the registry, a URL, or an upload.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "registry" && (
        <div className="grid gap-4 md:grid-cols-2">
          {packs.map((p) => {
            const installed = skills.some(
              (s) => s.source === "registry" && s.sourceRef === p.key,
            );
            return (
              <div key={p.key} className={cardCls}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium text-ink">{p.name}</h3>
                    <p className="mt-1 text-sm text-muted">{p.description}</p>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-subtle">
                    v{p.version}
                  </span>
                </div>
                {p.declaredTools.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {p.declaredTools.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-muted"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-4">
                  <button
                    onClick={() => installPack(p.key)}
                    disabled={busy === p.key || installed}
                    className={installed ? btnGhost : btnPrimary}
                  >
                    {installed
                      ? "Installed"
                      : busy === p.key
                        ? "Installing…"
                        : "Install"}
                  </button>
                </div>
              </div>
            );
          })}
          {packs.length === 0 && (
            <p className="text-sm text-muted">No registry packs available.</p>
          )}
        </div>
      )}

      {tab === "url" && (
        <div className={cardCls}>
          <h3 className="font-medium text-ink">Install from a GitHub URL</h3>
          <p className="mt-1 text-sm text-muted">
            ShapesOS fetches the repo&apos;s SKILL.md and pins the install to the
            current commit SHA. URL skills are flagged as untrusted until reviewed —
            they never auto-update.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              type="url"
              placeholder="https://github.com/acme/seo-skills"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={`${inputCls} min-w-64 flex-1`}
            />
            <button
              onClick={previewUrl}
              disabled={busy === "preview" || !url.trim()}
              className={btnGhost}
            >
              {busy === "preview" ? "Fetching…" : "Preview"}
            </button>
          </div>
          {preview && (
            <div className="mt-4 rounded-lg border border-line bg-needs-tint p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-ink">{preview.name}</p>
                  <p className="mt-1 text-sm text-ink">{preview.description}</p>
                  <p className="mt-1 font-mono text-xs text-muted">
                    v{preview.version ?? "n/a"} · SHA {preview.sha.slice(0, 7)}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-paper px-2.5 py-0.5 text-xs font-medium text-ink shadow-control">
                  <span className="aos-shape aos-shape--needs aos-shape--edged" role="img" aria-label="Warning" />
                  Untrusted source — review before installing
                </span>
              </div>
              {preview.warnings.length > 0 && (
                <ul className="mt-3 list-disc pl-5 text-sm text-ink">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="mt-4">
                <button
                  onClick={installUrl}
                  disabled={busy === "install-url"}
                  className={btnPrimary}
                >
                  {busy === "install-url" ? "Installing…" : "Confirm install"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "upload" && (
        <div className={cardCls}>
          <h3 className="font-medium text-ink">Upload a SKILL.md file</h3>
          <p className="mt-1 text-sm text-muted">
            Paste SKILL.md content or choose a file. Uploads are stored as-is in
            this workspace and never auto-update.
          </p>
          <div className="mt-3">
            <label className={labelCls}>
              File name (optional)
              <input
                type="text"
                placeholder="my-skill.md"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                className={`${inputCls} mt-1 w-full max-w-sm`}
              />
            </label>
          </div>
          <div className="mt-3">
            <label className={labelCls}>
              SKILL.md content
              <textarea
                value={skillMd}
                onChange={(e) => setSkillMd(e.target.value)}
                rows={12}
                placeholder="---&#10;name: my-skill&#10;description: …&#10;---&#10;"
                className={`${inputCls} mt-1 w-full font-mono text-xs`}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              onChange={onFile}
              className="hidden"
            />
            <button onClick={() => fileRef.current?.click()} className={btnGhost}>
              Choose file
            </button>
            <button
              onClick={installUpload}
              disabled={busy === "upload" || !skillMd.trim()}
              className={btnPrimary}
            >
              {busy === "upload" ? "Installing…" : "Install skill"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
