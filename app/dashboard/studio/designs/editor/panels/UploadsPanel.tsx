// Marketr — Phase 11 "Canvas": Uploads panel. Browser-session image uploads
// plus AI-generated images — one shared shelf (see lib/design/assets.ts).
// Assets are placed on canvas by the user, never automatically, and are
// saved into the design.
//
// Upload pipeline (integration #7, 2026-09-27): when Cloudinary is
// configured, uploads go direct-to-Cloudinary with a server-minted
// signature and the design element stores the Cloudinary DELIVERY URL —
// never base64. When not configured, the panel keeps its local data-URL
// behavior with an honest empty state pointing at Settings → Providers.

"use client";

import { useEffect, useRef, useState } from "react";
import { Cloud, ImagePlus, Sparkles } from "lucide-react";
import { useCanvasStore } from "@/lib/design/store";
import { imageDimensions, newAssetId, useSessionAssets, type SessionAsset } from "@/lib/design/assets";
import { fitBox, makeImage } from "../factory";
import { btnPrimary, panelTitle } from "../ui";

const MAX_DIM = 800;
// BEGIN: integration-7 cloudinary (2026-09-27) — Cloudinary pipeline
// The sign route validates type/size server-side; this mirrors the 10 MiB
// cap client-side so obviously-bad files fail fast without a round trip.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Client-safe signed-upload envelope from POST /api/studio/cloudinary/sign. */
interface CloudinarySign {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
  publicId: string;
  deliveryUrl: string;
  thumbUrl: string;
}

async function uploadOneViaCloudinary(file: File): Promise<SessionAsset> {
  const signRes = await fetch("/api/studio/cloudinary/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size }),
  });
  const sign = (await signRes.json()) as CloudinarySign & { error?: string };
  if (!signRes.ok || !sign.uploadUrl) {
    throw new Error(sign.error ?? "Could not start the Cloudinary upload.");
  }
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", sign.apiKey);
  form.append("timestamp", String(sign.timestamp));
  form.append("signature", sign.signature);
  form.append("folder", sign.folder);
  form.append("public_id", sign.publicId);
  const upRes = await fetch(sign.uploadUrl, { method: "POST", body: form });
  if (!upRes.ok) throw new Error("Upload to Cloudinary failed.");
  const up = (await upRes.json()) as { width?: number; height?: number };
  const width = typeof up.width === "number" && up.width > 0 ? up.width : 0;
  const height = typeof up.height === "number" && up.height > 0 ? up.height : 0;
  if (!width || !height) throw new Error("Cloudinary did not return image dimensions.");
  return {
    id: newAssetId("cld"),
    name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "Upload",
    // Shelf preview: the w_400 delivery URL; the placed element uses fullUrl.
    dataUrl: sign.thumbUrl,
    fullUrl: sign.deliveryUrl,
    cloudinaryPublicId: sign.publicId,
    width,
    height,
    origin: "upload",
  };
}
// END: integration-7 cloudinary

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

