// Marketr — provider status settings page (milestone 21, part D1).
// Admin+ only (server-gated), read-only. Honest about what is configured via
// environment: statuses are live, key material is never displayed.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { providerStatus } from "@/lib/providers";
import { llmStatus } from "@/lib/llm";
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
    </div>
  );
}
