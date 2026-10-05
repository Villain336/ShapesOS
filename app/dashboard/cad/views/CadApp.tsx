"use client";

// Marketr — CAD + Hardware slice 1: CAD viewer + versioning home.
// Agentic OS design system (docs/design/DESIGN.md): canvas page, white
// surfaces, black primary actions, Lucide icons only, tokens only.
// Reference customer: the drone program's airframe revisions.

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Plus, Loader2, FolderKanban, TableProperties, LayoutDashboard } from "lucide-react";
import { ModelDetail, isModelTab, type TabKey } from "./ModelDetail";
import { ProjectHubTab } from "./ProjectHubTab";

interface Project {
  id: string;
  name: string;
  description: string | null;
  _count?: { models: number };
}

interface ModelSummary {
  id: string;
  name: string;
  description: string | null;
  currentVersion: { id: string; versionNumber: number; format: string } | null;
  _count: { versions: number; shareLinks: number };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export interface CadDeepLink {
  project: string | null;
  model: string | null;
  tab: string | null;
}

export function CadApp({ deepLink }: { deepLink?: CadDeepLink } = {}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [projectView, setProjectView] = useState<"models" | "hub">("models");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  // Deep link (record search): /dashboard/cad?project=…&model=…&tab=…
  // Applied once, when the linked project's models load.
  const pendingLink = useRef<CadDeepLink | null>(deepLink ?? null);
  const [initialTab, setInitialTab] = useState<TabKey | undefined>(undefined);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await api<{ projects: Project[] }>("/api/cad/projects");
      setProjects(body.projects);
      if (!selectedProjectId && body.projects.length > 0) {
        const wanted = pendingLink.current?.project;
        const match = wanted ? body.projects.find((p) => p.id === wanted) : undefined;
        setSelectedProjectId((match ?? body.projects[0]!).id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load projects.");
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const loadModels = useCallback(async (projectId: string) => {
    setModelsLoading(true);
    try {
      const body = await api<{ models: ModelSummary[] }>(
        `/api/cad/projects/${projectId}/models`,
      );
      setModels(body.models);
      const link = pendingLink.current;
      if (link?.model && link.project === projectId && body.models.some((m) => m.id === link.model)) {
        setInitialTab(isModelTab(link.tab) ? link.tab : undefined);
        setSelectedModelId(link.model);
        pendingLink.current = null;
      }
    } catch {
      setModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      setSelectedModelId(null);
      loadModels(selectedProjectId);
    }
  }, [selectedProjectId, loadModels]);

  const createProject = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const body = await api<{ project: Project }>("/api/cad/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || null }),
      });
      setProjects((p) => [body.project, ...p]);
      setSelectedProjectId(body.project.id);
      setNewName("");
      setNewDesc("");
      setShowNewProject(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the project.");
    } finally {
      setCreating(false);
    }
  };

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* Project rail */}
      <section className="rounded-lg border border-line bg-paper p-3 shadow-hairline" aria-label="CAD projects">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">Projects</h2>
          <button
            type="button"
            onClick={() => setShowNewProject((s) => !s)}
            className="flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 text-xs font-semibold text-paper"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New project
          </button>
        </div>
        {showNewProject && (
          <div className="mb-3 rounded-lg border border-line bg-canvas p-3">
            <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-project-name">
              Project name
            </label>
            <input
              id="cad-project-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Drone airframe"
              className="mb-2 h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
            />
            <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-project-desc">
              Description
            </label>
            <textarea
              id="cad-project-desc"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="What this project is building"
              rows={2}
              className="mb-2 w-full rounded-md border border-control bg-paper px-3 py-2 text-sm text-ink"
            />
            <button
              type="button"
              onClick={createProject}
              disabled={creating || !newName.trim()}
              className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ink text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Create project
            </button>
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading projects…
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-lg border border-line bg-canvas p-4 text-sm text-muted">
            <FolderKanban className="mb-2 h-5 w-5" aria-hidden />
            No projects yet. Create one to start versioning CAD models — the
            drone airframe is the reference workflow.
          </div>
        ) : (
          <ul className="space-y-1">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelectedProjectId(p.id)}
                  aria-current={p.id === selectedProjectId ? "true" : undefined}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors ${
                    p.id === selectedProjectId
                      ? "bg-ink font-semibold text-paper"
                      : "text-ink hover:bg-hover-paper"
                  }`}
                >
                  <span className="truncate">{p.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-xs ${
                      p.id === selectedProjectId ? "bg-night-raised text-night-text" : "bg-canvas text-muted"
                    }`}
                  >
                    {p._count?.models ?? 0}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
      </section>

