// Marketr — marketing studio: Porkbun domains + asset library (milestone 22).
// Client island: Domains, Assets tabs.
// Motion language (better-ui / emil-design-eng): press scale 0.96, named
// transitions with cubic-bezier(0.2,0,0,1), 150ms tab fades, Lucide-only.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  TriangleAlert,
  Check,
  Globe,
  Image as ImageIcon,
  Layers,
  Link,
  LoaderCircle,
  Send,
  Settings,
  Trash,
} from "lucide-react";

interface Props {
  projectId: string;
  canEdit: boolean;
  isOwnerAdmin: boolean;
}

type Tab = "domains" | "assets";

interface StudioDomain {
  id: string;
  domain: string;
  tld: string;
  status: string;
  priceUsd: number | null;
  orderId: string | null;
  whoisPrivacy: boolean;
  purchasedAt: string | null;
  nameServers: string[];
  errorDetail: string | null;
}

interface StudioAsset {
  id: string;
  name: string;
  source: string;
  url: string;
  mimeType: string | null;
  createdAt: string;
}

interface PurchasePreview {
  domain: string;
  priceUsd: number | null;
  renewalPriceUsd: number | null;
  confirmationToken: string;
  icannDisclosure: string;
  registrant: Record<string, string>;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  return body;
}

