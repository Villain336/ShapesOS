// Marketr — white-label settings UI (Phase 13 Wave A, worker 6).
// Self-contained component, mountable as the "White-label" settings tab.
// Owner/admin-gated edits (server-enforced); other members see read-only.
//
// Three sections:
//   1. Logo — upload (magic-byte-validated, malware-screened server-side),
//      served publicly at /api/public/workspaces/[id]/logo for the review page.
//   2. Custom domain — format-validated only; DNS/SSL provisioning is out of
//      scope and labeled honestly.
//   3. Company color — LIVE PREVIEW re-tints the whole dashboard before
//      saving, via the SAME theming system as brand kits
//      (previewBrandTheme → the marketr:brand-preview event → the tenant-scoped
//      BrandTheme root). Saving writes the workspace field (public pages) AND
//      mirrors into the default brand kit's colors.primary (the theming source
//      of truth) — one color system, not two.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Globe, ImagePlus, Loader2, Palette, Trash2 } from "lucide-react";
import { previewBrandTheme, sanitizeBrandHex, DEFAULT_BRAND_PRIMARY } from "@/lib/brand-theme";
import { Check } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-lg bg-paper p-5 shadow-hairline";
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none disabled:opacity-40";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";

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

interface WhiteLabelState {
  logoUrl: string | null;
  customDomain: string | null;
  brandColor: string | null;
}

