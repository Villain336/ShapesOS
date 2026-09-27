// Marketr — provider status settings page (milestone 21, part D1).
// Admin+ only (server-gated), read-only. Honest about what is configured via
// environment: statuses are live, key material is never displayed.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { providerStatus } from "@/lib/providers";
import { llmStatus } from "@/lib/llm";
import { unsplashStatus } from "@/lib/design/unsplash";
/* PROVIDER:pexels */ import { pexelsStatus } from "@/lib/design/pexels"; /* END */
/* PROVIDER:pixabay */ import { pixabayStatus } from "@/lib/design/pixabay"; /* END */
/* PROVIDER:cloudinary */ import { cloudinaryStatus } from "@/lib/design/cloudinary"; /* END */
/* PROVIDER:brandfetch */ import { brandfetchStatus } from "@/lib/design/brandfetch"; /* END */
import SettingsNav from "@/components/settings/SettingsNav";

export const dynamic = "force-dynamic";

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        ok ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500"
      }`}
    >
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
  const unsplash = unsplashStatus();
  /* PROVIDER:brandfetch */
  const brandfetch = brandfetchStatus();
  /* END */
  const cloudinary = cloudinaryStatus();
  /* PROVIDER:pexels */ const pexels = pexelsStatus(); /* END */
  /* PROVIDER:pixabay */ const pixabay = pixabayStatus(); /* END */

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Providers</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          {workspace.name} — which external providers Marketr is using. These
          are configured via environment variables on the host; change them
          there and restart to apply. Key material is never displayed here.
        </p>
      </div>
      <SettingsNav />

      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">SEO data provider</h2>
          <StatusBadge
            ok={seo.configured}
            label={seo.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{seo.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Live data</dt>
            <dd>{seo.isLive ? "Yes" : "No — using the built-in mock"}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variables</dt>
            <dd className="font-mono text-xs">DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD</dd>
          </div>
        </dl>
        {!seo.configured && (
          <p className="mt-3 text-xs text-zinc-500">
            Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the host to switch
            from mock data to live DataForSEO results.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">LLM provider</h2>
          <StatusBadge
            ok={llm.configured}
            label={llm.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{llm.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Live model</dt>
            <dd>{llm.isLive ? "Yes" : "No — using the built-in mock"}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Model</dt>
            <dd className="font-mono text-xs">{llm.model ?? "—"}</dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variables</dt>
            <dd className="font-mono text-xs">
              LLM_API_KEY (falls back to OPENAI_API_KEY), LLM_MODEL, LLM_BASE_URL
            </dd>
          </div>
        </dl>
        {!llm.configured && (
          <p className="mt-3 text-xs text-zinc-500">
            Set LLM_API_KEY (or OPENAI_API_KEY) on the host to use a live
            OpenAI-compatible endpoint instead of the mock.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Stock photos (Unsplash)</h2>
          <StatusBadge
            ok={unsplash.configured}
            label={unsplash.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{unsplash.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Live data</dt>
            <dd>
              {unsplash.isLive
                ? "Yes"
                : "No — stock photo search is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variable</dt>
            <dd className="font-mono text-xs">UNSPLASH_ACCESS_KEY</dd>
          </div>
        </dl>
        {!unsplash.configured && (
          <p className="mt-3 text-xs text-zinc-500">
            Get a free key at unsplash.com/developers and set
            UNSPLASH_ACCESS_KEY on the host to enable stock photo search in
            the design editor. Key material is never displayed here.
          </p>
        )}
      </div>

      {/* PROVIDER:brandfetch */}
      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Brand lookup (Brandfetch)</h2>
          <StatusBadge
            ok={brandfetch.configured}
            label={brandfetch.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{brandfetch.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Live data</dt>
            <dd>
              {brandfetch.isLive
                ? "Yes"
                : "No — brand lookup is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variable</dt>
            <dd className="font-mono text-xs">BRANDFETCH_API_KEY</dd>
          </div>
        </dl>
        {!brandfetch.configured && (
          <p className="mt-3 text-xs text-zinc-500">
            Get a key at brandfetch.com and set BRANDFETCH_API_KEY on the
            host to enable one-click brand-kit autofill (logo, palette,
            fonts) from a domain in the design editor. Key material is never
            displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:pexels */}
      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Stock photos & video (Pexels)</h2>
          <StatusBadge
            ok={pexels.configured}
            label={pexels.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{pexels.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Live data</dt>
            <dd>
              {pexels.isLive
                ? "Yes"
                : "No — Pexels stock search is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variable</dt>
            <dd className="font-mono text-xs">PEXELS_API_KEY</dd>
          </div>
        </dl>
        {!pexels.configured && (
          <p className="mt-3 text-xs text-zinc-500">
            Get a free key at pexels.com/api and set PEXELS_API_KEY on the
            host to enable Pexels photo + video search in the design editor.
            Key material is never displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:pixabay */}
      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Stock images & video (Pixabay)</h2>
          <StatusBadge
            ok={pixabay.configured}
            label={pixabay.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{pixabay.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Live data</dt>
            <dd>
              {pixabay.isLive
                ? "Yes"
                : "No — Pixabay stock search is disabled in the Canvas editor"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variable</dt>
            <dd className="font-mono text-xs">PIXABAY_API_KEY</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Placed Pixabay assets are downloaded server-side and served from
          Marketr’s own storage (cached 24h per the Pixabay API terms) — no
          permanent Pixabay hotlinking. Pixabay does not guarantee model or
          property releases exist for people/logos/trademarks in images.
        </p>
        {!pixabay.configured && (
          <p className="mt-2 text-xs text-zinc-500">
            Sign up free at pixabay.com for an API key and set PIXABAY_API_KEY
            on the host. Key material is never displayed here.
          </p>
        )}
      </div>
      {/* END */}

      {/* PROVIDER:cloudinary */}
      <div className="rounded-xl border border-zinc-200 bg-white/60 p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">Media uploads (Cloudinary)</h2>
          <StatusBadge
            ok={cloudinary.configured}
            label={cloudinary.configured ? "configured" : "not configured"}
          />
        </div>
        <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Provider</dt>
            <dd className="font-mono text-xs">{cloudinary.name}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Upload pipeline</dt>
            <dd>
              {cloudinary.isLive
                ? "Yes — signed direct-to-Cloudinary uploads with auto format/quality"
                : "No — the Canvas editor saves uploads as local data URLs"}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="text-xs text-zinc-500">Environment variables</dt>
            <dd className="font-mono text-xs">
              CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Uploads go to your own Cloudinary account (free tier: 25
          credits/month, metered by Cloudinary on your dashboard). The API
          secret stays on the server; the browser only ever receives
          time-limited upload signatures. Key material is never displayed
          here.
        </p>
        {!cloudinary.configured && (
          <p className="mt-2 text-xs text-zinc-500">
            Create a free account at cloudinary.com and set the three
            CLOUDINARY_* variables on the host to replace data-URL uploads
            with the Cloudinary pipeline in the design editor.
          </p>
        )}
      </div>
      {/* END */}
    </div>
  );
}