export default function StudioStudio({ projectId, canEdit, isOwnerAdmin }: Props) {
  const [tab, setTab] = useState<Tab>("domains");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [socialAsset, setSocialAsset] = useState<StudioAsset | null>(null);
  const [socialText, setSocialText] = useState("");
  // Wave B: Postiz channels for the use-in-social draft (replaces the old
  // Buffer service keys). Loaded when the dialog opens.
  const [socialChannelIds, setSocialChannelIds] = useState<string[]>([]);
  const [postizChannels, setPostizChannels] = useState<Array<{ id: string; name: string | null; identifier: string }>>([]);
  const [postizChannelsLoading, setPostizChannelsLoading] = useState(false);

  // Domain state
  const [domains, setDomains] = useState<StudioDomain[]>([]);
  const [porkbunConfigured, setPorkbunConfigured] = useState(false);
  const [porkbunHint, setPorkbunHint] = useState<string | null>(null);
  const [searchDomain, setSearchDomain] = useState("");
  const [searchResult, setSearchResult] = useState<{
    domain: string;
    available: boolean;
    priceUsd: number | null;
    renewalPriceUsd: number | null;
    premium: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [registrant, setRegistrant] = useState<Record<string, string> | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);

  // Asset state
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [newAssetUrl, setNewAssetUrl] = useState("");
  const [newAssetName, setNewAssetName] = useState("");

  const press = "transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96]";
  const fade = "transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)]";

  const ok = (text: string) => setNotice({ kind: "ok", text });
  const err = (e: unknown) => setNotice({ kind: "err", text: e instanceof Error ? e.message : "Something went wrong." });


  const refreshDomains = useCallback(async () => {
    const s = (await api(`/api/studio/domains/settings?projectId=${projectId}`)) as {
      configured: boolean;
      hint: string | null;
    };
    setPorkbunConfigured(s.configured);
    setPorkbunHint(s.hint);
    const d = (await api(`/api/studio/domains?projectId=${projectId}`)) as { domains: StudioDomain[] };
    setDomains(d.domains);
    const r = (await api(`/api/studio/domains/registrant?projectId=${projectId}`)) as {
      registrant: Record<string, string> | null;
    };
    setRegistrant(r.registrant);
  }, [projectId]);

  const refreshAssets = useCallback(async () => {
    const a = (await api(`/api/studio/assets?projectId=${projectId}`)) as { assets: StudioAsset[] };
    setAssets(a.assets);
  }, [projectId]);

  useEffect(() => {
    refreshDomains().catch(err);
    refreshAssets().catch(err);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run<T>(fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (done) done(r);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  }

  // --- Domain actions ---
  async function savePorkbunKeys(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await run(async () => {
      const r = (await api("/api/studio/domains/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          apiKey: form.get("apiKey"),
          secretApiKey: form.get("secretApiKey"),
        }),
      })) as { hint: string };
      setPorkbunConfigured(true);
      setPorkbunHint(r.hint);
      ok("Porkbun keys saved.");
    });
  }

  async function searchAvailability() {
    await run(async () => {
      const r = (await api(
        `/api/studio/domains/search?projectId=${projectId}&domain=${encodeURIComponent(searchDomain)}`,
      )) as {
        availability: {
          domain: string;
          available: boolean;
          priceUsd: number | null;
          renewalPriceUsd: number | null;
          premium: boolean;
        };
      };
      setSearchResult(r.availability);
      setPreview(null);
    });
  }

  async function previewPurchase() {
    if (!searchResult) return;
    await run(async () => {
      const r = (await api("/api/studio/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, domain: searchResult.domain }),
      })) as { preview: PurchasePreview };
      setPreview(r.preview);
      setAgreeTerms(false);
    });
  }

  async function confirmPurchase() {
    if (!preview) return;
    await run(async () => {
      const r = (await api("/api/studio/domains/purchase/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          confirmationToken: preview.confirmationToken,
          agreeToTerms: agreeTerms,
          whoisPrivacy: true,
        }),
      })) as { purchase: { domain: string; costUsd: number } };
      setPreview(null);
      setSearchResult(null);
      setSearchDomain("");
      await refreshDomains();
      ok(`Domain registered: ${r.purchase.domain} ($${r.purchase.costUsd.toFixed(2)}).`);
    });
  }

  async function saveRegistrant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fields = Object.fromEntries(
      ["firstName", "lastName", "email", "phone", "address", "city", "state", "zip", "country"].map((k) => [
        k,
        String(form.get(k) ?? ""),
      ]),
    );
    await run(async () => {
      const r = (await api("/api/studio/domains/registrant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...fields }),
      })) as { registrant: Record<string, string> };
      setRegistrant(r.registrant);
      ok("Registrant contact saved.");
    });
  }

  // --- Asset actions ---
  async function addAsset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await run(async () => {
      await api("/api/studio/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: newAssetName || newAssetUrl, source: "upload", url: newAssetUrl }),
      });
      setNewAssetUrl("");
      setNewAssetName("");
      await refreshAssets();
      ok("Asset added to the library.");
    });
  }

  async function deleteAsset(id: string) {
    setDeleteTarget(id);
  }

  async function doDeleteAsset() {
    if (!deleteTarget) return;
    const id = deleteTarget;
    setDeleteTarget(null);
    await run(async () => {
      await api(`/api/studio/assets/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      await refreshAssets();
      ok("Asset deleted.");
    });
  }

  async function openUseInSocial(asset: StudioAsset) {
    setSocialAsset(asset);
    setSocialText("");
    setSocialChannelIds([]);
    setPostizChannelsLoading(true);
    try {
      const r = (await api("/api/integrations/postiz/channels")) as {
        channels?: Array<{ id: string; name: string | null; identifier: string }>;
      };
      setPostizChannels(Array.isArray(r?.channels) ? r.channels : []);
    } catch {
      setPostizChannels([]);
    } finally {
      setPostizChannelsLoading(false);
    }
  }

  async function submitUseInSocial() {
    if (!socialAsset || socialChannelIds.length === 0) return;
    const asset = socialAsset;
    await run(async () => {
      const platformTypes: Record<string, string> = {};
      for (const c of postizChannels) if (socialChannelIds.includes(c.id) && c.identifier) platformTypes[c.id] = c.identifier;
      const r = (await api(`/api/studio/assets/${asset.id}/use-in-social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, text: socialText, channelIds: socialChannelIds, platformTypes }),
      })) as { postizRef: string };
      void r;
      setSocialAsset(null);
      setSocialChannelIds([]);
      ok("Draft created in Postiz — find it under Social.");
    });
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "domains", label: "Domains", icon: <Globe className="h-4 w-4" /> },
    { id: "assets", label: "Assets", icon: <Layers className="h-4 w-4" /> },
  ];

  return (
    <div>
      {notice && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${fade} ${
            notice.kind === "ok"
              ? "border-emerald-200 bg-emerald-50/40 text-emerald-700"
              : "border-red-200 bg-red-50/40 text-red-700"
          }`}
        >
          {notice.kind === "ok" ? <Check className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
          {notice.text}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-1 border-b border-zinc-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${press} ${
              tab === t.id ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* DOMAINS */}
      {tab === "domains" && (
        <div className={fade}>
          {!isOwnerAdmin && (
            <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-2.5 text-sm text-amber-700">
              Domain purchasing needs an owner or admin role. Availability search and the domain list
              are still visible.
            </p>
          )}

          {/* Porkbun keys */}
          {isOwnerAdmin && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-800">
                <Settings className="h-4 w-4" /> Porkbun API keys
              </h3>
              <p className="mb-4 text-sm text-zinc-500">
                {porkbunConfigured
                  ? `Connected (${porkbunHint ?? "key set"}). Get keys at Porkbun → Account → API Access.`
                  : "Bring your own Porkbun API keys — they are encrypted at rest and never shown again."}
              </p>
              <form onSubmit={savePorkbunKeys} className="flex flex-wrap gap-2">
                <input
                  name="apiKey"
                  type="password"
                  placeholder="API key"
                  autoComplete="off"
                  className="w-56 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                />
                <input
                  name="secretApiKey"
                  type="password"
                  placeholder="Secret API key"
                  autoComplete="off"
                  className="w-56 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                >
                  Save keys
                </button>
              </form>
            </div>
          )}

          {/* Search */}
          {porkbunConfigured && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="mb-3 text-sm font-semibold text-zinc-800">Check availability</h3>
              <div className="flex gap-2">
                <input
                  value={searchDomain}
                  onChange={(e) => setSearchDomain(e.target.value)}
                  placeholder="yourdomain.com"
                  className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                />
                <button
                  onClick={searchAvailability}
                  disabled={busy || !searchDomain.trim()}
                  className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                >
                  Search
                </button>
              </div>
              {searchResult && (
                <div className="mt-4 rounded-lg border border-zinc-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-zinc-900">{searchResult.domain}</span>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        searchResult.available
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {searchResult.available ? "Available" : "Taken"}
                    </span>
                  </div>
                  {searchResult.available && searchResult.priceUsd != null && (
                    <div className="mt-2 text-sm text-zinc-500">
                      ${searchResult.priceUsd.toFixed(2)}/yr registration
                      {searchResult.renewalPriceUsd != null &&
                        searchResult.renewalPriceUsd !== searchResult.priceUsd && (
                          <span> · ${searchResult.renewalPriceUsd.toFixed(2)}/yr renewal</span>
                        )}
                      {searchResult.renewalPriceUsd != null &&
                        searchResult.renewalPriceUsd === searchResult.priceUsd && (
                          <span> · renews at ${searchResult.renewalPriceUsd.toFixed(2)}/yr</span>
                        )}
                    </div>
                  )}
                  {searchResult.available && isOwnerAdmin && !preview && (
                    <button
                      onClick={previewPurchase}
                      className={`mt-3 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                    >
                      Buy this domain
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Purchase preview / double confirmation */}
          {preview && (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/20 p-5">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800">
                <TriangleAlert className="h-4 w-4" /> Confirm purchase
              </h3>
              <p className="mb-1 text-lg font-semibold text-zinc-900">{preview.domain}</p>
              <p className="mb-3 text-sm text-zinc-500">
                ${preview.priceUsd?.toFixed(2)}/yr registration
                {preview.renewalPriceUsd != null && ` · $${preview.renewalPriceUsd.toFixed(2)}/yr renewal`}
              </p>
              <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">Registrant</p>
              <p className="mb-3 text-sm text-zinc-500">
                {preview.registrant.firstName} {preview.registrant.lastName} · {preview.registrant.email} ·{" "}
                {preview.registrant.address}, {preview.registrant.city} {preview.registrant.zip},{" "}
                {preview.registrant.country}
              </p>
              <p className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-500">
                {preview.icannDisclosure}
              </p>
              <label className="mb-4 flex cursor-pointer items-start gap-2 text-sm text-zinc-500">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                  className="mt-1"
                />
                I agree to the registration terms and confirm this purchase. This charges my Porkbun
                account.
              </label>
              <div className="flex gap-2">
                <button
                  onClick={confirmPurchase}
                  disabled={busy || !agreeTerms}
                  className={`rounded-md bg-[var(--brand-600)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40 ${press}`}
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Confirm purchase"}
                </button>
                <button
                  onClick={() => setPreview(null)}
                  className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Registrant */}
          {isOwnerAdmin && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Registrant contact</h3>
              <p className="mb-4 text-sm text-zinc-500">
                Required before any purchase. Porkbun registers with your account&apos;s default
                contact; this is your review copy and audit record.
              </p>
              <form onSubmit={saveRegistrant} className="grid gap-2 sm:grid-cols-2">
                {[
                  ["firstName", "First name"],
                  ["lastName", "Last name"],
                  ["email", "Email"],
                  ["phone", "Phone"],
                  ["address", "Address"],
                  ["city", "City"],
                  ["state", "State"],
                  ["zip", "ZIP"],
                  ["country", "Country"],
                ].map(([k, label]) => (
                  <input
                    key={k}
                    name={k}
                    defaultValue={registrant?.[k] ?? (k === "country" ? "US" : "")}
                    placeholder={label}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                  />
                ))}
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className={`rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 ${press}`}
                  >
                    Save registrant
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Domain list */}
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Project domains
          </h3>
          {domains.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
              No domains yet. Search above to register one through Porkbun.
            </p>
          ) : (
            <div className="grid gap-3">
              {domains.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4"
                >
                  <div>
                    <p className="font-medium text-zinc-900">{d.domain}</p>
                    <p className="text-xs text-zinc-500">
                      {d.status}
                      {d.priceUsd != null && ` · $${d.priceUsd.toFixed(2)}`}
                      {d.purchasedAt && ` · bought ${new Date(d.purchasedAt).toLocaleDateString()}`}
                      {d.nameServers.length > 0 && ` · ${d.nameServers.join(", ")}`}
                    </p>
                    {d.errorDetail && <p className="text-xs text-red-600">{d.errorDetail}</p>}
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      d.status === "registered"
                        ? "bg-emerald-50 text-emerald-700"
                        : d.status === "failed"
                          ? "bg-red-50 text-red-700"
                          : "bg-zinc-100 text-zinc-500"
                    }`}
                  >
                    {d.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ASSETS */}
      {tab === "assets" && (
        <div className={fade}>
          {canEdit && (
            <form onSubmit={addAsset} className="mb-6 flex flex-wrap gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <input
                value={newAssetName}
                onChange={(e) => setNewAssetName(e.target.value)}
                placeholder="Name"
                className="w-48 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
              />
              <input
                value={newAssetUrl}
                onChange={(e) => setNewAssetUrl(e.target.value)}
                placeholder="https://… image or file URL"
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
              />
              <button
                type="submit"
                disabled={busy || !newAssetUrl.trim()}
                className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
              >
                Add asset
              </button>
            </form>
          )}
          {assets.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
              No assets yet. Add a URL below.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map((a) => (
                <div key={a.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="mb-3 flex h-32 items-center justify-center overflow-hidden rounded-lg bg-white outline outline-1 outline-[oklch(0_0_0/0.1)]">
                    {a.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.url) ? (
                      <img src={a.url} alt={a.name} className="max-h-full object-contain" />
                    ) : (
                      <ImageIcon className="h-8 w-8 text-zinc-600" />
                    )}
                  </div>
                  <p className="text-sm font-medium text-zinc-800">{a.name}</p>
                  <p className="mb-3 text-xs capitalize text-zinc-500">{a.source}</p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-800 ${press}`}
                    >
                      <Link className="h-3 w-3" /> Open
                    </a>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => void openUseInSocial(a)}
                          className={`inline-flex items-center gap-1 rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 ${press}`}
                        >
                          <Send className="h-3 w-3" /> Use in social post
                        </button>
                        <button
                          onClick={() => deleteAsset(a.id)}
                          className={`rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 ${press}`}
                        >
                          <Trash className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className={`w-full max-w-sm rounded-2xl border border-zinc-200 bg-zinc-50 p-6 ${fade}`}>
            <h3 className="text-base font-semibold text-zinc-900">Delete this asset?</h3>
            <p className="mt-1 text-sm text-zinc-500">
              This removes it from the asset library. Posts already using it keep their copy.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
              >
                Cancel
              </button>
              <button
                onClick={doDeleteAsset}
                disabled={busy}
                className={`rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white ${press}`}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Use in social post */}
      {socialAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className={`w-full max-w-lg rounded-2xl border border-zinc-200 bg-zinc-50 p-6 ${fade}`}>
            <h3 className="text-base font-semibold text-zinc-900">Use in social post</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Creates a Postiz draft with “{socialAsset.name}” — publish it from the Social tab.
            </p>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-zinc-500">Post text</span>
              <textarea
                value={socialText}
                onChange={(e) => setSocialText(e.target.value)}
                rows={4}
                placeholder="Write the post…"
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </label>
            <div className="mt-4">
              <span className="mb-1 block text-xs font-medium text-zinc-500">Postiz channels</span>
              {postizChannelsLoading ? (
                <p className="text-xs text-zinc-500">Loading channels…</p>
              ) : postizChannels.length === 0 ? (
                <p className="text-xs text-zinc-500">No Postiz channels connected — connect one under Social first.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {postizChannels.map((ch) => (
                    <button
                      key={ch.id}
                      onClick={() =>
                        setSocialChannelIds(
                          socialChannelIds.includes(ch.id)
                            ? socialChannelIds.filter((c) => c !== ch.id)
                            : [...socialChannelIds, ch.id],
                        )
                      }
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        socialChannelIds.includes(ch.id)
                          ? "border-violet-600 bg-violet-600 text-white"
                          : "border-zinc-300 text-zinc-500"
                      }`}
                    >
                      {ch.name ?? ch.identifier}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setSocialAsset(null)}
                className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
              >
                Cancel
              </button>
              <button
                onClick={submitUseInSocial}
                disabled={busy || socialChannelIds.length === 0}
                className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
              >
                Create draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
