"use client";

// Marketr — project settings: Files client (milestone 21, part D2).
//   Upload:   POST /api/projects/[id]/files (multipart, field `file`)
//   Reference:POST /api/projects/[id]/files { connectorKey, externalRef, filename, mimeType? }
//   Download: GET  /api/projects/[id]/files/[fileId]/download
//   Delete:   DELETE /api/projects/[id]/files/[fileId]
//   Refresh:  GET  /api/projects/[id]/files

import { useRef, useState } from "react";
import { FileText, TriangleAlert } from "lucide-react";
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
import { EmptyState } from "@/components/vault/EmptyState";
import { confirmAction } from "@/lib/ui/feedback";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export interface FileRow {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  source: string;
  connectorKey: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface ConnectorOption {
  connectorKey: string;
  displayName: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesClient({
  projectId,
  canEdit,
  initialFiles,
  connectorOptions,
}: {
  projectId: string;
  canEdit: boolean;
  initialFiles: FileRow[];
  connectorOptions: ConnectorOption[];
}) {
  const [files, setFiles] = useState(initialFiles);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reference-from-connector form state
  const [connectorKey, setConnectorKey] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [refFilename, setRefFilename] = useState("");
  const [referencing, setReferencing] = useState(false);

  async function refresh() {
    const res = await fetch(`/api/projects/${projectId}/files`);
    if (!res.ok) return;
    const data = await res.json();
    setFiles((data.files ?? []) as FileRow[]);
  }

  async function uploadSelected(list: FileList | null) {
    if (!list || list.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(list)) {
        if (file.size > MAX_BYTES) {
          throw new Error(
            `${file.name} is over the 25 MB upload limit.`,
          );
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
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function addReference() {
    if (!connectorKey || !externalRef.trim() || !refFilename.trim() || referencing) return;
    setReferencing(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectorKey,
          externalRef: externalRef.trim(),
          filename: refFilename.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Reference failed");
      }
      setConnectorKey("");
      setExternalRef("");
      setRefFilename("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reference failed");
    } finally {
      setReferencing(false);
    }
  }

  async function removeFile(id: string) {
    const ok = await confirmAction({
      title: "Delete this file?",
      description: "It is removed from the project and can't be recovered.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Delete failed");
      }
      setFiles((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {files.length === 0 ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="No files yet"
          description="Upload a brief or reference one from a connected Drive/Notion, then attach it to a Marketr chat."
        />
      ) : (
        <ul className="flex flex-col">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-inset text-ink-2">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-ink">
                    {f.filename}
                  </p>
                  <p className="text-[12px] text-ink-3">
                    {formatSize(f.sizeBytes)}
                    {" · "}
                    {f.source === "upload" ? "Upload" : `Connector: ${f.connectorKey}`}
                    {f.sessionId ? " · Chat session" : ""}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {f.source === "upload" && (
                  <a
                    href={`/api/projects/${projectId}/files/${f.id}/download`}
                    className={cn(buttonVariants({ variant: "quiet", size: "sm" }))}
                  >
                    Download
                  </a>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => void removeFile(f.id)}
                    className={cn(buttonVariants({ variant: "quiet", size: "sm" }))}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-col gap-4 rounded-control bg-inset p-4">
          <div className="flex flex-col gap-2">
            <h4 className="text-[13.5px] font-medium text-ink">Upload a file</h4>
            <input
              ref={fileInputRef}
              type="file"
              aria-label="Choose a file to upload"
              onChange={(e) => void uploadSelected(e.target.files)}
              className="text-[12.5px] text-ink-2 file:mr-3 file:rounded-control file:border-0 file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:font-medium file:text-ink file:shadow-hairline hover:file:bg-hover"
            />
            <p className="text-[12px] text-ink-3">
              {uploading ? "Uploading…" : "Max 25 MB per file."}
            </p>
          </div>

          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <h4 className="text-[13.5px] font-medium text-ink">
              Reference from a connector
            </h4>
            {connectorOptions.length === 0 ? (
              <p className="text-[12.5px] text-ink-3">
                Bind a Drive or Notion connection on the Data tab first.
              </p>
            ) : (
              <>
                <Field label="Connector" htmlFor="ref-connector">
                  <Select value={connectorKey} onValueChange={(v) => setConnectorKey(v ?? "")}>
                    <SelectTrigger id="ref-connector">
                      <SelectValue placeholder="Choose a connector" />
                    </SelectTrigger>
                    <SelectContent>
                      {connectorOptions.map((c) => (
                        <SelectItem key={c.connectorKey} value={c.connectorKey}>
                          {c.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="External reference" htmlFor="ref-external">
                    <Input
                      id="ref-external"
                      value={externalRef}
                      onChange={(e) => setExternalRef(e.target.value)}
                      placeholder="Drive file ID or Notion page ID"
                    />
                  </Field>
                  <Field label="Filename" htmlFor="ref-filename">
                    <Input
                      id="ref-filename"
                      value={refFilename}
                      onChange={(e) => setRefFilename(e.target.value)}
                      placeholder="Q3-brief.pdf"
                    />
                  </Field>
                </div>
                <div>
                  <button
                    type="button"
                    disabled={
                      !connectorKey ||
                      !externalRef.trim() ||
                      !refFilename.trim() ||
                      referencing
                    }
                    onClick={() => void addReference()}
                    className={cn(buttonVariants({ variant: "secondary", size: "sm" }))}
                  >
                    {referencing ? "Adding…" : "Add reference"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-[12.5px] text-red">
          <TriangleAlert className="size-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}
