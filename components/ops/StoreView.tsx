// ShapesOS Phase 10 (store) — Online store view (/dashboard/ops/store).
// The workspace's public storefront: settings and publish switch (OpsStore),
// which products it sells (OpsStoreListing), a link to the live store and
// the latest web orders. Every write goes through the generic
// /api/ops/{stores,store-listings} routes (editor+, audited); the page
// re-renders from the server after each change.

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, ImagePlus, Loader2, Pencil, Plus, ShoppingBag } from "lucide-react";
import { Switch } from "@/components/aos/Controls";
import {
  btnGhost,
  btnGhostSm,
  btnPrimary,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/crm/ui";
import type { StoreOverview } from "@/lib/ops/store/admin";
import { EmptyBlock, OpsModal, ViewHeader, fmtCents, fmtDate, opsJson, sentence, shortId } from "./shared";

interface ProductOpt {
  id: string;
  name: string;
  sku: string;
  active: boolean;
}

interface WebOrder {
  id: string;
  status: string;
  totalCents: number;
  customerEmail: string | null;
  promotionCode: string | null;
  paidAt: string | null;
  createdAt: string;
}

type Listing = StoreOverview["listings"][number];

function slugFrom(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
}

export function StoreView(props: {
  workspaceId: string;
  publicBase: string;
  overview: StoreOverview;
  products: ProductOpt[];
  taxRates: Array<{ id: string; name: string; rateBps: number }>;
  warehouses: Array<{ id: string; code: string; name: string }>;
  orders: WebOrder[];
  defaultCurrency: string;
}) {
  const { overview } = props;
  return (
    <div className="flex flex-col gap-5">
      <ViewHeader title="Online store" hint="A public shop for your products. Buyers pay with your own Stripe account; paid orders land in Orders with the web source.">
        {overview.store && (
          <span>
            Paid, last 30 days <span className="font-bold tabular-nums text-ink">{fmtCents(overview.webOrders.paidCents30d)}</span>
          </span>
        )}
      </ViewHeader>
      {overview.store ? <StoreAdmin {...props} store={overview.store} /> : <SetupStore defaultCurrency={props.defaultCurrency} />}
    </div>
  );
}

function SetupStore({ defaultCurrency }: { defaultCurrency: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = touched ? slug : slugFrom(name);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      await opsJson("/api/ops/stores", "POST", { name: name.trim(), slug: address, currency: defaultCurrency });
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the store.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl rounded-lg bg-paper p-5 shadow-hairline">
      <h2 className="text-[0.9375rem] font-bold text-ink">Set up your online store</h2>
      <p className="mt-1 text-[0.8125rem] text-muted">It stays unpublished until you switch it on.</p>
      <div className="mt-4 flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Store name</span>
          <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme goods" />
        </label>
        <label className="block">
          <span className={labelCls}>Address</span>
          <span className="flex items-center gap-1 font-mono text-[0.8125rem] text-muted">
            /shop/
            <input
              className={`${inputCls} min-w-0 flex-1 font-mono`}
              value={address}
              onChange={(e) => {
                setTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
              placeholder="acme-goods"
            />
          </span>
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div>
          <button type="button" className={btnPrimary} disabled={saving || !name.trim() || !address} onClick={create}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <ShoppingBag size={14} />} {saving ? "Creating" : "Create store"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StoreAdmin({
  workspaceId,
  publicBase,
  overview,
  products,
  taxRates,
  warehouses,
  orders,
  store,
}: Parameters<typeof StoreView>[0] & { store: NonNullable<StoreOverview["store"]> }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Listing | null>(null);
  const [addId, setAddId] = useState("");
  const shopUrl = `${publicBase}/shop/${store.slug}`;
  const listedIds = useMemo(() => new Set(overview.listings.map((l) => l.productId)), [overview.listings]);
  const addable = products.filter((p) => p.active && !listedIds.has(p.id));

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <div className={errorBoxCls}>{error}</div>}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper px-4 py-3 shadow-hairline">
        <div className="flex items-center gap-3">
          <span id="publish-label" className="text-[0.875rem] font-semibold text-ink">
            Published
          </span>
          <Switch
            checked={store.published}
            labelledBy="publish-label"
            disabled={busy !== null}
            onChange={(v) => run("publish", () => opsJson("/api/ops/stores", "PATCH", { id: store.id, published: v }))}
          />
          <span className="font-mono text-[0.8125rem] text-muted">/shop/{store.slug}</span>
        </div>
        {store.published ? (
          <a href={shopUrl} target="_blank" rel="noreferrer" className={btnGhostSm}>
            <ExternalLink size={13} /> Open store
          </a>
        ) : (
          <span className="text-[0.8125rem] text-muted">Unpublished stores aren&apos;t visible to anyone.</span>
        )}
      </section>

      {!overview.stripeConnected ? (
        <div className={noteBoxCls}>
          Checkout is off until you connect Stripe. Buyers see that the store can&apos;t take payments yet.{" "}
          <Link href="/dashboard/ops/accounting/settings" className="font-semibold underline">
            Connect Stripe in finance settings
          </Link>
        </div>
      ) : !overview.stripeWebhookConfigured ? (
        <div className={noteBoxCls}>
          Stripe is connected, but no webhook signing secret is saved: buyers can pay, yet paid orders won&apos;t be recorded.{" "}
          <Link href="/dashboard/ops/accounting/settings" className="font-semibold underline">
            Add the webhook secret
          </Link>
        </div>
      ) : null}

      <StoreSettings store={store} taxRates={taxRates} warehouses={warehouses} busy={busy} run={run} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[0.9375rem] font-bold text-ink">Products in the store</h2>
          <div className="flex items-center gap-2">
            <select className={selectCls} value={addId} onChange={(e) => setAddId(e.target.value)} aria-label="Product to add">
              <option value="">{addable.length ? "Choose a product…" : "Every active product is listed"}</option>
              {addable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </select>
            <button
              type="button"
              className={btnPrimary}
              disabled={!addId || busy !== null}
              onClick={() =>
                run("add", async () => {
                  await opsJson("/api/ops/store-listings", "POST", { storeId: store.id, productId: addId, position: overview.listings.length + 1 });
                  setAddId("");
                })
              }
            >
              {busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add to store
            </button>
          </div>
        </div>
        {overview.listings.length === 0 ? (
          <EmptyBlock icon={ShoppingBag} title="No products in the store yet" hint="Add a product above. Its price and stock come from Products & inventory." />
        ) : (
          <div className={tableWrapCls}>
            <table className={`${tableCls} min-w-[820px]`}>
              <thead>
                <tr>
                  <th className={thCls}>Product</th>
                  <th className={thCls}>Address</th>
                  <th className={`${thCls} text-right`}>Price</th>
                  <th className={`${thCls} text-right`}>On hand</th>
                  <th className={thCls}>Shown</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {overview.listings.map((l) => (
                  <tr key={l.id}>
                    <td className={tdCls}>
                      <span className="font-semibold">{l.title || l.productName}</span>
                      <span className="ml-1 font-mono text-[0.75rem] text-muted">{l.sku}</span>
                      {!l.productActive && <span className={`${chipCls} ml-1.5`}>Product inactive</span>}
                      {l.imageFileId && <span className={`${chipCls} ml-1.5`}>Image</span>}
                    </td>
                    <td className={`${tdCls} font-mono text-[0.75rem] text-muted`}>/p/{l.slug}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(l.priceCents)}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{l.trackInventory ? l.stockQty : "—"}</td>
                    <td className={tdCls}>
                      <Switch
                        checked={l.listed}
                        label={`Show ${l.productName} in the store`}
                        disabled={busy !== null}
                        onChange={(v) => run(`list-${l.id}`, () => opsJson("/api/ops/store-listings", "PATCH", { id: l.id, listed: v }))}
                      />
                    </td>
                    <td className={`${tdCls} text-right`}>
                      <button type="button" className={btnGhostSm} onClick={() => setEditing(l)}>
                        <Pencil size={13} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[0.9375rem] font-bold text-ink">Recent web orders</h2>
          <Link href="/dashboard/ops/orders" className={btnGhostSm}>
            All orders
          </Link>
        </div>
        {orders.length === 0 ? (
          <p className="text-[0.8125rem] text-muted">No web orders yet.</p>
        ) : (
          <div className={tableWrapCls}>
            <table className={`${tableCls} min-w-[680px]`}>
              <thead>
                <tr>
                  <th className={thCls}>Order</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Buyer</th>
                  <th className={`${thCls} text-right`}>Total</th>
                  <th className={thCls}>Paid</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className={`${tdCls} font-semibold`}>
                      SO-{shortId(o.id)}
                      {o.promotionCode && <span className="ml-1 font-mono text-[0.75rem] text-muted">{o.promotionCode}</span>}
                    </td>
                    <td className={tdCls}>
                      <span className={chipCls}>{o.status === "draft" ? "Awaiting payment" : sentence(o.status)}</span>
                    </td>
                    <td className={`${tdCls} text-muted`}>{o.customerEmail ?? "—"}</td>
                    <td className={`${tdCls} text-right font-semibold tabular-nums`}>{fmtCents(o.totalCents)}</td>
                    <td className={`${tdCls} text-muted`}>{o.paidAt ? fmtDate(o.paidAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && <ListingModal workspaceId={workspaceId} listing={editing} onClose={() => setEditing(null)} onSaved={() => router.refresh()} />}
    </>
  );
}

function StoreSettings({
  store,
  taxRates,
  warehouses,
  busy,
  run,
}: {
  store: NonNullable<StoreOverview["store"]>;
  taxRates: Array<{ id: string; name: string; rateBps: number }>;
  warehouses: Array<{ id: string; code: string; name: string }>;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [f, setF] = useState({
    name: store.name,
    slug: store.slug,
    description: store.description ?? "",
    currency: store.currency,
    taxRateId: store.taxRateId ?? "",
    warehouseId: store.warehouseId ?? "",
    contactEmail: store.contactEmail ?? "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <section className="rounded-lg bg-paper p-4 shadow-hairline">
      <h2 className="mb-3 text-[0.9375rem] font-bold text-ink">Store settings</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block">
          <span className={labelCls}>Store name</span>
          <input className={`${inputCls} w-full`} value={f.name} onChange={set("name")} />
        </label>
        <label className="block">
          <span className={labelCls}>Address (/shop/…)</span>
          <input className={`${inputCls} w-full font-mono`} value={f.slug} onChange={set("slug")} />
        </label>
        <label className="block md:col-span-2">
          <span className={labelCls}>Description</span>
          <textarea className={`${inputCls} h-20 w-full py-2`} value={f.description} onChange={set("description")} />
        </label>
        <label className="block">
          <span className={labelCls}>Currency</span>
          <input className={`${inputCls} w-full font-mono uppercase`} value={f.currency} onChange={set("currency")} maxLength={3} />
        </label>
        <label className="block">
          <span className={labelCls}>Sales tax</span>
          <select className={`${selectCls} w-full`} value={f.taxRateId} onChange={set("taxRateId")}>
            <option value="">No tax</option>
            {taxRates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({(t.rateBps / 100).toFixed(2)}%)
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Ship from</span>
          <select className={`${selectCls} w-full`} value={f.warehouseId} onChange={set("warehouseId")}>
            <option value="">Any location</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} · {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>Contact email (shown in the footer)</span>
          <input className={`${inputCls} w-full`} value={f.contactEmail} onChange={set("contactEmail")} type="email" />
        </label>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          className={btnPrimary}
          disabled={busy !== null || !f.name.trim() || !f.slug.trim()}
          onClick={() =>
            run("settings", () =>
              opsJson("/api/ops/stores", "PATCH", {
                id: store.id,
                name: f.name.trim(),
                slug: f.slug.trim(),
                description: f.description.trim() || null,
                currency: f.currency.trim().toUpperCase(),
                taxRateId: f.taxRateId || null,
                warehouseId: f.warehouseId || null,
                contactEmail: f.contactEmail.trim() || null,
              }),
            )
          }
        >
          {busy === "settings" && <Loader2 size={14} className="animate-spin" />} {busy === "settings" ? "Saving" : "Save settings"}
        </button>
      </div>
    </section>
  );
}

function ListingModal({ workspaceId, listing, onClose, onSaved }: { workspaceId: string; listing: Listing; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(listing.title ?? "");
  const [slug, setSlug] = useState(listing.slug);
  const [description, setDescription] = useState(listing.description ?? "");
  const [imageFileId, setImageFileId] = useState<string | null>(listing.imageFileId);
  const [imageName, setImageName] = useState<string | null>(listing.imageFileId ? "Current image" : null);
  const [busy, setBusy] = useState<"upload" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy("upload");
    setError(null);
    try {
      const form = new FormData();
      form.set("workspaceId", workspaceId);
      form.set("path", `/files/store/${Date.now()}`);
      form.set("file", file);
      const r = await fetch("/api/files", { method: "POST", body: form });
      const d = (await r.json().catch(() => ({}))) as { file?: { id: string; filename: string; mimeType: string }; error?: string };
      if (!r.ok || !d.file) throw new Error(d.error ?? "The image didn't upload.");
      setImageFileId(d.file.id);
      setImageName(d.file.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The image didn't upload.");
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy("save");
    setError(null);
    try {
      await opsJson("/api/ops/store-listings", "PATCH", {
        id: listing.id,
        title: title.trim() || null,
        slug: slug.trim(),
        description: description.trim() || null,
        imageFileId,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <OpsModal title={`Edit ${listing.productName}`} onClose={onClose} wide>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Title in the store (empty = product name)</span>
          <input className={`${inputCls} w-full`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={listing.productName} />
        </label>
        <label className="block">
          <span className={labelCls}>Address (/p/…)</span>
          <input className={`${inputCls} w-full font-mono`} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        </label>
        <label className="block">
          <span className={labelCls}>Description</span>
          <textarea className={`${inputCls} h-32 w-full py-2`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`${btnGhost} cursor-pointer`}>
            {busy === "upload" ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />} {imageFileId ? "Replace image" : "Upload image"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </label>
          {imageName && <span className="text-[0.8125rem] text-muted">{imageName}</span>}
          {imageFileId && (
            <button type="button" className={btnGhostSm} onClick={() => { setImageFileId(null); setImageName(null); }}>
              Remove image
            </button>
          )}
        </div>
        <p className="text-[0.8125rem] text-muted">Price and stock come from the product ({listing.sku}) in Products &amp; inventory.</p>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy !== null || !slug.trim()} onClick={save}>
            {busy === "save" && <Loader2 size={14} className="animate-spin" />} {busy === "save" ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
