// ShapesOS — Social composer + post detail (Phase 4b).
// Text, channels, media (images/video, validated per platform as you go),
// link + campaign (UTM-tagged automatically), timing, and a per-platform
// preview of exactly what each channel will receive. Drafts save; publishing
// is "Submit for approval" → the unified approval inbox. Pending posts show
// Approve / Deny here for editors (the server enforces separation of duties).
"use client";

import { useMemo, useRef, useState } from "react";
import { CalendarClock, ImagePlus, Link2, Loader2, Send, Trash2, Upload, X } from "lucide-react";
import { buildChannelBody } from "@/lib/social/utm";
import { countChars, platformLabel, rulesFor, validatePost } from "@/lib/social/platforms";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { closeOnEscape } from "@/lib/ui/keyboard";
import {
  api,
  btnApprove,
  btnDeny,
  btnPrimary,
  btnQuiet,
  btnSecondary,
  fmtBytes,
  fmtDateTime,
  fmtInt,
  inputCls,
  isPast,
  mediaUrl,
  StatusChip,
  Tag,
  textareaCls,
  Thumb,
  type Channel,
  type Media,
  type Post,
  type ProviderMode,
} from "./ui";

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function Composer({
  post,
  channels,
  mode,
  maxUploadBytes,
  canEdit,
  onClose,
  onSaved,
}: {
  post: Post | null;
  channels: Channel[];
  mode: ProviderMode;
  maxUploadBytes: number;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (p: Post | null) => void;
}) {
  const editable = canEdit && (!post || post.status === "draft" || post.status === "failed");
  const [content, setContent] = useState(post?.content ?? "");
  const [picked, setPicked] = useState<Channel[]>(post?.channels ?? []);
  const [media, setMedia] = useState<Media[]>(post?.media ?? []);
  const [link, setLink] = useState(post?.link ?? "");
  const [campaign, setCampaign] = useState(post?.utmCampaign ?? "");
  const [publishMode, setPublishMode] = useState<"now" | "schedule">(post?.publishMode ?? "now");
  const [when, setWhen] = useState(toLocalInput(post?.scheduledFor ?? null));
  const [busy, setBusy] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Channels the provider no longer lists still show (so a draft keeps them).
  const allChannels = useMemo(() => {
    const byId = new Map(channels.map((c) => [c.id, c]));
    for (const c of picked) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
  }, [channels, picked]);

  const pickedIds = new Set(picked.map((c) => c.id));
  const toggle = (c: Channel) =>
    setPicked((prev) => (prev.some((p) => p.id === c.id) ? prev.filter((p) => p.id !== c.id) : [...prev, { id: c.id, identifier: c.identifier, name: c.name }]));

  const postId = post?.id ?? "preview";
  const bodies = picked.map((c) => ({
    channel: c,
    body: buildChannelBody({ content, link, platform: c.identifier, campaign: campaign || null, postId }),
  }));
  const issues = bodies.flatMap(({ channel, body }) => validatePost([channel.identifier], body, media));
  const uniqueIssues = [...new Set(issues.map((i) => i.message))];
  const timingIssue =
    publishMode === "schedule" && (!when || isPast(when)) ? "Pick a future time to schedule the post." : null;
  const empty = !content.trim() && media.length === 0;
  const canSubmit = editable && !empty && picked.length > 0 && uniqueIssues.length === 0 && !timingIssue && mode !== "none";

  const payload = () => ({
    content,
    link: link.trim() || null,
    utmCampaign: campaign.trim() || null,
    channels: picked,
    media,
    publishMode,
    scheduledFor: publishMode === "schedule" && when ? new Date(when).toISOString() : null,
  });

  const save = async (): Promise<Post | null> => {
    const res = post
      ? await api<{ post: Post }>(`/api/social/posts/${encodeURIComponent(post.id)}`, { method: "PATCH", body: JSON.stringify(payload()) })
      : await api<{ post: Post }>("/api/social/posts", { method: "POST", body: JSON.stringify(payload()) });
    return res.post;
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = () =>
    run("save", async () => {
      const saved = await save();
      toast({ title: "Draft saved" });
      onSaved(saved);
    });

  const submit = () =>
    run("submit", async () => {
      const saved = await save();
      if (!saved) return;
      const res = await api<{ post: Post }>(`/api/social/posts/${encodeURIComponent(saved.id)}/submit`, { method: "POST" });
      toast({ title: "Submitted for approval", description: "Approvers were notified.", status: "needs" });
      onSaved(res.post);
    });

  const decide = (decision: "approve" | "deny") =>
    run(decision, async () => {
      if (!post) return;
      if (decision === "approve") {
        const ok = await confirmAction({
          title: post.publishMode === "schedule" ? "Approve and schedule this post?" : "Approve and publish this post?",
          description:
            post.publishMode === "schedule"
              ? `It goes out to ${post.channels.length} channel${post.channels.length === 1 ? "" : "s"} at ${fmtDateTime(post.scheduledFor)}.`
              : `It goes out to ${post.channels.length} channel${post.channels.length === 1 ? "" : "s"} now. This posts publicly.`,
          confirmLabel: post.publishMode === "schedule" ? "Approve and schedule" : "Approve and publish",
        });
        if (!ok) return;
      }
      const res = await api<{ post: Post }>(`/api/social/posts/${encodeURIComponent(post.id)}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      if (decision === "deny") toast({ title: "Sent back to draft", status: "done" });
      else if (res.post.status === "failed") toast({ title: "Approved, but publishing failed", description: res.post.error ?? undefined, status: "failed" });
      else toast({ title: res.post.status === "published" ? "Approved and published" : "Approved and scheduled" });
      onSaved(res.post);
    });

  const remove = () =>
    run("delete", async () => {
      if (!post) return;
      const cancelling = post.status === "pending_approval" || post.status === "approved" || post.status === "scheduled";
      const ok = await confirmAction({
        title: cancelling ? "Cancel this post?" : "Delete this post?",
        description: cancelling ? "It won't be published." : "The draft is removed. Uploaded media stays in Files.",
        confirmLabel: cancelling ? "Cancel post" : "Delete",
        destructive: true,
      });
      if (!ok) return;
      await api(`/api/social/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" });
      toast({ title: cancelling ? "Post cancelled" : "Post deleted" });
      onSaved(null);
    });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const f of Array.from(files)) {
      if (f.size > maxUploadBytes) {
        toastError(`${f.name} is ${fmtBytes(f.size)}; files can be up to ${fmtBytes(maxUploadBytes)}.`);
        continue;
      }
      await run(`upload:${f.name}`, async () => {
        const form = new FormData();
        form.append("file", f);
        const res = await api<{ media: Media }>("/api/social/media", { method: "POST", body: form });
        setMedia((prev) => [...prev, res.media]);
      });
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const previewChannel = picked.find((c) => c.id === previewId) ?? picked[0] ?? null;
  const previewBody = previewChannel ? bodies.find((b) => b.channel.id === previewChannel.id)?.body ?? "" : content;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-night/40 p-4 pt-[6vh]"
      role="presentation"
      onClick={onClose}
      onKeyDown={closeOnEscape(onClose)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="social-composer-title"
        className="w-full max-w-5xl rounded-lg bg-paper shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 id="social-composer-title" className="text-lg font-heading stretch-heading tracking-heading text-ink">
              {post ? (editable ? "Edit post" : "Post") : "New post"}
            </h2>
            {post ? <StatusChip status={post.status} scheduledFor={post.scheduledFor} /> : null}
            {post?.source === "studio" ? <Tag>From Studio</Tag> : null}
          </div>
          <button type="button" onClick={onClose} className={btnQuiet} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {post?.decisionNote && post.status === "draft" ? (
          <p className="mx-5 mt-4 rounded-md bg-needs-tint px-3 py-2 text-[0.8125rem] text-ink">Reviewer note: {post.decisionNote}</p>
        ) : null}
        {post?.error ? (
          <p className="mx-5 mt-4 flex items-start gap-2 rounded-md bg-failed-tint px-3 py-2 text-[0.8125rem] text-failed-text">
            <span className="aos-shape aos-shape--failed mt-1" aria-hidden /> {post.error}
          </p>
        ) : null}

        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* Left: fields */}
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <label htmlFor="social-text" className="mb-1 block text-[0.8125rem] font-semibold text-ink">Post text</label>
              <textarea
                id="social-text"
                className={`${textareaCls} min-h-[140px]`}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="What should the post say?"
                maxLength={10_000}
                disabled={!editable}
              />
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[0.75rem] text-muted">
                {bodies.length === 0 ? <span>{[...content].length} characters</span> : null}
                {bodies.map(({ channel, body }) => {
                  const r = rulesFor(channel.identifier);
                  const n = countChars(body, r.urlChars);
                  return (
                    <span key={channel.id} className={n > r.maxChars ? "font-semibold text-failed-text" : undefined}>
                      {platformLabel(channel.identifier)} {fmtInt(n)}/{fmtInt(r.maxChars)}
                    </span>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[0.8125rem] font-semibold text-ink">Media</span>
                <span className="text-[0.75rem] text-muted">Images or video, up to {fmtBytes(maxUploadBytes)} each</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {media.map((m) => (
                  <div key={m.fileId} className="relative">
                    <Thumb media={m} size={88} />
                    <span className="sr-only">{m.filename}</span>
                    {editable ? (
                      <button
                        type="button"
                        className="absolute -right-1.5 -top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-ink text-paper aos-press"
                        aria-label={`Remove ${m.filename}`}
                        onClick={() => setMedia((prev) => prev.filter((x) => x.fileId !== m.fileId))}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                ))}
                {editable ? (
                  <button
                    type="button"
                    className="flex h-[88px] w-[88px] flex-col items-center justify-center gap-1 rounded-md border-[1.5px] border-dashed border-control text-[0.75rem] font-semibold text-muted hover:bg-hover-paper"
                    onClick={() => fileRef.current?.click()}
                    disabled={!!busy?.startsWith("upload:")}
                  >
                    {busy?.startsWith("upload:") ? <Loader2 className="h-5 w-5 aos-spin" /> : <Upload className="h-5 w-5" />}
                    {busy?.startsWith("upload:") ? "Uploading" : "Add media"}
                  </button>
                ) : null}
                <input
                  ref={fileRef}
                  type="file"
                  className="sr-only"
                  accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm"
                  multiple
                  onChange={(e) => void upload(e.target.files)}
                  tabIndex={-1}
                />
              </div>
            </div>

            <div>
              <span className="mb-1 block text-[0.8125rem] font-semibold text-ink">Channels ({picked.length} selected)</span>
              {allChannels.length === 0 ? (
                <p className="rounded-md bg-canvas px-3 py-2 text-[0.8125rem] text-muted">
                  {mode === "none"
                    ? "Connect Postiz to pick channels."
                    : mode === "zernio"
                      ? "No channels connected yet. Connect them in Settings → Connectors → Zernio."
                      : "No channels connected yet. Connect them in Postiz."}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {allChannels.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={pickedIds.has(c.id)}
                      disabled={!editable}
                      onClick={() => toggle(c)}
                      className={`inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-[0.8125rem] font-semibold aos-press ${
                        pickedIds.has(c.id) ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline"
                      }`}
                    >
                      {platformLabel(c.identifier)}
                      <span className={pickedIds.has(c.id) ? "text-paper/80" : "text-muted"}>{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="social-link" className="mb-1 flex items-center gap-1 text-[0.8125rem] font-semibold text-ink">
                  <Link2 className="h-3.5 w-3.5" /> Link
                </label>
                <input id="social-link" className={inputCls} value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" disabled={!editable} />
              </div>
              <div>
                <label htmlFor="social-campaign" className="mb-1 block text-[0.8125rem] font-semibold text-ink">Campaign</label>
                <input
                  id="social-campaign"
                  className={inputCls}
                  value={campaign}
                  onChange={(e) => setCampaign(e.target.value)}
                  placeholder="Defaults to social-<date>"
                  disabled={!editable}
                />
              </div>
              <p className="text-[0.75rem] text-muted sm:col-span-2">
                Links in the post get utm_source (the platform), utm_medium=social, utm_campaign and utm_content (this post), so
                leads from them show up under Social in Attribution.
              </p>
            </div>

            <div>
              <span className="mb-1 block text-[0.8125rem] font-semibold text-ink">When</span>
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex rounded-full bg-control p-1" role="group" aria-label="Publish timing">
                  {(["now", "schedule"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={publishMode === m}
                      disabled={!editable}
                      onClick={() => setPublishMode(m)}
                      className={`inline-flex h-8 items-center gap-1 rounded-full px-3 text-[0.8125rem] font-semibold ${publishMode === m ? "bg-ink text-paper" : "text-ink"}`}
                    >
                      {m === "now" ? <Send className="h-3.5 w-3.5" /> : <CalendarClock className="h-3.5 w-3.5" />}
                      {m === "now" ? "On approval" : "Schedule"}
                    </button>
                  ))}
                </div>
                {publishMode === "schedule" ? (
                  <input
                    type="datetime-local"
                    aria-label="Scheduled time"
                    className={`${inputCls} !w-auto`}
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                    disabled={!editable}
                  />
                ) : null}
              </div>
            </div>

            {editable && (uniqueIssues.length > 0 || timingIssue) ? (
              <ul className="flex flex-col gap-1 rounded-md bg-failed-tint px-3 py-2 text-[0.8125rem] text-failed-text" aria-live="polite">
                {[...uniqueIssues, ...(timingIssue ? [timingIssue] : [])].map((m) => (
                  <li key={m} className="flex items-start gap-2">
                    <span className="aos-shape aos-shape--failed mt-1" aria-hidden />
                    {m}
                  </li>
                ))}
              </ul>
            ) : null}

            {post?.metrics ? (
              <div className="rounded-md bg-canvas px-3 py-2 text-[0.8125rem] text-ink">
                <span className="font-semibold">Engagement{post.metrics.mock ? " (sample data)" : ""}: </span>
                {fmtInt(post.metrics.impressions)} impressions · {fmtInt(post.metrics.likes)} likes · {fmtInt(post.metrics.comments)} comments ·{" "}
                {fmtInt(post.metrics.shares)} shares · {fmtInt(post.metrics.clicks)} clicks
              </div>
            ) : null}
          </div>

          {/* Right: preview */}
          <aside className="flex min-w-0 flex-col gap-2" aria-label="Preview">
            <div className="flex items-center justify-between">
              <span className="text-[0.8125rem] font-semibold text-ink">Preview</span>
              {picked.length > 1 ? (
                <select
                  aria-label="Preview channel"
                  className={`${inputCls} !h-8 !w-auto`}
                  value={previewChannel?.id ?? ""}
                  onChange={(e) => setPreviewId(e.target.value)}
                >
                  {picked.map((c) => (
                    <option key={c.id} value={c.id}>
                      {platformLabel(c.identifier)} · {c.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="rounded-lg bg-paper p-3 shadow-hairline">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-ink text-[0.8125rem] font-bold text-paper">
                  {(previewChannel ? platformLabel(previewChannel.identifier) : "S").charAt(0)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[0.8125rem] font-semibold text-ink">{previewChannel?.name ?? "Pick a channel"}</div>
                  <div className="text-[0.75rem] text-muted">{previewChannel ? platformLabel(previewChannel.identifier) : "—"}</div>
                </div>
              </div>
              <p className="whitespace-pre-wrap break-words text-[0.8125rem] text-ink">{previewBody || <span className="text-subtle">Post text appears here.</span>}</p>
              {media.length > 0 ? (
                <div className={`mt-2 grid gap-1 ${media.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                  {media.slice(0, 4).map((m) =>
                    m.kind === "video" ? (
                      <video key={m.fileId} src={mediaUrl(m.fileId)} controls preload="metadata" className="w-full rounded-sm bg-canvas" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={m.fileId} src={mediaUrl(m.fileId)} alt={m.filename} className="w-full rounded-sm bg-canvas object-cover" />
                    ),
                  )}
                </div>
              ) : null}
            </div>
            {mode === "mock" ? (
              <p className="text-[0.75rem] text-muted">Sample mode: no Postiz credentials, so publishing is simulated.</p>
            ) : null}
          </aside>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
          <div>
            {post && canEdit && post.status !== "published" ? (
              <button type="button" className={btnDeny} onClick={() => void remove()} disabled={!!busy}>
                <Trash2 className="h-4 w-4" />
                {post.status === "pending_approval" || post.status === "approved" || post.status === "scheduled" ? "Cancel post" : "Delete"}
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} onClick={onClose}>
              Close
            </button>
            {editable ? (
              <>
                <button type="button" className={btnSecondary} onClick={() => void saveDraft()} disabled={!!busy || empty}>
                  {busy === "save" ? <Loader2 className="h-4 w-4 aos-spin" /> : <ImagePlus className="h-4 w-4" />}
                  {busy === "save" ? "Saving" : "Save draft"}
                </button>
                <button type="button" className={btnPrimary} onClick={() => void submit()} disabled={!!busy || !canSubmit}>
                  {busy === "submit" ? <Loader2 className="h-4 w-4 aos-spin" /> : <Send className="h-4 w-4" />}
                  {busy === "submit" ? "Submitting" : "Submit for approval"}
                </button>
              </>
            ) : null}
            {post?.status === "pending_approval" && canEdit ? (
              <>
                <button type="button" className={btnDeny} onClick={() => void decide("deny")} disabled={!!busy}>
                  {busy === "deny" ? "Sending back" : "Send back"}
                </button>
                <button type="button" className={btnApprove} onClick={() => void decide("approve")} disabled={!!busy}>
                  {busy === "approve" ? <Loader2 className="h-4 w-4 aos-spin" /> : null}
                  {busy === "approve" ? "Approving" : post.publishMode === "schedule" ? "Approve and schedule" : "Approve and publish"}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
