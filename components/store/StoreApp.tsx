"use client";

// ShapesOS — Phase 18.2 (WS=content): the Store.
//
// Left: search, kind filters, All / Installed, and the catalogue as a dense
// list (name, kind, state, the highest tier it brings). Right: the open item
// — what it can do (every tool with its approval tier; "Always asks" where no
// rule can make it automatic), what it needs (scopes, keys, records, budget),
// and Install / Remove. Install shows those again and asks for a confirm
// before anything changes. Connectors and MCP servers link to Settings →
// Connectors (their credentials are entered there). Admins also see their
// agency's offers (accept / decline) and, in an agency, can offer items to
// client workspaces. Everything goes through /api/store (lib/store).
//
// Tiers are neutral badges: colour + shape mean agent state only (DESIGN.md).

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AppWindow, Blocks, Check, ExternalLink, Lock, Package, Plug, Search, Server, Sparkles, Target } from "lucide-react";
import type { WorkspaceRole } from "@prisma/client";
import { aosButton, FilterPill, NeutralBadge } from "@/components/aos";
import { Segmented } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import { filterCatalogue, maxTier, PUBLISHABLE_KINDS, STORE_KINDS, type StoreItem, type StoreKind } from "@/lib/store/catalogue";
import type { ClientWorkspace, PublicationOut, StoreCatalogue } from "@/lib/store/service";
import type { MessageKey } from "@/lib/i18n";

const KIND_ICON: Record<StoreKind, typeof Package> = {
  mini_app: AppWindow,
  skill: Sparkles,
  mission_template: Target,
  mcp_server: Server,
  composio_toolkit: Blocks,
  connector: Plug,
};

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export interface StoreAppProps {
  initial: StoreCatalogue;
  initialPublications: { incoming: PublicationOut[]; outgoing: PublicationOut[] };
  clients: ClientWorkspace[];
  role: WorkspaceRole;
  canInstallSkills: boolean;
  initialItem: string | null;
}

const itemId = (i: Pick<StoreItem, "kind" | "key">) => `${i.kind}:${i.key}`;

function setUrlItem(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("item", id);
  else url.searchParams.delete("item");
  window.history.replaceState(window.history.state, "", url.toString());
}

async function post<T>(url: string, body: unknown, method = "POST"): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "network" };
  }
}

