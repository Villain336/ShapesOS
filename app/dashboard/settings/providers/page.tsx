// Marketr — provider status settings page (milestone 21, part D1).
// Admin+ only (server-gated), read-only. Honest about what is configured via
// environment: statuses are live, key material is never displayed.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { providerStatus } from "@/lib/providers";
import { llmStatus } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import { CONTEXTDEV_CONNECTOR_KEY } from "@/lib/knowledge/contextdev/keys";
import { mockInventory, notLive, type FeatureMode } from "@/lib/providers/mock-inventory";
import { unsplashStatus } from "@/lib/design/unsplash";
/* PROVIDER:pexels */ import { pexelsStatus } from "@/lib/design/pexels"; /* END */
/* PROVIDER:pixabay */ import { pixabayStatus } from "@/lib/design/pixabay"; /* END */
/* PROVIDER:cloudinary */ import { cloudinaryStatus } from "@/lib/design/cloudinary"; /* END */
/* PROVIDER:brandfetch */ import { brandfetchStatus } from "@/lib/design/brandfetch"; /* END */
import SettingsNav from "@/components/settings/SettingsNav";
import { isPlatformOperator } from "@/lib/auth/platform-operator";
/* INTEGRATION:activepieces */ import ActivepiecesFlowBindings from "@/components/settings/ActivepiecesFlowBindings"; /* END */
// Phase 12 (embeds): integration status helpers.
import { umamiStatus } from "@/lib/integrations/umami";
import { chatwootStatus } from "@/lib/integrations/chatwoot";
import { ghostStatus } from "@/lib/integrations/ghost";
import { growthBookStatus } from "@/lib/integrations/growthbook";
import { documensoStatus } from "@/lib/integrations/documenso";
/* INTEGRATION:activepieces */ import { activepiecesStatus } from "@/lib/integrations/activepieces"; /* END */
/* PROVIDER:listmonk */ import { listmonkStatus } from "@/lib/integrations/listmonk"; /* END */
/* PROVIDER:postiz */ import { postizStatus } from "@/lib/integrations/postiz"; /* END */

export const dynamic = "force-dynamic";

const LLM_WORKLOADS = [
  ["copy", "Client-facing copy"],
  ["bulk", "Agent loop, skills, summaries"],
  ["background", "Background jobs"],
] as const;

const MODE_LABEL: Record<FeatureMode, string> = {
  live: "Live",
  mock: "Mock data",
  off: "Off",
};

