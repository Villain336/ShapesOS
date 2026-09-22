"use client";

// Marketr — chat file attach (milestone 21, part D2).
// Renders the attach button + staged attachment chips above the composer.
// Upload:   POST /api/projects/[projectId]/files (multipart, field `file`)
// Reference:POST /api/projects/[projectId]/files { connectorKey, externalRef, filename }
// The staged files ride along with the next message as `attachmentIds`
// (see ChatContext.sendMessage).

import { useRef, useState } from "react";
import { FileText, Paperclip, Warning, X } from "@/components/vault/phosphor";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/vault/shadcn/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/vault/shadcn/dialog";
import { Field } from "@/components/vault/Field";
import { Input } from "@/components/vault/shadcn/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
import { buttonVariants } from "@/components/vault/atoms/button-variants";
import { cn } from "@/lib/utils";
import { useChat } from "./ChatContext";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

interface DataSourceBinding {
  id: string;
  connectorKey: string;
  displayName: string;
}

export default function AttachmentMenu() {
  const {
    session,
    pendingAttachments,
    addPendingAttachment,
    removePendingAttachment,
  } = useChat();
  const [menuOpen, setMenuOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bindings, setBindings] = useState<DataSourceBinding[]>([]);
  const [connectorKey, setConnectorKey] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [filename, setFilename] = useState("");
  const [referencing, setReferencing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const projectId = session?.projectId ?? null;
  const canEdit = session?.canEdit ?? false;

  async function uploadSelected(list: FileList | null) {
    if (!list || list.length === 0 || uploading || !projectId) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        if (file.size > MAX_BYTES) {
          throw new Error(`${file.name} is over the 25 MB upload limit.`);
        }
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(`/api/projects/${projectId}/files`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Upload failed for ${file.name}`);
        }
        const data = await res.json();
        const f = data.file as { id: string; filename: string };
        addPendingAttachment({ id: f.id, filename: f.filename });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function openDriveDialog() {
    setMenuOpen(false);
    setDriveOpen(true);
    setError(null);
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/data-sources`);
      if (!res.ok) return;
      const data = await res.json();
      const all = (data.bindings ?? []) as {
        id: string;
        connectorKey: string;
        displayName: string;
      }[];
      setBindings(
        all.filter((b) =>
          ["google-drive", "notion"].includes(b.connectorKey),
        ),
      );
    } catch {
      // Bindings list is best-effort; the form still accepts a manual entry.
    }
  }

  async function addReference() {
    if (!projectId || !connectorKey || !externalRef.trim() || !filename.trim() || referencing)
      return;
    setReferencing(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorKey,
          externalRef: externalRef.trim(),
          filename: filename.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Reference failed");
      }
      const data = await res.json();
      const f = data.file as { id: string; filename: string };
      addPendingAttachment({ id: f.id, filename: f.filename });
      setDriveOpen(false);
      setConnectorKey("");
      setExternalRef("");
      setFilename("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reference failed");
    } finally {
      setReferencing(false);
    }
  }

  if (!projectId || !canEdit) return null;

  return (
    <div className="flex flex-col gap-1.5 px-1 pb-1">
      {/* Staged attachment chips */}
      {pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pendingAttachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex h-7 items-center gap-1.5 rounded-full bg-field py-1 pl-2.5 pr-1 text-[12px] text-ink-2 shadow-hairline"
              style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}
            >
              <FileText className="size-3.5" weight="duotone" />
              <span className="max-w-40 truncate">{a.filename}</span>
              <button
                type="button"
                aria-label={`Remove ${a.filename}`}
                onClick={() => removePendingAttachment(a.id)}
                className="flex size-5 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-line hover:text-ink"
              >
                <X className="size-3" weight="bold" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Attach row */}
      <div className="flex items-center gap-2">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            aria-label="Attach a file"
            className="flex size-7 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
          >
            <Paperclip className="size-4" weight="duotone" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Attach to this message</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => {
                setMenuOpen(false);
                fileInputRef.current?.click();
              }}
            >
              Upload file
              <span className="ml-auto text-[11px] text-ink-3">max 25 MB</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void openDriveDialog()}>
              From Drive / Notion
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-hidden
          tabIndex={-1}
          className="hidden"
          onChange={(e) => void uploadSelected(e.target.files)}
        />
        {uploading && (
          <span className="text-[12px] text-ink-3">Uploading…</span>
        )}
        {error && (
          <span className="flex items-center gap-1 text-[12px] text-red">
            <Warning className="size-3.5" />
            {error}
          </span>
        )}
      </div>

      {/* From Drive / Notion dialog */}
      <Dialog open={driveOpen} onOpenChange={setDriveOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Attach from Drive or Notion</DialogTitle>
            <DialogDescription>
              Reference a file from a bound Drive/Notion data source — nothing
              is copied, Marketr reads it on reference.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-1">
            <Field label="Connector" htmlFor="chat-ref-connector">
              <Select value={connectorKey} onValueChange={(v) => setConnectorKey(v ?? "")}>
                <SelectTrigger id="chat-ref-connector">
                  <SelectValue placeholder="Choose a connector" />
                </SelectTrigger>
                <SelectContent>
                  {bindings.length === 0 ? (
                    <SelectItem value="google-drive">Google Drive</SelectItem>
                  ) : null}
                  {bindings.map((b) => (
                    <SelectItem key={b.id} value={b.connectorKey}>
                      {b.displayName}
                    </SelectItem>
                  ))}
                  {!bindings.some((b) => b.connectorKey === "notion") && (
                    <SelectItem value="notion">Notion</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field label="File reference" htmlFor="chat-ref-external">
              <Input
                id="chat-ref-external"
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                placeholder="Drive file ID or Notion page ID"
              />
            </Field>
            <Field label="Filename" htmlFor="chat-ref-filename">
              <Input
                id="chat-ref-filename"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="Q3-brief.pdf"
              />
            </Field>
            {error && (
              <p className="flex items-center gap-1.5 text-[12.5px] text-red">
                <Warning className="size-3.5" />
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDriveOpen(false)}
                className={cn(buttonVariants({ variant: "quiet", size: "sm" }))}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  !connectorKey || !externalRef.trim() || !filename.trim() || referencing
                }
                onClick={() => void addReference()}
                className={cn(buttonVariants({ variant: "accent", size: "sm" }))}
              >
                {referencing ? "Adding…" : "Attach"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