export function StoreApp({ initial, initialPublications, clients, role, canInstallSkills, initialItem }: StoreAppProps) {
  const { t } = useI18n();
  const [catalogue, setCatalogue] = useState(initial);
  const [pubs, setPubs] = useState(initialPublications);
  const [kind, setKind] = useState<StoreKind | "all">("all");
  const [show, setShow] = useState<"all" | "installed">("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(initialItem);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/store", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as StoreCatalogue & { publications: typeof pubs };
      setCatalogue({ items: data.items, unavailable: data.unavailable });
      setPubs(data.publications);
    } catch {
      // keep what is shown
    }
  }, []);

  const rows = useMemo(() => filterCatalogue(catalogue.items, { kind, q, installedOnly: show === "installed" }), [catalogue.items, kind, q, show]);
  const counts = useMemo(() => {
    const base = filterCatalogue(catalogue.items, { q, installedOnly: show === "installed" });
    const c: Record<string, number> = { all: base.length };
    for (const k of STORE_KINDS) c[k] = base.filter((i) => i.kind === k).length;
    return c;
  }, [catalogue.items, q, show]);
  const current = catalogue.items.find((i) => itemId(i) === selected) ?? null;
  const pendingIncoming = pubs.incoming.filter((p) => p.status === "pending");
  const admin = (ROLE_RANK[role] ?? 0) >= 2;

  function open(i: StoreItem) {
    setSelected(itemId(i));
    setUrlItem(itemId(i));
  }

  function canChange(i: StoreItem): boolean {
    if (i.install.mode !== "inline") return false;
    if (i.install.permission === "skills.install") return canInstallSkills;
    return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[i.install.minRole] ?? 9);
  }

  function needsText(i: StoreItem): string {
    if (i.permissions.length === 0) return t("storeApp.noTools");
    return i.permissions
      .map((p) => `${t(`storeApp.permissionKinds.${p.kind}` as MessageKey)}${p.detail ? ` (${p.detail})` : ""}`)
      .join("; ");
  }

  async function install(i: StoreItem) {
    const top = maxTier(i);
    const toolCount = i.tools.length || (i.tierCounts ? i.tierCounts.tier0 + i.tierCounts.tier2 + i.tierCounts.tier3 + i.tierCounts.unclassified : 0);
    const ok = await confirmAction({
      title: t("storeApp.installConfirmTitle", { name: i.name }),
      description:
        top === null || toolCount === 0
          ? t("storeApp.installConfirmNoTools", { needs: needsText(i) })
          : t("storeApp.installConfirmBody", { tools: t("storeApp.toolsCount", { count: toolCount }), tier: top, needs: needsText(i) }),
      confirmLabel: t("storeApp.install"),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    setBusy(itemId(i));
    const res = await post("/api/store/items", { action: "install", kind: i.kind, key: i.key, confirmed: true });
    setBusy(null);
    if (!res.ok) {
      toastError(t("storeApp.failed"), res.error);
      return;
    }
    toast({ title: t("storeApp.installed", { name: i.name }), status: "done" });
    await refresh();
  }

  async function remove(i: StoreItem) {
    const ok = await confirmAction({ title: t("storeApp.removeConfirm", { name: i.name }), confirmLabel: t("storeApp.remove"), cancelLabel: t("common.cancel"), destructive: true });
    if (!ok) return;
    setBusy(itemId(i));
    const res = await post("/api/store/items", { action: "remove", kind: i.kind, key: i.key });
    setBusy(null);
    if (!res.ok) {
      toastError(t("storeApp.failed"), res.error);
      return;
    }
    toast({ title: t("storeApp.removed", { name: i.name }), status: "done" });
    await refresh();
  }

  async function decide(p: PublicationOut, decision: "accept" | "decline") {
    setBusy(p.id);
    const res = await post(`/api/store/publications/${encodeURIComponent(p.id)}`, { decision });
    setBusy(null);
    if (!res.ok) {
      toastError(t("storeApp.failed"), res.error);
      return;
    }
    toast({ title: t(decision === "accept" ? "storeApp.offers.accepted" : "storeApp.offers.declined", { title: p.title }), status: "done" });
    await refresh();
  }

  async function withdraw(p: PublicationOut) {
    setBusy(p.id);
    const res = await post(`/api/store/publications/${encodeURIComponent(p.id)}`, undefined, "DELETE");
    setBusy(null);
    if (!res.ok) toastError(t("storeApp.failed"), res.error);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("storeApp.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("storeApp.subtitle")}</p>
      </div>

      {admin && pendingIncoming.length > 0 ? (
        <section aria-labelledby="store-offers" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline">
          <div>
            <h2 id="store-offers" className="aos-subheading">
              {t("storeApp.offers.incomingTitle")}
            </h2>
            <p className="mt-1 text-sm text-muted">{t("storeApp.offers.incomingBody")}</p>
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {pendingIncoming.map((p) => {
              const Icon = KIND_ICON[p.kind];
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-md font-semibold text-ink">{p.title}</p>
                    <p className="text-xs text-muted">
                      {t(`storeApp.kindLabels.${p.kind}` as MessageKey)} · {t("storeApp.offers.from", { party: p.party })}
                    </p>
                  </div>
                  <button type="button" disabled={busy === p.id} onClick={() => void decide(p, "decline")} className={aosButton({ variant: "secondary", size: "xs" })}>
                    {t("storeApp.offers.decline")}
                  </button>
                  <button type="button" disabled={busy === p.id} onClick={() => void decide(p, "accept")} className={aosButton({ size: "xs" })}>
                    <Check className="size-3.5" aria-hidden />
                    {t("storeApp.offers.accept")}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <section aria-label={t("storeApp.listLabel")} className="flex min-w-0 flex-col gap-3 rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative block min-w-[12rem] flex-1">
              <span className="sr-only">{t("storeApp.searchLabel")}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("storeApp.searchPlaceholder")}
                className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
              />
            </label>
            <Segmented<"all" | "installed">
              value={show}
              onChange={setShow}
              label={t("storeApp.show")}
              options={[
                { value: "all", label: t("storeApp.showAll") },
                { value: "installed", label: t("storeApp.showInstalled") },
              ]}
            />
          </div>
          <div role="group" aria-label={t("storeApp.kindFilter")} className="flex flex-wrap gap-1.5">
            {(["all", ...STORE_KINDS] as const).map((k) => (
              <FilterPill key={k} selected={kind === k} onClick={() => setKind(k)} count={counts[k] ?? 0}>
                {t(`storeApp.kinds.${k}` as MessageKey)}
              </FilterPill>
            ))}
          </div>
          {catalogue.unavailable.map((u) => (
            <p key={u.kind} className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
              {t("storeApp.unavailable", { kind: t(`storeApp.kinds.${u.kind}` as MessageKey), reason: u.reason })}
            </p>
          ))}
          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-14 text-center">
              <Package className="size-6 text-subtle" aria-hidden />
              <p className="text-md font-semibold text-ink">{t("storeApp.empty")}</p>
              <p className="text-sm text-muted">{t("storeApp.emptyBody")}</p>
            </div>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {rows.map((i) => {
                const Icon = KIND_ICON[i.kind];
                const active = itemId(i) === selected;
                const top = maxTier(i);
                return (
                  <li key={itemId(i)}>
                    <button
                      type="button"
                      onClick={() => open(i)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-3 rounded-sm px-2.5 py-2 text-left ${active ? "bg-ink text-paper" : "hover:bg-hover-paper"}`}
                    >
                      <Icon className={`size-4 shrink-0 ${active ? "text-on-ink-muted" : "text-muted"}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-md font-semibold">{i.name}</span>
                        <span className={`block truncate text-xs ${active ? "text-on-ink-muted" : "text-muted"}`}>
                          {t(`storeApp.kindLabels.${i.kind}` as MessageKey)}
                          {i.category ? ` · ${i.category}` : ""}
                          {` · ${top === null ? t("storeApp.noTools") : t("storeApp.upToTier", { tier: top })}`}
                        </span>
                      </span>
                      <span className={`shrink-0 text-xs font-semibold ${active ? "text-paper" : i.installed ? "text-ink" : "text-muted"}`}>
                        {t(`storeApp.states.${i.state}` as MessageKey)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label={t("storeApp.detailLabel")} className="min-w-0 self-start rounded-lg bg-paper p-4 shadow-hairline sm:p-5 lg:sticky lg:top-4">
          {current ? (
            <ItemDetail
              item={current}
              busy={busy === itemId(current)}
              canChange={canChange(current)}
              clients={clients}
              onInstall={() => void install(current)}
              onRemove={() => void remove(current)}
              onPublished={() => void refresh()}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
              <Package className="size-7 text-subtle" aria-hidden />
              <h2 className="aos-subheading">{t("storeApp.pickTitle")}</h2>
              <p className="max-w-[40ch] text-md text-muted">{t("storeApp.pickBody")}</p>
            </div>
          )}
        </section>
      </div>

      {admin && pubs.outgoing.length > 0 ? (
        <section aria-labelledby="store-outgoing" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
          <h2 id="store-outgoing" className="aos-subheading">
            {t("storeApp.offers.outgoingTitle")}
          </h2>
          <ul className="flex flex-col divide-y divide-line">
            {pubs.outgoing.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-md font-semibold text-ink">{p.title}</p>
                  <p className="text-xs text-muted">{t("storeApp.offers.to", { party: p.party })}</p>
                </div>
                <NeutralBadge size="sm" label={t(`storeApp.offers.statuses.${p.status}` as MessageKey)} />
                {p.status === "pending" ? (
                  <button type="button" disabled={busy === p.id} onClick={() => void withdraw(p)} className={aosButton({ variant: "quiet", size: "xs" })}>
                    {t("storeApp.offers.withdraw")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ItemDetail({
  item,
  busy,
  canChange,
  clients,
  onInstall,
  onRemove,
  onPublished,
}: {
  item: StoreItem;
  busy: boolean;
  canChange: boolean;
  clients: ClientWorkspace[];
  onInstall: () => void;
  onRemove: () => void;
  onPublished: () => void;
}) {
  const { t } = useI18n();
  const Icon = KIND_ICON[item.kind];
  const minRole = item.install.mode === "inline" ? item.install.minRole : null;
  const publishable = clients.length > 0 && PUBLISHABLE_KINDS.includes(item.kind) && item.installed && item.source !== "agency";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-canvas">
          <Icon className="size-5 text-ink" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="aos-subheading break-words">{item.name}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {t(`storeApp.kindLabels.${item.kind}` as MessageKey)} · {t(`storeApp.sources.${item.source}` as MessageKey)}
            {item.version ? ` · ${t("storeApp.version", { version: item.version })}` : ""}
          </p>
        </div>
        <NeutralBadge size="sm" label={t(`storeApp.states.${item.state}` as MessageKey)} />
      </div>
      {item.description ? <p className="text-md text-ink">{item.description}</p> : null}
      {/* Phase 18.3 (WS=trust): agent app access for this connector's app. */}
      {item.agentAccess?.blocked ? (
        <p className="flex items-center gap-2 rounded-md bg-canvas px-3 py-2 text-sm text-ink" data-agent-blocked={item.agentAccess.group}>
          <Lock className="size-4 shrink-0" aria-hidden />
          <span>
            {t("trust.apps.blockedNote")} ·{" "}
            <Link href="/dashboard/settings/security-center/apps" className="font-semibold underline underline-offset-2">
              {t(`trust.apps.groups.${item.agentAccess.group}.label` as MessageKey)}
            </Link>
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {item.install.mode === "link" ? (
          <Link href={item.install.href} className={aosButton({ size: "sm" })}>
            <ExternalLink className="size-4" aria-hidden />
            {t("storeApp.manage")}
          </Link>
        ) : item.installed ? (
          item.removable ? (
            <button type="button" disabled={busy || !canChange} onClick={onRemove} className={aosButton({ variant: "deny", size: "sm" })}>
              {busy ? t("storeApp.removing") : t("storeApp.remove")}
            </button>
          ) : null
        ) : (
          <button type="button" disabled={busy || !canChange} onClick={onInstall} className={aosButton({ size: "sm" })}>
            {busy ? t("storeApp.installing") : t("storeApp.install")}
          </button>
        )}
        {item.install.mode === "inline" && !canChange && minRole ? <span className="text-xs text-muted">{t("storeApp.needsRole", { role: minRole })}</span> : null}
        {item.install.mode === "link" ? <span className="text-xs text-muted">{t("storeApp.needsLink")}</span> : null}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">{t("storeApp.tools")}</h3>
        {item.tierCounts ? (
          <p className="text-sm text-muted">{t("storeApp.toolCounts", { ...item.tierCounts })}</p>
        ) : item.tools.length === 0 ? (
          <p className="text-sm text-muted">{t("storeApp.noTools")}</p>
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">{t("storeApp.tools")}</caption>
              <tbody>
                {item.tools.map((tool, idx) => (
                  <tr key={`${tool.name}-${idx}`} className="border-b border-line last:border-b-0">
                    <td className="px-1 py-1.5 align-top">
                      <span className="block font-mono text-xs break-all text-ink">{tool.name}</span>
                      {tool.description ? <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{tool.description}</span> : null}
                      {tool.unresolved ? <span className="mt-0.5 block text-xs text-muted">{t("storeApp.unresolvedTool")}</span> : null}
                    </td>
                    <td className="px-1 py-1.5 text-right align-top whitespace-nowrap">
                      <span title={t(`storeApp.tierHelp.${tool.tier}` as MessageKey)}>
                        <NeutralBadge size="sm" label={t("storeApp.tier", { tier: tool.tier })} />
                      </span>
                      {tool.alwaysAsks ? <span className="mt-1 block text-xs font-semibold text-ink">{t("storeApp.alwaysAsks")}</span> : null}
                      <span className="sr-only">{t(`storeApp.tierHelp.${tool.tier}` as MessageKey)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {item.permissions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">{t("storeApp.permissions")}</h3>
          <ul className="flex flex-col gap-1.5">
            {item.permissions.map((p, idx) => (
              <li key={`${p.kind}-${idx}`} className="text-sm text-ink">
                {t(`storeApp.permissionKinds.${p.kind}` as MessageKey)}
                {p.detail ? <span className="mt-0.5 block font-mono text-xs break-all text-muted">{p.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {publishable ? <PublishPanel item={item} clients={clients} onPublished={onPublished} /> : null}
    </div>
  );
}

function PublishPanel({ item, clients, onPublished }: { item: StoreItem; clients: ClientWorkspace[]; onPublished: () => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const res = await post<{ published: string[] }>("/api/store/publish", { kind: item.kind, key: item.key, clientWorkspaceIds: [...picked] });
    setBusy(false);
    if (!res.ok) {
      toastError(t("storeApp.failed"), res.error);
      return;
    }
    toast({ title: t("storeApp.publish.done", { count: res.data.published.length }), status: "done" });
    setPicked(new Set());
    onPublished();
  }
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-semibold text-ink">{t("storeApp.publish.title")}</legend>
      <p className="text-xs text-muted">{t("storeApp.publish.body")}</p>
      <div role="group" aria-label={t("storeApp.publish.clientsLabel")} className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {clients.map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={picked.has(c.id)}
              onChange={(e) => {
                const n = new Set(picked);
                if (e.target.checked) n.add(c.id);
                else n.delete(c.id);
                setPicked(n);
              }}
              className="size-4 accent-[var(--aos-ink)]"
            />
            {c.name}
          </label>
        ))}
      </div>
      <div>
        <button type="button" disabled={busy || picked.size === 0} onClick={() => void submit()} className={aosButton({ size: "xs" })}>
          {t("storeApp.publish.submit")}
        </button>
      </div>
    </fieldset>
  );
}

export default StoreApp;
