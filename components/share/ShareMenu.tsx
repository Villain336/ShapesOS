"use client";

// ShapesOS — Phase 18.3 (WS=flow): the share sheet. "Share" on a record or a
// file opens one menu: Send to (the apps that receive a record, each agent,
// a file share link, copy link, this device's share sheet) and Open with
// (the apps that open the record's kind). Targets come from
// lib/share/registry.ts (generated from the nav and agent registries). Every
// send uses the target's EXISTING route with its own checks and tiers:
// a mail is a prefilled compose (sending follows the Mail app's rules), a
// note / reminder goes through POST /api/notes / /api/comms/reminders (and
// is queued while offline), a channel post through the Messages route, an
// agent gets a task with the record attached (its tools keep their tiers).

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import {
  ArrowLeft,
  ArrowUpRight,
  Copy,
  Hash,
  Link2,
  Share,
  Share2,
} from "lucide-react";
import {
  aosButton,
  MenuLabel,
  MenuRow,
  MenuSeparator,
  AgentAvatar,
} from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { useOptionalChat } from "@/components/chat/ChatContext";
import { pickTaskProject } from "@/components/command-bar/lib";
import { toast, toastError } from "@/lib/ui/feedback";
import {
  absoluteLink,
  openWith,
  recordMessage,
  shareTargets,
  type ShareRecord,
  type ShareRole,
  type ShareTarget,
} from "@/lib/share/registry";
import { sendSafeWrite } from "@/lib/offline/client";
import { SUB_AGENTS, type SubAgentKey } from "@/lib/aos/agents";
import type { MessageKey } from "@/lib/i18n";

export interface ShareMenuProps {
  record: ShareRecord;
  role: ShareRole | null;
  /** Needed for a file share link (POST /api/files/[id]/shares). */
  workspaceId?: string | null;
  size?: "xs" | "sm";
  className?: string;
}

type Channel = { id: string; name: string; kind?: string };

function tomorrowNineIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00:00${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/** Fired on window to open the share sheet for a record from anywhere (⌘K "Share…"). */
export const SHARE_SHEET_EVENT = "shapes:share";

export function openShareSheet(record: ShareRecord): void {
  window.dispatchEvent(
    new CustomEvent<ShareRecord>(SHARE_SHEET_EVENT, { detail: record }),
  );
}

/** The share button + popover on a record or file. */
export function ShareMenu({
  record,
  role,
  workspaceId,
  size = "xs",
  className,
}: ShareMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={aosButton({ variant: "secondary", size, className })}
        aria-label={t("flow.share.buttonLabel", { title: record.title })}
      >
        <Share2 className="size-3.5" aria-hidden />
        {t("flow.share.button")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-50">
          <Popover.Popup className="max-h-[min(34rem,80vh)] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto rounded-lg bg-paper p-1.5 shadow-raised">
            <Popover.Title className="sr-only">
              {t("flow.share.title", { title: record.title })}
            </Popover.Title>
            {open ? (
              <ShareMenuContent
                record={record}
                role={role}
                workspaceId={workspaceId}
                onDone={() => setOpen(false)}
              />
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The share sheet's rows (used by the popover and by the ⌘K dialog host). */
export function ShareMenuContent({
  record,
  role,
  workspaceId,
  onDone,
}: {
  record: ShareRecord;
  role: ShareRole | null;
  workspaceId?: string | null;
  onDone: () => void;
}) {
  const { t, nav } = useI18n();
  const router = useRouter();
  const chat = useOptionalChat();
  const [step, setStep] = useState<"main" | "channels">("main");
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  const targets = useMemo(
    () => shareTargets(record, { role, canNativeShare }),
    [record, role, canNativeShare],
  );
  const opens = useMemo(() => openWith(record, role), [record, role]);
  const link =
    typeof window !== "undefined"
      ? absoluteLink(window.location.origin, record.href)
      : record.href;
  const navLabel = useCallback(
    (href: string, fallback: string) =>
      nav(href, { label: fallback, description: "" }).label,
    [nav],
  );

  function close() {
    setStep("main");
    onDone();
  }

  async function handToAgent(agentKey: string, lead: string) {
    if (!chat) {
      toastError(t("flow.share.failed"), t("flow.share.noAssistant"));
      return;
    }
    let projects: Array<{ id: string; createdAt: string }> = [];
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (res.ok)
        projects = (
          (
            (await res.json()) as {
              projects?: Array<{ id: string; createdAt: string }>;
            }
          ).projects ?? []
        ).map((p) => ({ id: p.id, createdAt: String(p.createdAt) }));
    } catch {
      // falls through
    }
    const project = pickTaskProject(projects, chat.session?.projectId ?? null);
    if (!project) {
      toastError(t("flow.share.failed"), t("flow.share.needsProject"));
      return;
    }
    chat.queueTask({
      projectId: project.id,
      content: recordMessage(lead, record),
      attachmentIds: [],
      agentKey,
    });
    chat.setTab("ai");
    close();
    router.push(
      `/dashboard/assistant?project=${encodeURIComponent(project.id)}`,
    );
  }

  async function send(target: ShareTarget) {
    if (target.unavailable) return;
    setBusy(true);
    try {
      switch (target.id) {
        case "assistant":
          await handToAgent(
            "lead",
            t("flow.share.askLeadPrompt", { title: record.title }),
          );
          break;
        case "mail": {
          close();
          const q = new URLSearchParams({
            compose: "1",
            subject: record.title.slice(0, 200),
            body: `${record.title}\n${link}`,
          });
          router.push(`/dashboard/mail?${q.toString()}`);
          break;
        }
        case "messages": {
          setStep("channels");
          if (!channels) {
            const res = await fetch("/api/comms/messages/channels", {
              cache: "no-store",
            }).catch(() => null);
            const j = (await res?.json().catch(() => null)) as {
              channels?: Channel[];
            } | null;
            setChannels(res?.ok && j?.channels ? j.channels : []);
          }
          break;
        }
        case "notes": {
          const out = await sendSafeWrite("note_create", {
            title: t("flow.share.noteTitle", {
              title: record.title.slice(0, 150),
            }),
            body: `${record.title}\n${link}`,
            links: [
              {
                kind: record.kind,
                id: record.id,
                label: record.title.slice(0, 200),
              },
            ],
          });
          if (out.status === "error") throw new Error(out.error);
          close();
          if (out.status === "queued")
            toast({ title: t("flow.offline.queuedNote") });
          else {
            const note = (out.data.note ?? {}) as { id?: string };
            toast({
              title: t("flow.share.sentNote"),
              status: "done",
              action: note.id
                ? {
                    label: t("common.open"),
                    onClick: () =>
                      router.push(
                        `/dashboard/notes?note=${encodeURIComponent(note.id!)}`,
                      ),
                  }
                : undefined,
            });
          }
          break;
        }
        case "reminders": {
          const out = await sendSafeWrite("reminder_create", {
            title: t("flow.share.reminderTitle", {
              title: record.title.slice(0, 200),
            }),
            notes: link,
            dueAt: tomorrowNineIso(),
          });
          if (out.status === "error") throw new Error(out.error);
          close();
          toast({
            title:
              out.status === "queued"
                ? t("flow.offline.queuedReminder")
                : t("flow.share.sentReminder"),
            status: out.status === "queued" ? undefined : "done",
          });
          break;
        }
        case "file_link": {
          if (!workspaceId) throw new Error(t("flow.share.noWorkspace"));
          const res = await fetch(
            `/api/files/${encodeURIComponent(record.id)}/shares`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                workspaceId,
                access: "view",
                expiresInDays: 7,
              }),
            },
          );
          const j = (await res.json().catch(() => ({}))) as {
            path?: string;
            error?: string;
          };
          if (!res.ok || !j.path)
            throw new Error(j.error ?? `HTTP ${res.status}`);
          await navigator.clipboard
            ?.writeText(absoluteLink(window.location.origin, j.path))
            .catch(() => undefined);
          close();
          toast({ title: t("flow.share.linkCreated"), status: "done" });
          break;
        }
        case "copy_link":
          await navigator.clipboard?.writeText(link);
          close();
          toast({ title: t("flow.share.copied"), status: "done" });
          break;
        case "device":
          close();
          await navigator
            .share({ title: record.title, url: link })
            .catch(() => undefined);
          break;
        default:
          if (target.agentKey) {
            const name =
              SUB_AGENTS[target.agentKey as SubAgentKey]?.name ??
              target.agentKey;
            await handToAgent(
              target.agentKey,
              t("flow.share.askAgentPrompt", {
                agent: name,
                title: record.title,
              }),
            );
          }
      }
    } catch (err) {
      toastError(
        t("flow.share.failed"),
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }

  async function postTo(channel: Channel) {
    setBusy(true);
    const res = await fetch(
      `/api/comms/messages/channels/${encodeURIComponent(channel.id)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: `${record.title}\n${link}` }),
      },
    ).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const j = (await res?.json().catch(() => null)) as {
        error?: string;
      } | null;
      toastError(t("flow.share.failed"), j?.error);
      return;
    }
    close();
    toast({
      title: t("flow.share.posted", { channel: channel.name }),
      status: "done",
    });
  }

  const apps = targets.filter((x) => x.group === "apps");
  const agents = targets.filter((x) => x.group === "agents");
  const links = targets.filter((x) => x.group === "links");
  const linkIcon = {
    file_link: Link2,
    copy_link: Copy,
    device: Share,
  } as const;

  return (
    <>
      {step === "channels" ? (
        <div>
          <MenuRow
            icon={ArrowLeft}
            label={t("flow.share.back")}
            onClick={() => setStep("main")}
          />
          <MenuSeparator />
          <MenuLabel>{t("flow.share.pickChannel")}</MenuLabel>
          {channels === null ? (
            <p className="px-3 py-2 text-sm text-muted">
              {t("common.loading")}
            </p>
          ) : null}
          {channels?.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted">
              {t("flow.share.noChannels")}
            </p>
          ) : null}
          {channels?.map((c) => (
            <MenuRow
              key={c.id}
              icon={Hash}
              label={c.name}
              onClick={() => void postTo(c)}
            />
          ))}
        </div>
      ) : (
        <div aria-busy={busy || undefined}>
          <MenuLabel>{t("flow.share.sendTo")}</MenuLabel>
          {apps.map((x) => (
            <MenuRow
              key={x.id}
              icon={x.app!.icon}
              label={navLabel(x.app!.href, x.app!.label)}
              hint={
                x.unavailable
                  ? t(`flow.share.unavailable.${x.unavailable}` as MessageKey)
                  : undefined
              }
              onClick={() => void send(x)}
              className={x.unavailable ? "opacity-60" : undefined}
            />
          ))}
          <MenuSeparator />
          <MenuLabel>{t("flow.share.agents")}</MenuLabel>
          {agents.map((x) => {
            const name =
              SUB_AGENTS[x.agentKey as SubAgentKey]?.name ?? String(x.agentKey);
            return (
              <MenuRow
                key={x.id}
                leading={<AgentAvatar name={name} size="sm" />}
                label={t("flow.share.askAgent", { agent: name })}
                onClick={() => void send(x)}
              />
            );
          })}
          <MenuSeparator />
          {links.map((x) => (
            <MenuRow
              key={x.id}
              icon={linkIcon[x.id as keyof typeof linkIcon]}
              label={t(`flow.share.targets.${x.id}` as MessageKey)}
              hint={
                x.unavailable
                  ? t(`flow.share.unavailable.${x.unavailable}` as MessageKey)
                  : undefined
              }
              onClick={() => void send(x)}
              className={x.unavailable ? "opacity-60" : undefined}
            />
          ))}
          {opens.length > 1 ? (
            <>
              <MenuSeparator />
              <MenuLabel>{t("flow.share.openWith")}</MenuLabel>
              {opens.slice(1).map((o) => (
                <MenuRow
                  key={o.href}
                  icon={o.app?.icon ?? ArrowUpRight}
                  label={
                    o.app ? navLabel(o.app.href, o.app.label) : record.title
                  }
                  onClick={() => {
                    close();
                    router.push(o.href);
                  }}
                />
              ))}
            </>
          ) : null}
        </div>
      )}
    </>
  );
}

export default ShareMenu;