export default function WhiteLabelSettings({
  workspaceId,
  initial,
  canEdit,
}: {
  workspaceId: string;
  initial: WhiteLabelState;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl);
  const [domain, setDomain] = useState(initial.customDomain ?? "");
  const [savedDomain, setSavedDomain] = useState(initial.customDomain ?? "");
  const [color, setColor] = useState(initial.brandColor ?? "");
  const [savedColor, setSavedColor] = useState(initial.brandColor ?? "");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Live preview: every picker keystroke re-tints the dashboard through the
  // shared theming system. Unmount (leaving the tab) clears the preview and
  // reverts to the workspace's saved brand.
  const previewHex = sanitizeBrandHex(color);
  useEffect(() => {
    if (!canEdit) return;
    previewBrandTheme(previewHex);
    return () => previewBrandTheme(null);
  }, [canEdit, previewHex]);

  const cacheBust = useCallback(() => {
    setLogoUrl(
      logoUrl ? `${logoUrl.split("?")[0]}?t=${Date.now()}` : null,
    );
  }, [logoUrl]);

  async function uploadLogo(files: FileList | null) {
    if (!files || files.length === 0 || !canEdit || uploading) return;
    setUploading(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("logo", files[0]);
      const res = await fetch("/api/workspaces/white-label/logo", { method: "POST", body: form });
      const body = (await res.json().catch(() => null)) as { error?: string; logoUrl?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Upload failed.");
      setLogoUrl(`${body?.logoUrl ?? ""}?t=${Date.now()}`);
      setNotice({ kind: "ok", message: "Logo uploaded — public review pages show it now." });
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Upload failed." });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function removeLogo() {
    if (!canEdit || uploading) return;
    if (!await confirmAction("Remove the white-label logo? Public pages will show the default badge again.")) return;
    setUploading(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspaces/white-label/logo", { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove the logo.");
      setLogoUrl(null);
      setNotice({ kind: "ok", message: "Logo removed." });
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Could not remove the logo." });
    } finally {
      setUploading(false);
    }
  }

  async function saveDomain() {
    if (!canEdit || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspaces/white-label", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customDomain: domain.trim() === "" ? null : domain }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; whiteLabel?: WhiteLabelState } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not save the domain.");
      const next = body?.whiteLabel?.customDomain ?? "";
      setSavedDomain(next);
      setDomain(next);
      setNotice({
        kind: "ok",
        message: next
          ? "Custom domain saved. ShapesOS does not manage DNS — point the domain at your ShapesOS host before using it."
          : "Custom domain cleared.",
      });
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Could not save the domain." });
    } finally {
      setSaving(false);
    }
  }

  async function saveColor() {
    if (!canEdit || saving) return;
    const clean = sanitizeBrandHex(color);
    if (!clean) {
      setNotice({ kind: "error", message: "Enter a hex color like #1f6feb, or clear the color." });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspaces/white-label", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandColor: clean }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; whiteLabel?: WhiteLabelState } | null;
      if (!res.ok) throw new Error(body?.error ?? "Could not save the color.");
      setSavedColor(clean);
      setColor(clean);
      setNotice({ kind: "ok", message: "Brand color saved — the dashboard theme and public pages both use it now." });
      router.refresh();
      previewBrandTheme(null);
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Could not save the color." });
    } finally {
      setSaving(false);
    }
  }

  async function clearColor() {
    if (!canEdit || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/workspaces/white-label", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandColor: null }),
      });
      if (!res.ok) throw new Error("Could not clear the color.");
      setSavedColor("");
      setColor("");
      setNotice({
        kind: "info",
        message: "Brand color cleared — public pages fall back to the default black. The brand kit keeps its own saved color.",
      });
      router.refresh();
      previewBrandTheme(null);
    } catch (e) {
      setNotice({ kind: "error", message: e instanceof Error ? e.message : "Could not clear the color." });
    } finally {
      setSaving(false);
    }
  }

  const colorDirty = (sanitizeBrandHex(color) ?? "") !== (sanitizeBrandHex(savedColor) ?? "");
  const domainDirty = domain.trim().toLowerCase() !== savedDomain.trim().toLowerCase();
  const colorIsDefault = (sanitizeBrandHex(savedColor) ?? DEFAULT_BRAND_PRIMARY) === DEFAULT_BRAND_PRIMARY && !savedColor;

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Notice notice={notice} />
      {!canEdit && (
        <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
          You can view these settings, but only workspace owners and admins can change them.
        </p>
      )}

      {/* Logo */}
      <section className={cardCls}>
        <div className="flex items-center gap-2">
          <ImagePlus size={16} className="text-muted" />
          <h2 className="text-sm font-semibold text-ink">Workspace logo</h2>
        </div>
        <p className="mt-1 text-[13px] text-muted">
          Shown on public review pages instead of the default star badge.
        </p>
        <div className="mt-3 flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md bg-paper shadow-hairline">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Workspace logo" className="h-full w-full object-contain" onError={cacheBust} />
            ) : (
              <ImagePlus size={22} className="text-subtle" />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              disabled={!canEdit || uploading}
              onChange={(e) => void uploadLogo(e.target.files)}
            />
            {canEdit && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploading}
                  className={btnPrimary}
                >
                  {uploading && <Loader2 size={14} className="aos-spin" />}
                  {logoUrl ? "Replace logo" : "Upload logo"}
                </button>
                {logoUrl && (
                  <button
                    type="button"
                    onClick={() => void removeLogo()}
                    disabled={uploading}
                    className={btnDeny}
                  >
                    <Trash2 size={14} />
                    Remove
                  </button>
                )}
              </div>
            )}
            <p className="text-xs text-subtle">
              {logoUrl ? "PNG, JPG, GIF or WebP — max 2 MB." : "No logo uploaded — public review pages show the default star badge."}
            </p>
          </div>
        </div>
      </section>

      {/* Custom domain */}
      <section className={cardCls}>
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-muted" />
          <h2 className="text-sm font-semibold text-ink">Custom domain</h2>
        </div>
        <p className="mt-1 text-[13px] text-muted">
          Your client-facing domain for white-labeled public pages.
        </p>
        <div className="mt-3 flex max-w-md items-center gap-2">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            disabled={!canEdit}
            placeholder="reviews.acme.com"
            spellCheck={false}
            className={`${inputCls} w-full`}
          />
          {canEdit && (
            <button
              type="button"
              onClick={() => void saveDomain()}
              disabled={saving || !domainDirty}
              className={`${btnPrimary} shrink-0`}
            >
              {saving && <Loader2 size={14} className="aos-spin" />}
              Save
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-subtle">
          {savedDomain ? (
            <>Saved as <span className="font-medium text-muted">{savedDomain}</span>.</>
          ) : (
            <>No custom domain set.</>
          )}{" "}
          ShapesOS does not manage DNS or SSL for custom domains — point your domain&apos;s DNS at your ShapesOS host
          (CNAME/A record + certificate) before using it. Public links keep working on the ShapesOS URL either way.
        </p>
      </section>

      {/* Company color */}
      <section className={cardCls}>
        <div className="flex items-center gap-2">
          <Palette size={16} className="text-muted" />
          <h2 className="text-sm font-semibold text-ink">Company color</h2>
        </div>
        <p className="mt-1 text-[13px] text-muted">
          The primary accent for public pages — and the dashboard, live, as you pick.
        </p>
        <div className="mt-3 flex max-w-md items-center gap-3">
          <input
            type="color"
            value={previewHex ?? DEFAULT_BRAND_PRIMARY}
            onChange={(e) => setColor(e.target.value)}
            disabled={!canEdit}
            className="h-9 w-12 cursor-pointer rounded-md border border-line bg-paper p-1 disabled:cursor-not-allowed"
            aria-label="Pick a brand color"
          />
          <input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            disabled={!canEdit}
            placeholder={DEFAULT_BRAND_PRIMARY}
            spellCheck={false}
            className={`${inputCls} w-32 font-mono`}
          />
          {canEdit && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void saveColor()}
                disabled={saving || !colorDirty}
                className={btnPrimary}
              >
                {saving && <Loader2 size={14} className="aos-spin" />}
                Save
              </button>
              {savedColor && (
                <button
                  type="button"
                  onClick={() => void clearColor()}
                  disabled={saving}
                  className={btnGhost}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>
        {/* Live preview strip — built on the brand utilities, re-tints with the picker.
            The brand-* classes are intentional: this previews the tenant's saved
            brand color (user data), not a system accent. */}
        <div className="mt-4 rounded-md bg-canvas p-3">
          <p className="text-xs font-semibold text-muted">Live preview</p>
          <div className="mt-2 flex items-center gap-3">
            <span className="inline-flex h-control-sm items-center rounded-full bg-brand-600 px-4 text-[13px] font-semibold text-paper">
              Primary button
            </span>
            <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
              Accent chip
            </span>
            <span className="font-mono text-xs text-muted">
              {previewHex ?? DEFAULT_BRAND_PRIMARY}
              {colorIsDefault ? " (default)" : ""}
            </span>
          </div>
        </div>
        <p className="mt-2 text-xs text-subtle">
          {savedColor ? (
            <>Saved as <span className="font-mono font-medium text-muted">{savedColor}</span> — the dashboard theme follows the brand kit this saves into.</>
          ) : (
            <>No brand color set — the default black is used.</>
          )}{" "}
          Hover and tint shades derive automatically from this one color.
        </p>
      </section>
    </div>
  );
}
