// ShapesOS — Settings → General (Phase 3, workstream I).
// Rename (admin+), plan and trial at a glance with the way to billing,
// resume first-run setup, create another workspace, and delete this one
// (owner only, typed-name confirmation), and (admin+, Phase 4a) download a
// full JSON export of the workspace. Server rules live in
// lib/workspace/lifecycle.ts; this only mirrors them for the UI.

"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Download, Plus, Trash2 } from "lucide-react";
import { FormNote } from "./FormError";
import { Field } from "@/components/aos/Controls";
import {
  btnDanger,
  btnPrimary,
  btnSecondary,
  cardCls,
  helperCls,
} from "./aos";

export interface WorkspaceGeneralProps {
  workspace: { id: string; name: string; plan: string };
  role: "owner" | "admin" | "editor" | "viewer";
  planLabel: string;
  trial: { daysLeft: number; endsOn: string | null; expired: boolean } | null;
  onboardingCompleted: boolean;
  isLastWorkspace: boolean;
}

async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, data };
}

export default function WorkspaceGeneral(props: WorkspaceGeneralProps) {
  const { workspace, role } = props;
  const isAdmin = role === "owner" || role === "admin";
  const isOwner = role === "owner";

  const [name, setName] = useState(workspace.name);
  const [savedName, setSavedName] = useState(workspace.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameNote, setRenameNote] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setRenaming(true);
    setRenameError(null);
    setRenameNote(null);
    const { ok, data } = await send(`/api/workspaces/${workspace.id}`, "PATCH", { name });
    setRenaming(false);
    if (!ok) {
      setRenameError(String(data.error ?? "Couldn't rename the workspace. Try again."));
      return;
    }
    const next = (data.workspace as { name: string }).name;
    setName(next);
    setSavedName(next);
    setRenameNote("Renamed.");
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const { ok, data } = await send("/api/workspaces", "POST", { name: newName });
    if (!ok) {
      setCreating(false);
      setCreateError(String(data.error ?? "Couldn't create the workspace. Try again."));
      return;
    }
    // The API switched the active workspace; a full load re-resolves it
    // everywhere, and the dashboard opens the new workspace's setup.
    window.location.href = "/dashboard";
  }

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    const { ok, data } = await send(`/api/workspaces/${workspace.id}`, "DELETE", { confirmName: confirm });
    if (!ok) {
      setDeleting(false);
      setDeleteError(String(data.error ?? "Couldn't delete the workspace. Try again."));
      return;
    }
    window.location.href = "/dashboard";
  }

  const confirmMatches = confirm.trim() === savedName.trim() && confirm.trim().length > 0;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <section className={cardCls} aria-labelledby="ws-name">
        <h2 id="ws-name" className="aos-subheading">Workspace name</h2>
        <form onSubmit={rename} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1">
            <Field
              label="Workspace name"
              hideLabel
              value={name}
              maxLength={80}
              disabled={!isAdmin}
              onChange={(e) => {
                setName(e.target.value);
                if (renameError) setRenameError(null);
              }}
              helper={isAdmin ? "Up to 80 characters. Members see it in the workspace switcher." : "Only admins can rename the workspace."}
              error={renameError}
            />
            <FormNote message={renameNote} />
          </div>
          {isAdmin && (
            <button type="submit" className={btnPrimary} disabled={renaming || !name.trim() || name.trim() === savedName}>
              {renaming ? "Saving" : "Save name"}
            </button>
          )}
        </form>
      </section>

      <section className={cardCls} aria-labelledby="ws-plan">
        <h2 id="ws-plan" className="aos-subheading">Plan</h2>
        <p className="mt-2 text-base text-ink">
          {props.planLabel}
          {props.trial && !props.trial.expired && (
            <span className="text-muted">
              {" "}· {props.trial.daysLeft} day{props.trial.daysLeft === 1 ? "" : "s"} left
              {props.trial.endsOn ? ` (ends ${props.trial.endsOn})` : ""}
            </span>
          )}
          {props.trial?.expired && (
            <span className="text-muted"> · ended{props.trial.endsOn ? ` ${props.trial.endsOn}` : ""}</span>
          )}
        </p>
        {props.trial?.expired && (
          <p className={helperCls}>
            Credit-using actions are paused until this workspace has a plan. Everything you made is still here.
          </p>
        )}
        {isAdmin ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/dashboard/billing" className={props.trial ? btnPrimary : btnSecondary}>
              {props.trial ? "Choose a plan" : "Open billing"}
              <ArrowRight size={16} aria-hidden />
            </Link>
            <Link href="/dashboard/settings/usage" className={btnSecondary}>
              See usage
            </Link>
          </div>
        ) : (
          <p className={helperCls}>Ask a workspace admin to change the plan.</p>
        )}
      </section>

      {isAdmin && (
        <section className={cardCls} aria-labelledby="ws-setup">
          <h2 id="ws-setup" className="aos-subheading">Setup</h2>
          <p className="mt-2 text-base text-muted">
            {props.onboardingCompleted
              ? "Business type, website, goals, and first connections. Revisit any time."
              : "You haven't finished setting up this workspace yet. Pick up where you left off."}
          </p>
          <div className="mt-3">
            <Link href="/dashboard/welcome" className={btnSecondary}>
              {props.onboardingCompleted ? "Open setup" : "Resume setup"}
              <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
        </section>
      )}

      <section className={cardCls} aria-labelledby="ws-new">
        <h2 id="ws-new" className="aos-subheading">New workspace</h2>
        <p className="mt-2 text-base text-muted">
          A separate space with its own members, data, and plan. You&rsquo;ll be its owner.
        </p>
        <form onSubmit={create} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
          <Field
            className="flex-1"
            label="Name"
            value={newName}
            maxLength={80}
            placeholder="Acme Plumbing"
            onChange={(e) => {
              setNewName(e.target.value);
              if (createError) setCreateError(null);
            }}
            error={createError}
          />
          <button type="submit" className={`${btnPrimary} sm:mt-8`} disabled={creating || !newName.trim()}>
            <Plus size={16} aria-hidden />
            {creating ? "Creating" : "Create workspace"}
          </button>
        </form>
      </section>

      {isAdmin && (
        <section id="ws-export" className={cardCls} aria-labelledby="ws-export-heading">
          <h2 id="ws-export-heading" className="aos-subheading">Export workspace data</h2>
          <p className="mt-2 text-base text-muted">
            Everything {savedName} holds, as one JSON file: projects, content, contacts, reports, members, settings,
            and history. Passwords, keys and stored credentials are never included. The download is recorded in
            the audit log.
          </p>
          <div className="mt-3">
            <a href={`/api/workspaces/${workspace.id}/export`} download className={btnSecondary}>
              <Download size={16} aria-hidden />
              Download export
            </a>
          </div>
          <p className={helperCls}>Large workspaces can take a minute. Your own account data is in Your account.</p>
        </section>
      )}

      {isOwner && (
        <section className={cardCls} aria-labelledby="ws-delete">
          <h2 id="ws-delete" className="aos-subheading">Delete workspace</h2>
          <p className="mt-2 text-base text-muted">
            Deletes {savedName} and everything in it for every member: projects, content, contacts, files,
            reports, connections, and usage history. This can&rsquo;t be undone.
          </p>
          {props.isLastWorkspace ? (
            <p className={helperCls}>This is your only workspace. Create or join another one before deleting it.</p>
          ) : (
            <form onSubmit={remove} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
              <Field
                className="flex-1"
                label={
                  <>
                    Type <span className="aos-mono">{savedName}</span> to confirm
                  </>
                }
                value={confirm}
                autoComplete="off"
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (deleteError) setDeleteError(null);
                }}
                error={deleteError}
              />
              <button type="submit" className={`${btnDanger} sm:mt-8`} disabled={deleting || !confirmMatches}>
                <Trash2 size={16} aria-hidden />
                {deleting ? "Deleting" : "Delete workspace"}
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
