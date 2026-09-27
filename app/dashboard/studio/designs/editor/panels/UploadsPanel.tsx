// Marketr — Phase 11 "Canvas": Uploads panel. Browser-session image uploads
// (data URLs). Uploads stay in this browser session and are saved into the design.

"use client";

import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { fitBox, makeImage } from "../factory";
import { btnPrimary, panelTitle } from "../ui";

interface SessionUpload {
  id: string;
  name: string;
  dataUrl: string;
  width: number;
  height: number;
}

const MAX_DIM = 800;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function naturalSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = dataUrl;
  });
}

export function UploadsPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);
  const [uploads, setUploads] = useState<SessionUpload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const page = document?.pages.find((p) => p.id === activePageId);
  if (!page) return null;

  const place = (u: SessionUpload) => {
    const { width, height } = fitBox(u.width, u.height, MAX_DIM);
    addElement(
      makeImage({
        src: u.dataUrl,
        width,
        height,
        pageW: page.width,
        pageH: page.height,
        name: u.name,
      })
    );
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const next: SessionUpload[] = [];
      for (const file of Array.from(files).slice(0, 5)) {
        if (!file.type.startsWith("image/")) continue;
        const dataUrl = await readAsDataUrl(file);
        const size = await naturalSize(dataUrl);
        next.push({
          id: `up-${Date.now()}-${next.length}`,
          name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "Upload",
          dataUrl,
          width: size.width,
          height: size.height,
        });
      }
      if (next.length === 0) {
        setError("No image files in that selection.");
      } else {
        setUploads((prev) => [...next, ...prev]);
        place(next[0]!);
      }
    } catch {
      setError("Could not read that image.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <div className={panelTitle}>Uploads</div>
      <div className="space-y-3 px-3 pb-4">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
        <button onClick={() => inputRef.current?.click()} disabled={busy} className={btnPrimary}>
          <ImagePlus className="h-4 w-4" />
          {busy ? "Reading…" : "Upload images"}
        </button>
        {error && (
          <p className="rounded-md border border-stone-200 bg-stone-50 px-2.5 py-2 text-[12px] text-stone-600">
            {error}
          </p>
        )}
        {uploads.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {uploads.map((u) => (
              <button
                key={u.id}
                onClick={() => place(u)}
                title={`Place ${u.name}`}
                className="group overflow-hidden rounded-md border border-stone-200 bg-white hover:border-violet-400"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u.dataUrl} alt={u.name} className="h-20 w-full object-cover" />
                <div className="truncate px-1.5 py-1 text-left text-[11px] text-stone-600 group-hover:text-violet-700">
                  {u.name}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-snug text-stone-500">
            No uploads yet. Images are placed at page center, capped at {MAX_DIM}px on the long edge.
          </p>
        )}
        <p className="border-t border-stone-100 pt-2 text-[11px] leading-snug text-stone-400">
          Uploads stay in your browser session and are saved into this design as data URLs.
        </p>
      </div>
    </div>
  );
}