// Mocked/off is configuration, not an agent state — neutral chips only,
// never the running/needs/done/failed colours.
function ModeChip({ mode }: { mode: FeatureMode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold shadow-control ${
        mode === "live" ? "text-ink" : "text-muted"
      }`}
    >
      {MODE_LABEL[mode]}
    </span>
  );
}

// Provider health states are provider states, not agent states — neutral chips.
function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control">
      {label}
    </span>
  );
}

export default async function ProvidersSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");

  const seo = providerStatus();
  const llm = llmStatus();
  // Context.dev keys live in the workspace vault, not the environment.
  const contextDevConnected = await prisma.connectorConnection
    .findFirst({
      where: { workspaceId: workspace.id, connectorKey: CONTEXTDEV_CONNECTOR_KEY, status: "active" },
      select: { id: true },
    })
    .then((c) => c !== null)
    .catch(() => null);
  const inventory = mockInventory(process.env, { llm: llm.routing, contextDevConnected });
  const mocked = notLive(inventory);
  const live = inventory.filter((f) => f.mode === "live");
  const unsplash = unsplashStatus();
  /* PROVIDER:brandfetch */
  const brandfetch = brandfetchStatus();
  /* END */
  const cloudinary = cloudinaryStatus();
  /* PROVIDER:pexels */ const pexels = pexelsStatus(); /* END */
  /* PROVIDER:pixabay */ const pixabay = pixabayStatus(); /* END */
  // Phase 12 (embeds).
  const umami = umamiStatus();
  const chatwoot = chatwootStatus();
  const ghost = ghostStatus();
  const growthbook = growthBookStatus();
  const documenso = documensoStatus();
  /* PROVIDER:listmonk */ const listmonk = listmonkStatus(); /* END */
  /* PROVIDER:postiz */ const postiz = postizStatus(); /* END */
  /* INTEGRATION:activepieces */ const activepieces = activepiecesStatus(); /* END */
  // Host-wide resources (the Activepieces engine) are managed by platform
  // operators, not workspace admins — decided here, enforced again by the API.
  const operator = isPlatformOperator({ id: user.id, email: user.email });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Providers</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          {workspace.name} — which external providers ShapesOS is using. These
          are configured via environment variables on the host; change them
          there and restart to apply. Key material is never displayed here.
        </p>
      </div>
      <SettingsNav />

      <section
        className="rounded-lg bg-paper p-5 shadow-hairline"
        aria-labelledby="providers-mocked"
      >
        <h2 id="providers-mocked" className="aos-subheading">
          What&apos;s running on mock data
        </h2>
        <p className="mt-1 text-sm text-muted">
          Read from this host&apos;s environment right now.{" "}
          {mocked.length === 0
            ? "Everything listed below is live."
            : `${mocked.length} of ${inventory.length} features are not live. Mock features run on labelled sample data; off features say so and do nothing.`}
        </p>
        {mocked.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">Feature</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Mode</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">What happens now</th>
                  <th scope="col" className="py-2 font-semibold">To go live, set</th>
                </tr>
              </thead>
              <tbody>
                {mocked.map((f) => (
                  <tr key={f.key} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3 text-xs font-semibold text-ink">{f.label}</td>
                    <td className="py-2 pr-3">
                      <ModeChip mode={f.mode} />
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted">{f.detail}</td>
                    <td className="py-2 font-mono text-xs text-ink">
                      {f.envVars.length ? f.envVars.join(", ") : "a workspace key"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {live.length > 0 && (
          <p className="mt-3 text-xs text-subtle">
            Live: {live.map((f) => f.label).join(", ")}.
          </p>
        )}
      </section>

      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">SEO data provider</h2>
          <StatusBadge
            ok={seo.configured}
            label={seo.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{seo.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>{seo.isLive ? "Yes" : "No — using the built-in mock"}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD</dd>
          </div>
        </dl>
        {!seo.configured && (
          <p className="mt-3 text-xs text-subtle">
            Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the host to switch
            from mock data to live DataForSEO results.
          </p>
        )}
      </div>

      <section
        className="rounded-lg border border-line bg-paper/60 p-5"
        aria-labelledby="providers-llm"
      >
        <div className="flex items-center justify-between gap-2">
          <h2 id="providers-llm" className="font-medium">LLM routing</h2>
          <StatusBadge
            ok={llm.isLive}
            label={`${LLM_WORKLOADS.filter(([w]) => llm.routing[w].isLive).length} of ${LLM_WORKLOADS.length} workloads live`}
          />
        </div>
        <p className="mt-1 text-xs text-subtle">
          Each workload routes to one model. With only one provider key, the
          workloads that default to the other provider switch to this
          provider&apos;s default (single-key mode); a model you set
          explicitly is never swapped. When both keys are set, a rate limit
          or outage fails over to the other provider.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th scope="col" className="py-2 pr-3 font-semibold">Workload</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Model</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Mode</th>
                <th scope="col" className="py-2 font-semibold">Why</th>
              </tr>
            </thead>
            <tbody>
              {LLM_WORKLOADS.map(([w, label]) => {
                const r = llm.routing[w];
                return (
                  <tr key={w} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3 text-xs text-ink">{label}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-ink">{r.model}</td>
                    <td className="py-2 pr-3">
                      <ModeChip mode={r.isLive ? "live" : "mock"} />
                    </td>
                    <td className="py-2 text-xs text-muted">
                      {r.isLive ? (
                        <>
                          {r.source === "env"
                            ? "Set explicitly by environment."
                            : r.source === "legacy"
                              ? "Set by the deprecated LLM_MODEL variable."
                              : "Default model."}
                          {r.singleKey ? <> {r.singleKey}</> : null}{" "}
                          {r.failover ? (
                            <>
                              Fails over to <span className="font-mono">{r.failover}</span>.
                            </>
                          ) : (
                            "No failover configured."
                          )}
                        </>
                      ) : (
                        <>Labelled mock drafts: {r.fallback ?? "no provider configured"}.</>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <dl className="mt-3 grid gap-2 text-sm">
          <div>
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">
              ANTHROPIC_API_KEY, OPENAI_API_KEY (or LLM_API_KEY),
              LLM_MODEL_COPY, LLM_MODEL_BULK, LLM_MODEL_BACKGROUND,
              LLM_FAILOVER, LLM_SELF_HOST, LLM_BASE_URL
            </dd>
          </div>
        </dl>
        {!llm.isLive && (
          <p className="mt-3 text-xs text-subtle">
            Set ANTHROPIC_API_KEY or OPENAI_API_KEY on the host. One key is
            enough: every workload then runs live on that provider.
          </p>
        )}
      </section>

      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Stock photos (Unsplash)</h2>
          <StatusBadge
            ok={unsplash.configured}
            label={unsplash.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{unsplash.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>
              {unsplash.isLive
                ? "Yes"
                : "No — stock photo search is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variable</dt>
            <dd className="font-mono text-xs">UNSPLASH_ACCESS_KEY</dd>
          </div>
        </dl>
        {!unsplash.configured && (
          <p className="mt-3 text-xs text-subtle">
            Get a free key at unsplash.com/developers and set
            UNSPLASH_ACCESS_KEY on the host to enable stock photo search in
            the design editor. Key material is never displayed here.
          </p>
        )}
      </div>

      {/* PROVIDER:brandfetch */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Brand lookup (Brandfetch)</h2>
          <StatusBadge
            ok={brandfetch.configured}
            label={brandfetch.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{brandfetch.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>
              {brandfetch.isLive
                ? "Yes"
                : "No — brand lookup is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variable</dt>
            <dd className="font-mono text-xs">BRANDFETCH_API_KEY</dd>
          </div>
        </dl>
        {!brandfetch.configured && (
          <p className="mt-3 text-xs text-subtle">
            Get a key at brandfetch.com and set BRANDFETCH_API_KEY on the
            host to enable one-click brand-kit autofill (logo, palette,
            fonts) from a domain in the design editor. Key material is never
            displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:pexels */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Stock photos & video (Pexels)</h2>
          <StatusBadge
            ok={pexels.configured}
            label={pexels.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{pexels.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>
              {pexels.isLive
                ? "Yes"
                : "No — Pexels stock search is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variable</dt>
            <dd className="font-mono text-xs">PEXELS_API_KEY</dd>
          </div>
        </dl>
        {!pexels.configured && (
          <p className="mt-3 text-xs text-subtle">
            Get a free key at pexels.com/api and set PEXELS_API_KEY on the
            host to enable Pexels photo + video search in the design editor.
            Key material is never displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:pixabay */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Stock images & video (Pixabay)</h2>
          <StatusBadge
            ok={pixabay.configured}
            label={pixabay.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{pixabay.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>
              {pixabay.isLive
                ? "Yes"
                : "No — Pixabay stock search is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variable</dt>
            <dd className="font-mono text-xs">PIXABAY_API_KEY</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Placed Pixabay assets are downloaded server-side and served from
          ShapesOS’s own storage (cached 24h per the Pixabay API terms) — no
          permanent Pixabay hotlinking. Pixabay does not guarantee model or
          property releases exist for people/logos/trademarks in images.
        </p>
        {!pixabay.configured && (
          <p className="mt-2 text-xs text-subtle">
            Sign up free at pixabay.com for an API key and set PIXABAY_API_KEY
            on the host. Key material is never displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:cloudinary */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Media uploads (Cloudinary)</h2>
          <StatusBadge
            ok={cloudinary.configured}
            label={cloudinary.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{cloudinary.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Upload pipeline</dt>
            <dd>
              {cloudinary.isLive
                ? "Yes — signed direct-to-Cloudinary uploads with auto format/quality"
                : "No — the Canvas editor saves uploads as local data URLs"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">
              CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Uploads go to your own Cloudinary account (free tier: 25
          credits/month, metered by Cloudinary on your dashboard). The API
          secret stays on the server; the browser only ever receives
          time-limited upload signatures. Key material is never displayed
          here.
        </p>
        {!cloudinary.configured && (
          <p className="mt-2 text-xs text-subtle">
            Create a free account at cloudinary.com and set the three
            CLOUDINARY_* variables on the host to replace data-URL uploads
            with the Cloudinary pipeline in the design editor.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:listmonk */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Newsletter engine (Listmonk)</h2>
          <StatusBadge
            ok={listmonk.configured}
            label={listmonk.configured ? "connected" : "not connected"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{listmonk.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>
              {listmonk.isLive
                ? "Yes — broadcasts run on your Listmonk sidecar"
                : "No — the Broadcasts tab in Nurture is disabled until you connect"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">
              LISTMONK_URL, LISTMONK_USER, LISTMONK_TOKEN
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Listmonk is a self-hosted AGPL-3.0 email engine sidecar (separate
          process, own Postgres — see docker/integrations/listmonk.yml). ShapesOS
          talks to it over its REST API only, with Basic auth (user + token).
        </p>
        {!listmonk.configured && (
          <p className="mt-2 text-xs text-subtle">
            Bring up the sidecar and set LISTMONK_URL, LISTMONK_USER, and
            LISTMONK_TOKEN on the host. Key material is never displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:postiz */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Social publishing (Postiz)</h2>
          <StatusBadge
            ok={postiz.configured}
            label={postiz.configured ? "connected" : "not connected"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{postiz.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Live data</dt>
            <dd>
              {postiz.isLive
                ? "Yes — scheduling runs on your Postiz sidecar"
                : "No — the Social workspace is disabled until you connect"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">POSTIZ_URL, POSTIZ_API_KEY</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Postiz is a self-hosted AGPL-3.0 social-publishing sidecar (~30
          channels behind one OAuth surface — see
          docker/integrations/postiz.yml). ShapesOS uses its public REST API
          over raw fetch only — never the AGPL <span className="font-mono">@postiz/node</span> SDK.
          Channel OAuth tokens stay inside Postiz.
        </p>
        {!postiz.configured && (
          <p className="mt-2 text-xs text-subtle">
            Bring up the sidecar, create an API key in its Settings → Public
            API, and set POSTIZ_URL and POSTIZ_API_KEY on the host. Key
            material is never displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* INTEGRATION:activepieces */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Automation engine (Activepieces)</h2>
          <StatusBadge
            ok={activepieces.configured}
            label={activepieces.configured ? "connected" : "not connected"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Engine</dt>
            <dd className="font-mono text-xs">
              {activepieces.configured ? activepieces.url : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Flows</dt>
            <dd>
              {activepieces.configured
                ? "Yes — Missions, Playbooks, and the Strategy Agent can trigger published webhook flows"
                : "No — automation features stay hidden until you connect"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">ACTIVEPIECES_URL, ACTIVEPIECES_API_KEY, ACTIVEPIECES_API_PREFIX (optional)</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Activepieces Community Edition (MIT) is the optional automation
          backbone: self-host with{" "}
          <code className="font-mono">
            docker compose -f docker/integrations/activepieces.yml --profile activepieces up -d
          </code>
          , create an API key in its Settings, and set ACTIVEPIECES_URL and
          ACTIVEPIECES_API_KEY on the host. Key material is never displayed
          here. Only published flows with a “Catch Webhook” trigger can be
          fired externally — schedule and piece triggers run inside the engine.
        </p>
        {!activepieces.configured && (
          <p className="mt-2 text-xs text-subtle">
            Unconnected: the Run automation action, automation playbook steps,
            and automation tools report an honest “not connected” state and
            nothing is fabricated.
          </p>
        )}
        {activepieces.configured && operator && (
          <ActivepiecesFlowBindings workspaceId={workspace.id} workspaceName={workspace.name} />
        )}
      </div>
      {/* END */}

      {/* PHASE12:umami */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Analytics (Umami)</h2>
          <StatusBadge
            ok={umami.statsConfigured}
            label={umami.statsConfigured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{umami.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Stats API</dt>
            <dd>
              {umami.statsConfigured
                ? "Yes — the Analytics dashboard reads this sidecar"
                : "No — the Analytics page shows the setup guide"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Tracking snippet</dt>
            <dd>
              {umami.snippetConfigured
                ? "Yes — cookieless tracking on public pages"
                : "No — public pages send no analytics"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">
              UMAMI_URL, UMAMI_API_KEY, UMAMI_WEBSITE_ID, UMAMI_SCRIPT_URL
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Self-host with{" "}
          <code className="font-mono">
            docker compose -f docker-compose.yml -f docker/profiles/umami.yml --profile umami up -d
          </code>
          . MIT, cookieless, ~100MB idle. Key material is never displayed here.
        </p>
      </div>
      {/* END */}

      {/* PHASE12:chatwoot */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Live chat (Chatwoot)</h2>
          <StatusBadge
            ok={chatwoot.active}
            label={
              chatwoot.active
                ? "active"
                : chatwoot.configured
                  ? "configured — off"
                  : "not configured"
            }
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{chatwoot.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Widget</dt>
            <dd>
              {chatwoot.active
                ? "Live in the dashboard"
                : "Off — the widget loads only with an explicit opt-in"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">
              CHATWOOT_BASE_URL, CHATWOOT_WEBSITE_TOKEN, CHATWOOT_WIDGET_ENABLED=true
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          MIT core. Off by default even with credentials set — the widget
          mounts only when CHATWOOT_WIDGET_ENABLED=true. Key material is never
          displayed here.
        </p>
      </div>
      {/* END */}

      {/* PHASE12:ghost */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Blog publishing (Ghost)</h2>
          <StatusBadge
            ok={ghost.configured}
            label={ghost.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{ghost.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Content engine</dt>
            <dd>
              {ghost.configured
                ? "Yes — “Publish to Ghost” is live on content items"
                : "No — “Publish to Ghost” is disabled with an honest message"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">GHOST_URL, GHOST_ADMIN_API_KEY</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          MIT. Posts go out as Ghost drafts by default. Key material is never
          displayed here.
        </p>
      </div>
      {/* END */}

      {/* PHASE12:growthbook */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Feature flags (GrowthBook)</h2>
          <StatusBadge
            ok={growthbook.managementConfigured}
            label={growthbook.managementConfigured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{growthbook.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">SDK (live flag values)</dt>
            <dd>
              {growthbook.sdkConfigured
                ? "Yes — flags resolve from the sidecar"
                : "No — ShapesOS's built-in flag defaults apply"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">
              GROWTHBOOK_API_HOST, GROWTHBOOK_API_KEY, GROWTHBOOK_CLIENT_KEY
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          Open core, MIT bulk. Self-host with{" "}
          <code className="font-mono">
            docker compose -f docker-compose.yml -f docker/profiles/growthbook.yml --profile growthbook up -d
          </code>
          . Flags are managed at Settings → Experiments. Key material is never
          displayed here.
        </p>
      </div>
      {/* END */}

      {/* PHASE12:documenso */}
      <div className="rounded-lg border border-line bg-paper/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">E-signatures (Documenso)</h2>
          <StatusBadge
            ok={documenso.configured}
            label={documenso.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-subtle">Provider</dt>
            <dd className="font-mono text-xs">{documenso.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-subtle">Signing requests</dt>
            <dd>
              {documenso.configured
                ? "Yes — API-only, at Settings → Signing"
                : "No — the Signing page shows the setup guide"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-subtle">Environment variables</dt>
            <dd className="font-mono text-xs">DOCUMENSO_URL, DOCUMENSO_API_KEY</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-subtle">
          AGPL Community Edition, API-only against an unmodified instance —
          signers use Documenso&apos;s own emailed link. The white-labeled
          embedded signing UI is the paid Enterprise feature and is not
          offered. Key material is never displayed here.
        </p>
      </div>
      {/* END */}
    </div>
  );
}