      {/* Models column */}
      <section className="min-w-0 rounded-lg border border-line bg-paper p-4 shadow-hairline" aria-label="Models">
        {!selectedProject ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted">
            Select a project to see its models.
          </div>
        ) : selectedModelId ? (
          <ModelDetail
            modelId={selectedModelId}
            initialTab={initialTab}
            onBack={() => {
              setSelectedModelId(null);
              setInitialTab(undefined);
              if (selectedProjectId) loadModels(selectedProjectId);
            }}
            onChanged={() => selectedProjectId && loadModels(selectedProjectId)}
          />
        ) : (
          <>
            <div className="mb-3">
              <h2 className="text-lg font-semibold text-ink" style={{ fontStretch: "115%" }}>
                {selectedProject.name}
              </h2>
              {selectedProject.description && (
                <p className="mt-0.5 text-sm text-muted">{selectedProject.description}</p>
              )}
            </div>
            <div className="mb-4 flex gap-1 border-b border-line" role="tablist" aria-label="Project views">
              {(
                [
                  { key: "models", label: "Models", icon: TableProperties },
                  { key: "hub", label: "Project hub", icon: LayoutDashboard },
                ] as const
              ).map((t) => {
                const Icon = t.icon;
                const active = projectView === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setProjectView(t.key)}
                    className={`flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-semibold transition-colors ${
                      active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
                    }`}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {t.label}
                  </button>
                );
              })}
            </div>
            {projectView === "hub" ? (
              <ProjectHubTab projectId={selectedProject.id} />
            ) : modelsLoading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Loading models…
              </div>
            ) : models.length === 0 ? (
              <UploadFirstModel
                projectId={selectedProject.id}
                onUploaded={() => loadModels(selectedProject.id)}
              />
            ) : (
              <ModelTable
                models={models}
                onSelect={setSelectedModelId}
                onUpload={() => loadModels(selectedProject.id)}
                projectId={selectedProject.id}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function ModelTable({
  models,
  onSelect,
  onUpload,
  projectId,
}: {
  models: ModelSummary[];
  onSelect: (id: string) => void;
  onUpload: () => void;
  projectId: string;
}) {
  const [showUpload, setShowUpload] = useState(false);
  return (
    <>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => setShowUpload((s) => !s)}
          className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
        >
          <Plus className="h-4 w-4" aria-hidden />
          Upload model
        </button>
      </div>
      {showUpload && (
        <div className="mb-3">
          <UploadForm projectId={projectId} onDone={() => { setShowUpload(false); onUpload(); }} />
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
              <th className="px-3 py-2.5">Model</th>
              <th className="px-3 py-2.5">Format</th>
              <th className="px-3 py-2.5">Current</th>
              <th className="px-3 py-2.5">Versions</th>
              <th className="px-3 py-2.5">Links</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                <td className="px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => onSelect(m.id)}
                    className="flex items-center gap-2 font-medium text-ink underline-offset-2 hover:underline"
                  >
                    <Box className="h-4 w-4 text-muted" aria-hidden />
                    {m.name}
                  </button>
                </td>
                <td className="px-3 py-2.5">
                  <span className="rounded-full bg-canvas px-2.5 py-1 font-mono text-xs font-semibold text-ink">
                    {(m.currentVersion?.format ?? "—").toUpperCase()}
                  </span>
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted">
                  {m.currentVersion ? `v${m.currentVersion.versionNumber}` : "—"}
                </td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted">{m._count.versions}</td>
                <td className="px-3 py-2.5 font-mono text-xs text-muted">{m._count.shareLinks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function UploadFirstModel({ projectId, onUploaded }: { projectId: string; onUploaded: () => void }) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-6">
      <h3 className="mb-1 text-base font-semibold text-ink">Upload your first model</h3>
      <p className="mb-4 text-sm text-muted">
        STL and OBJ render in the browser. STEP uploads are stored and versioned
        honestly — the preview stays unavailable until a real conversion exists.
      </p>
      <UploadForm projectId={projectId} onDone={onUploaded} />
    </div>
  );
}

export function UploadForm({
  projectId,
  modelId,
  onDone,
}: {
  projectId: string;
  modelId?: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<"fill" | "confirm">("fill");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (modelId) form.append("modelId", modelId);
      else form.append("name", name.trim());
      if (notes.trim()) form.append("notes", notes.trim());
      const res = await fetch(`/api/cad/projects/${projectId}/models`, {
        method: "POST",
        body: form,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Upload failed.");
      setStep("fill");
      setFile(null);
      setName("");
      setNotes("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  if (step === "confirm" && file) {
    return (
      <div className="rounded-lg border border-line bg-paper p-4" role="dialog" aria-label="Confirm version publish">
        <h3 className="mb-2 text-sm font-semibold text-ink">Confirm version publish</h3>
        <dl className="mb-4 space-y-1.5 text-sm">
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">File</dt>
            <dd className="font-mono text-xs text-ink">{file.name}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Size</dt>
            <dd className="font-mono text-xs text-ink">{(file.size / 1024).toFixed(1)} KB</dd>
          </div>
          {notes.trim() && (
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted">Notes</dt>
              <dd className="text-ink">{notes.trim()}</dd>
            </div>
          )}
        </dl>
        <p className="mb-4 text-sm text-muted">
          This publishes a new immutable version. Previous versions stay
          untouched — nothing is overwritten.
        </p>
        {error && <p className="mb-2 text-sm text-failed-text">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setStep("fill")}
            className="flex h-10 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
          >
            Back
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Publish version
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      {!modelId && (
        <div className="mb-3">
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-model-name">
            Model name
          </label>
          <input
            id="cad-model-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Frame — front left arm"
            className="h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
          />
        </div>
      )}
      <div className="mb-3">
        <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-model-file">
          Model file (STL, OBJ, or STEP — max 25 MB)
        </label>
        <input
          id="cad-model-file"
          type="file"
          accept=".stl,.obj,.step,.stp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="w-full text-sm text-ink file:mr-3 file:h-10 file:rounded-full file:border-0 file:bg-ink file:px-4 file:text-sm file:font-semibold file:text-paper"
        />
      </div>
      <div className="mb-3">
        <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="cad-model-notes">
          Version notes <span className="font-normal text-muted">(what changed)</span>
        </label>
        <input
          id="cad-model-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Thickened walls to 3 mm"
          className="h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink"
        />
      </div>
      {error && <p className="mb-2 text-sm text-failed-text">{error}</p>}
      <button
        type="button"
        onClick={() => file && setStep("confirm")}
        disabled={!file || (!modelId && !name.trim())}
        className="flex h-10 items-center rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
      >
        Continue
      </button>
    </div>
  );
}
