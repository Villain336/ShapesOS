// Marketr — workspace skills manager (milestone 21, part D1).
// Client component: Installed / Registry / Install from URL / Upload tabs.
// URL installs are pinned to a commit SHA and flagged as untrusted;
// re-pinning to a newer commit is a deliberate one-click action.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Notice,
  btnCls,
  cardCls,
  dangerBtnCls,
  inputCls,
  labelCls,
  primaryBtnCls,
  type NoticeState,
} from "./ui";

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

const TABS: { key: Tab; label: string }[] = [
  { key: "installed", label: "Installed" },
  { key: "registry", label: "Registry" },
  { key: "url", label: "Install from URL" },
  { key: "upload", label: "Upload" },
];

const SOURCE_BADGE: Record<Skill["source"], string> = {
  registry: "bg-emerald-50 text-emerald-700",
  url: "bg-amber-50 text-amber-700",
  upload: "bg-zinc-100 text-zinc-600",
};

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
    if (!confirm(`Re-pin "${name}" to the latest commit? This updates its SHA pin.`)) return;
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
    if (!confirm(`Delete the "${name}" skill from this workspace?`)) return;
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

  function trustBadge(s: Skill) {
    if (s.trustTier === "built-in") {
      return (
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
          Built-in
        </span>
      );
    }
    return (
      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
        Untrusted source — pinned to {(s.shaPin ?? "").slice(0, 7) || "unknown"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-xl border border-zinc-200 bg-white/60 p-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              tab === t.key
                ? "bg-zinc-900 text-white"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Notice notice={notice} />

      {tab === "installed" && (
        <div className="overflow-hidden rounded-xl border border-zinc-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-white/60 text-left text-xs uppercase tracking-widest text-zinc-500">
                <th className="px-4 py-3">Skill</th>
                <th className="px-4 py-3">Version</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Trust</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id} className="border-b border-zinc-200/60 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{s.name}</div>
                    {s.description && (
                      <div className="mt-0.5 max-w-md text-xs text-zinc-500">
                        {s.description}
                      </div>
                    )}
                    <div className="mt-0.5 font-mono text-xs text-zinc-400">{s.slug}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{s.version ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${SOURCE_BADGE[s.source]}`}
                    >
                      {s.source}
                    </span>
                    {s.sourceRef && (
                      <div className="mt-1 max-w-48 truncate font-mono text-xs text-zinc-400">
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
                          className={btnCls}
                        >
                          {busy === s.id ? "Working…" : "Re-pin"}
                        </button>
                      )}
                      <button
                        onClick={() => removeSkill(s.id, s.name)}
                        disabled={busy === s.id}
                        className={dangerBtnCls}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {skills.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
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
                    <h3 className="font-medium">{p.name}</h3>
                    <p className="mt-1 text-sm text-zinc-500">{p.description}</p>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-zinc-400">
                    v{p.version}
                  </span>
                </div>
                {p.declaredTools.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {p.declaredTools.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs text-zinc-600"
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
                    className={installed ? btnCls : primaryBtnCls}
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
            <p className="text-sm text-zinc-500">No registry packs available.</p>
          )}
        </div>
      )}

      {tab === "url" && (
        <div className={cardCls}>
          <h3 className="font-medium">Install from a GitHub URL</h3>
          <p className="mt-1 text-sm text-zinc-500">
            Marketr fetches the repo&apos;s SKILL.md and pins the install to the
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
              className={btnCls}
            >
              {busy === "preview" ? "Fetching…" : "Preview"}
            </button>
          </div>
          {preview && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{preview.name}</p>
                  <p className="mt-1 text-sm text-zinc-600">{preview.description}</p>
                  <p className="mt-1 font-mono text-xs text-zinc-500">
                    v{preview.version ?? "n/a"} · SHA {preview.sha.slice(0, 7)}
                  </p>
                </div>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  Untrusted source — review before installing
                </span>
              </div>
              {preview.warnings.length > 0 && (
                <ul className="mt-3 list-disc pl-5 text-sm text-amber-800">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              <div className="mt-4">
                <button
                  onClick={installUrl}
                  disabled={busy === "install-url"}
                  className={primaryBtnCls}
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
          <h3 className="font-medium">Upload a SKILL.md file</h3>
          <p className="mt-1 text-sm text-zinc-500">
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
            <button onClick={() => fileRef.current?.click()} className={btnCls}>
              Choose file
            </button>
            <button
              onClick={installUpload}
              disabled={busy === "upload" || !skillMd.trim()}
              className={primaryBtnCls}
            >
              {busy === "upload" ? "Installing…" : "Install skill"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
