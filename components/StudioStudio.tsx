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
          className={`mb-4 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm ${fade} ${
            notice.kind === "ok"
              ? "bg-paper text-ink shadow-hairline"
              : "bg-failed-tint text-failed-text"
          }`}
        >
          {notice.kind === "ok" ? <Check className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
          {notice.text}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition-colors ${press} ${
              tab === t.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
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
            <p className="mb-4 rounded-lg bg-paper px-4 py-2.5 text-sm text-ink shadow-hairline">
              Domain purchasing needs an owner or admin role. Availability search and the domain list
              are still visible.
            </p>
          )}

          {/* Porkbun keys */}
          {isOwnerAdmin && (
            <div className="mb-6 rounded-lg bg-paper p-5 shadow-hairline">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
                <Settings className="h-4 w-4" /> Porkbun API keys
              </h3>
              <p className="mb-4 text-sm text-muted">
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
                  className="w-56 rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
                />
                <input
                  name="secretApiKey"
                  type="password"
                  placeholder="Secret API key"
                  autoComplete="off"
                  className="w-56 rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className={`rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
                >
                  Save keys
                </button>
              </form>
            </div>
          )}

          {/* Search */}
          {porkbunConfigured && (
            <div className="mb-6 rounded-lg bg-paper p-5 shadow-hairline">
              <h3 className="mb-3 text-sm font-semibold text-ink">Check availability</h3>
              <div className="flex gap-2">
                <input
                  value={searchDomain}
                  onChange={(e) => setSearchDomain(e.target.value)}
                  placeholder="yourdomain.com"
                  className="flex-1 rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
                />
                <button
                  onClick={searchAvailability}
                  disabled={busy || !searchDomain.trim()}
                  className={`rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
                >
                  Search
                </button>
              </div>
              {searchResult && (
                <div className="mt-4 rounded-lg border border-line p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink">{searchResult.domain}</span>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        searchResult.available
                          ? "bg-ink text-white"
                          : "bg-canvas text-muted"
                      }`}
                    >
                      {searchResult.available ? "Available" : "Taken"}
                    </span>
                  </div>
                  {searchResult.available && searchResult.priceUsd != null && (
                    <div className="mt-2 text-sm text-muted">
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
                      className={`mt-3 rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
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
            <div className="mb-6 rounded-lg bg-paper p-5 shadow-hairline">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
                <TriangleAlert className="h-4 w-4" /> Confirm purchase
              </h3>
              <p className="mb-1 text-lg font-semibold text-ink">{preview.domain}</p>
              <p className="mb-3 text-sm text-muted">
                ${preview.priceUsd?.toFixed(2)}/yr registration
                {preview.renewalPriceUsd != null && ` · $${preview.renewalPriceUsd.toFixed(2)}/yr renewal`}
              </p>
              <p className="mb-2 text-xs font-semibold text-muted">Registrant</p>
              <p className="mb-3 text-sm text-muted">
                {preview.registrant.firstName} {preview.registrant.lastName} · {preview.registrant.email} ·{" "}
                {preview.registrant.address}, {preview.registrant.city} {preview.registrant.zip},{" "}
                {preview.registrant.country}
              </p>
              <p className="mb-4 rounded-lg border border-line bg-canvas p-3 text-xs leading-relaxed text-muted">
                {preview.icannDisclosure}
              </p>
              <label className="mb-4 flex cursor-pointer items-start gap-2 text-sm text-muted">
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
                  className={`rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Confirm purchase"}
                </button>
                <button
                  onClick={() => setPreview(null)}
                  className={`rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-outline aos-press`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Registrant */}
          {isOwnerAdmin && (
            <div className="mb-6 rounded-lg bg-paper p-5 shadow-hairline">
              <h3 className="mb-1 text-sm font-semibold text-ink">Registrant contact</h3>
              <p className="mb-4 text-sm text-muted">
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
                    className="rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
                  />
                ))}
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className={`rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-outline aos-press`}
                  >
                    Save registrant
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Domain list */}
          <h3 className="mb-3 text-sm font-semibold text-muted">
            Project domains
          </h3>
          {domains.length === 0 ? (
            <p className="rounded-lg border border-dashed border-control p-8 text-center text-sm text-muted">
              No domains yet. Search above to register one through Porkbun.
            </p>
          ) : (
            <div className="grid gap-3">
              {domains.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper p-4 shadow-hairline"
                >
                  <div>
                    <p className="font-medium text-ink">{d.domain}</p>
                    <p className="text-xs text-muted">
                      {d.status}
                      {d.priceUsd != null && ` · $${d.priceUsd.toFixed(2)}`}
                      {d.purchasedAt && ` · bought ${new Date(d.purchasedAt).toLocaleDateString()}`}
                      {d.nameServers.length > 0 && ` · ${d.nameServers.join(", ")}`}
                    </p>
                    {d.errorDetail && <p className="text-xs text-failed-text">{d.errorDetail}</p>}
                  </div>
                  <span
                    className={`inline-flex h-badge items-center gap-1.5 rounded-full px-2.5 text-sm font-semibold ${
                      d.status === "registered"
                        ? "bg-done text-white"
                        : d.status === "failed"
                          ? "bg-failed text-white"
                          : "bg-canvas text-muted"
                    }`}
                  >
                    {(d.status === "registered" || d.status === "failed") && (
                      <span
                        aria-hidden
                        className={`aos-shape ${d.status === "registered" ? "aos-shape--done" : "aos-shape--failed"}`}
                        style={{ color: "inherit" }}
                      />
                    )}
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
            <form onSubmit={addAsset} className="mb-6 flex flex-wrap gap-2 rounded-lg bg-paper p-4 shadow-hairline">
              <input
                value={newAssetName}
                onChange={(e) => setNewAssetName(e.target.value)}
                placeholder="Name"
                className="w-48 rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
              />
              <input
                value={newAssetUrl}
                onChange={(e) => setNewAssetUrl(e.target.value)}
                placeholder="https://… image or file URL"
                className="flex-1 rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
              />
              <button
                type="submit"
                disabled={busy || !newAssetUrl.trim()}
                className={`rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
              >
                Add asset
              </button>
            </form>
          )}
          {assets.length === 0 ? (
            <p className="rounded-lg border border-dashed border-control p-8 text-center text-sm text-muted">
              No assets yet. Add a URL below.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map((a) => (
                <div key={a.id} className="rounded-lg bg-paper p-4 shadow-hairline">
                  <div className="mb-3 flex h-32 items-center justify-center overflow-hidden rounded-lg bg-paper outline outline-1 outline-[oklch(0_0_0/0.1)]">
                    {a.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.url) ? (
                      <img src={a.url} alt={a.name} className="max-h-full object-contain" />
                    ) : (
                      <ImageIcon className="h-8 w-8 text-muted" />
                    )}
                  </div>
                  <p className="text-sm font-medium text-ink">{a.name}</p>
                  <p className="mb-3 text-xs capitalize text-muted">{a.source}</p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex items-center gap-1 rounded-full bg-paper px-3 py-1.5 text-xs font-semibold text-ink shadow-control hover:shadow-outline aos-press`}
                    >
                      <Link className="h-3 w-3" /> Open
                    </a>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => void openUseInSocial(a)}
                          className={`inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
                        >
                          <Send className="h-3 w-3" /> Use in social post
                        </button>
                        <button
                          onClick={() => deleteAsset(a.id)}
                          className={`rounded-full bg-paper px-3 py-1.5 text-xs text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint aos-press`}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`w-full max-w-sm rounded-lg bg-paper p-6 shadow-overlay ${fade}`}>
            <h3 className="text-base font-semibold text-ink">Delete this asset?</h3>
            <p className="mt-1 text-sm text-muted">
              This removes it from the asset library. Posts already using it keep their copy.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className={`rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-outline aos-press`}
              >
                Cancel
              </button>
              <button
                onClick={doDeleteAsset}
                disabled={busy}
                className={`rounded-full bg-paper px-4 py-2 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] hover:bg-failed-tint aos-press`}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Use in social post */}
      {socialAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className={`w-full max-w-lg rounded-lg bg-paper p-6 shadow-overlay ${fade}`}>
            <h3 className="text-base font-semibold text-ink">Use in social post</h3>
            <p className="mt-1 text-xs text-muted">
              Creates a Postiz draft with “{socialAsset.name}” — publish it from the Social tab.
            </p>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-muted">Post text</span>
              <textarea
                value={socialText}
                onChange={(e) => setSocialText(e.target.value)}
                rows={4}
                placeholder="Write the post…"
                className="w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-sm text-ink"
              />
            </label>
            <div className="mt-4">
              <span className="mb-1 block text-xs font-medium text-muted">Postiz channels</span>
              {postizChannelsLoading ? (
                <p className="text-xs text-muted">Loading channels…</p>
              ) : postizChannels.length === 0 ? (
                <p className="text-xs text-muted">No Postiz channels connected — connect one under Social first.</p>
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
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                        socialChannelIds.includes(ch.id)
                          ? "bg-ink text-white"
                          : "bg-paper text-ink shadow-control hover:shadow-outline"
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
                className={`rounded-full bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-outline aos-press`}
              >
                Cancel
              </button>
              <button
                onClick={submitUseInSocial}
                disabled={busy || socialChannelIds.length === 0}
                className={`rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white aos-press disabled:bg-disabled disabled:text-disabled-fg`}
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