export function UploadsPanel() {
  const document = useCanvasStore((s) => s.document);
  const activePageId = useCanvasStore((s) => s.activePageId);
  const addElement = useCanvasStore((s) => s.addElement);
  const assets = useSessionAssets((s) => s.assets);
  const addAssets = useSessionAssets((s) => s.addAssets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // BEGIN: integration-7 cloudinary (2026-09-27)
  // null = status unknown (still loading); assume local until proven otherwise.
  const [cloudinaryConfigured, setCloudinaryConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/studio/cloudinary/status")
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((s: { configured?: boolean }) => {
        if (alive) setCloudinaryConfigured(s.configured === true);
      })
      .catch(() => {
        if (alive) setCloudinaryConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const useCloudinary = cloudinaryConfigured === true;
  // END: integration-7 cloudinary

  const page = document?.pages.find((p) => p.id === activePageId);
  if (!page) return null;

  const place = (u: SessionAsset) => {
    const { width, height } = fitBox(u.width, u.height, MAX_DIM);
    // BEGIN: integration-7 cloudinary (2026-09-27)
    // Cloudinary assets place the full-res DELIVERY URL (never base64);
    // provenance travels in the element's `custom` bag.
    const el = makeImage({
      src: u.fullUrl ?? u.dataUrl,
      width,
      height,
      pageW: page.width,
      pageH: page.height,
      name: u.name,
    });
    if (u.cloudinaryPublicId) {
      el.custom = { provider: "cloudinary", publicId: u.cloudinaryPublicId };
    }
    addElement(el);
    // END: integration-7 cloudinary
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const next: SessionAsset[] = [];
      // BEGIN: integration-7 cloudinary (2026-09-27)
      let hadError = false;
      if (useCloudinary) {
        for (const file of Array.from(files).slice(0, 5)) {
          if (!file.type.startsWith("image/")) continue;
          if (file.size > MAX_UPLOAD_BYTES) {
            hadError = true;
            setError(`"${file.name}" is over the 10 MB upload limit.`);
            continue;
          }
          try {
            next.push(await uploadOneViaCloudinary(file));
          } catch (e) {
            hadError = true;
            setError(e instanceof Error ? e.message : "Upload failed.");
          }
        }
      } else {
        // END: integration-7 cloudinary
        for (const file of Array.from(files).slice(0, 5)) {
          if (!file.type.startsWith("image/")) continue;
          const dataUrl = await readAsDataUrl(file);
          const size = await imageDimensions(dataUrl);
          next.push({
            id: newAssetId("up"),
            name: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "Upload",
            dataUrl,
            width: size.width,
            height: size.height,
            origin: "upload",
          });
        }
        // BEGIN: integration-7 cloudinary (2026-09-27)
      }
      // END: integration-7 cloudinary
      if (next.length === 0 && !hadError) {
        setError("No image files in that selection.");
      } else if (next.length > 0) {
        addAssets(next);
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
          {useCloudinary ? <Cloud className="h-4 w-4" /> : <ImagePlus className="h-4 w-4" />}
          {busy ? "Uploading…" : "Upload images"}
        </button>
        {error && (
          <p className="rounded-md border border-line bg-canvas px-2.5 py-2 text-[12px] text-muted">
            {error}
          </p>
        )}
        {assets.length > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            {assets.map((u) => (
              <button
                key={u.id}
                onClick={() => place(u)}
                title={`Place ${u.name}`}
                className="group relative overflow-hidden rounded-md border border-line bg-paper hover:border-line-strong"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u.dataUrl} alt={u.name} className="h-20 w-full object-cover" />
                {u.origin === "generated" && (
                  <span className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-ink px-1 py-0.5 text-[9px] font-semibold text-white">
                    <Sparkles className="h-2.5 w-2.5" />
                    AI
                  </span>
                )}
                <div className="truncate px-1.5 py-1 text-left text-[11px] text-muted group-hover:text-ink">
                  {u.name}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-snug text-muted">
            No uploads yet. Images are placed at page center, capped at {MAX_DIM}px on the long edge.
          </p>
        )}
        {/* BEGIN: integration-7 cloudinary (2026-09-27) — pipeline state note */}
        {useCloudinary ? (
          <p className="border-t border-line pt-2 text-[11px] leading-snug text-subtle">
            Uploads go straight to your Cloudinary account with auto format and
            quality (f_auto,q_auto). Quota: 25 credits/month on Cloudinary&apos;s
            free tier — metered by Cloudinary, not by ShapesOS.
          </p>
        ) : (
          <p className="border-t border-line pt-2 text-[11px] leading-snug text-subtle">
            Uploads stay in your browser session and are saved into this design
            as data URLs.{" "}
            <a href="/dashboard/settings/providers" className="text-ink underline hover:no-underline">
              Connect Cloudinary
            </a>{" "}
            for faster uploads + auto-optimization.
          </p>
        )}
        {/* END: integration-7 cloudinary */}
      </div>
    </div>
  );
}
