// ShapesOS Phase 11 (seotools): schema.org JSON-LD — generate, validate,
// inject (PURE: no I/O).
//
//   generateJsonLd(type, input)   Organization, WebSite, LocalBusiness,
//                                 Product, Article, FAQPage, BreadcrumbList
//   validateJsonLd(value)         required / recommended properties per type
//                                 (Google rich-result requirements), @graph
//                                 aware; validateJsonLdText adds JSON validity
//   injectJsonLd(html, blocks)    writes <script type="application/ld+json"
//                                 data-shapes="jsonld"> into <head>, replacing
//                                 the blocks it injected before (idempotent);
//                                 hand-written JSON-LD is never touched
//   suggestJsonLdForPage(…)       what a SiteBuilder page should carry, from
//                                 site / project data (home: Organization +
//                                 WebSite; inner pages: BreadcrumbList; FAQ
//                                 markup from <details><summary> pairs)
//
// The validator powers the "invalid-structured-data" audit check
// (lib/audit/structured-data.ts); the injector is only ever applied through
// a site DRAFT revision (lib/seo/jsonld-draft.ts) — never straight to live.

export const JSONLD_TYPES = ["Organization", "WebSite", "LocalBusiness", "Product", "Article", "FAQPage", "BreadcrumbList"] as const;
export type JsonLdType = (typeof JSONLD_TYPES)[number];
export type JsonLd = Record<string, unknown>;

export function isJsonLdType(v: unknown): v is JsonLdType {
  return typeof v === "string" && (JSONLD_TYPES as readonly string[]).includes(v);
}

const CONTEXT = "https://schema.org";

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface PostalAddressInput {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
}

export interface JsonLdInput {
  name?: string;
  url?: string;
  description?: string;
  logo?: string;
  image?: string | string[];
  sameAs?: string[];
  email?: string;
  telephone?: string;
  /** WebSite: e.g. "https://acme.example/search?q={search_term_string}". */
  searchUrlTemplate?: string;
  /** LocalBusiness: a more specific schema.org type, e.g. "Plumber", "Restaurant". */
  businessType?: string;
  address?: PostalAddressInput;
  geo?: { latitude: number; longitude: number };
  openingHours?: string[];
  priceRange?: string;
  /** Product */
  sku?: string;
  brand?: string;
  offers?: { price: number | string; priceCurrency: string; availability?: string; url?: string };
  aggregateRating?: { ratingValue: number; reviewCount: number };
  /** Article */
  headline?: string;
  authorName?: string;
  datePublished?: string;
  dateModified?: string;
  publisherName?: string;
  publisherLogo?: string;
  /** FAQPage */
  questions?: { question: string; answer: string }[];
  /** BreadcrumbList */
  items?: { name: string; url: string }[];
}

function clean<T extends JsonLd>(o: T): T {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete o[k];
  }
  return o;
}

function postalAddress(a: PostalAddressInput | undefined): JsonLd | undefined {
  if (!a) return undefined;
  const out = clean({ "@type": "PostalAddress", ...a } as JsonLd);
  return Object.keys(out).length > 1 ? out : undefined;
}

const AVAILABILITY = new Set(["InStock", "OutOfStock", "PreOrder", "BackOrder", "Discontinued", "LimitedAvailability", "OnlineOnly", "SoldOut"]);

/** Build a JSON-LD object for one schema.org type. Throws on input that can't make a valid block. */
export function generateJsonLd(type: JsonLdType, input: JsonLdInput): JsonLd {
  switch (type) {
    case "Organization":
      return clean({ "@context": CONTEXT, "@type": "Organization", name: input.name, url: input.url, logo: input.logo, description: input.description, email: input.email, telephone: input.telephone, sameAs: input.sameAs });
    case "WebSite":
      return clean({
        "@context": CONTEXT,
        "@type": "WebSite",
        name: input.name,
        url: input.url,
        potentialAction: input.searchUrlTemplate
          ? { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: input.searchUrlTemplate }, "query-input": "required name=search_term_string" }
          : undefined,
      });
    case "LocalBusiness":
      return clean({
        "@context": CONTEXT,
        "@type": input.businessType && /^[A-Z][A-Za-z]+$/.test(input.businessType) ? input.businessType : "LocalBusiness",
        name: input.name,
        url: input.url,
        image: input.image,
        telephone: input.telephone,
        email: input.email,
        priceRange: input.priceRange,
        address: postalAddress(input.address),
        geo: input.geo ? { "@type": "GeoCoordinates", latitude: input.geo.latitude, longitude: input.geo.longitude } : undefined,
        openingHours: input.openingHours,
        sameAs: input.sameAs,
      });
    case "Product": {
      const offers = input.offers
        ? clean({
            "@type": "Offer",
            price: String(input.offers.price),
            priceCurrency: input.offers.priceCurrency?.toUpperCase(),
            availability: input.offers.availability
              ? `https://schema.org/${AVAILABILITY.has(input.offers.availability) ? input.offers.availability : "InStock"}`
              : undefined,
            url: input.offers.url,
          } as JsonLd)
        : undefined;
      return clean({
        "@context": CONTEXT,
        "@type": "Product",
        name: input.name,
        description: input.description,
        image: input.image,
        sku: input.sku,
        brand: input.brand ? { "@type": "Brand", name: input.brand } : undefined,
        offers,
        aggregateRating: input.aggregateRating
          ? { "@type": "AggregateRating", ratingValue: input.aggregateRating.ratingValue, reviewCount: input.aggregateRating.reviewCount }
          : undefined,
      });
    }
    case "Article":
      return clean({
        "@context": CONTEXT,
        "@type": "Article",
        headline: input.headline ?? input.name,
        description: input.description,
        image: input.image,
        author: input.authorName ? { "@type": "Person", name: input.authorName } : undefined,
        datePublished: input.datePublished,
        dateModified: input.dateModified,
        mainEntityOfPage: input.url ? { "@type": "WebPage", "@id": input.url } : undefined,
        publisher: input.publisherName
          ? clean({ "@type": "Organization", name: input.publisherName, logo: input.publisherLogo ? { "@type": "ImageObject", url: input.publisherLogo } : undefined } as JsonLd)
          : undefined,
      });
    case "FAQPage":
      return {
        "@context": CONTEXT,
        "@type": "FAQPage",
        mainEntity: (input.questions ?? [])
          .filter((q) => q.question?.trim() && q.answer?.trim())
          .map((q) => ({ "@type": "Question", name: q.question.trim(), acceptedAnswer: { "@type": "Answer", text: q.answer.trim() } })),
      };
    case "BreadcrumbList":
      return {
        "@context": CONTEXT,
        "@type": "BreadcrumbList",
        itemListElement: (input.items ?? []).map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
      };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface JsonLdIssue {
  severity: "error" | "warning";
  /** Where in the document, e.g. "Product.offers.price" or "@graph[1]". */
  path: string;
  message: string;
}

const LOCAL_BUSINESS_SUBTYPES = /^(LocalBusiness|Store|Restaurant|Plumber|Dentist|Electrician|AutoRepair|LegalService|MedicalBusiness|HomeAndConstructionBusiness|ProfessionalService|FoodEstablishment|HealthAndBeautyBusiness|LodgingBusiness|RealEstateAgent|FinancialService|SportsActivityLocation|EntertainmentBusiness|AutomotiveBusiness|ChildCare|EmergencyService|GovernmentOffice|Library|RecyclingCenter|SelfStorage|ShoppingCenter|TouristInformationCenter|TravelAgency|AnimalShelter|DryCleaningOrLaundry|EmploymentAgency|InternetCafe|RadioStation|TelevisionStation|Bakery|CafeOrCoffeeShop|BarOrPub|Hotel|Motel|HairSalon|DaySpa|Locksmith|RoofingContractor|HVACBusiness|GeneralContractor|HousePainter|MovingCompany|Attorney|Notary|Optician|Pharmacy|Physician|VeterinaryCare|ExerciseGym|AccountingService|InsuranceAgency|AutoDealer|BikeStore|BookStore|ClothingStore|ComputerStore|ElectronicsStore|Florist|FurnitureStore|GardenStore|GroceryStore|HardwareStore|HomeGoodsStore|JewelryStore|LiquorStore|MensClothingStore|MobilePhoneStore|MovieRentalStore|MusicStore|OfficeEquipmentStore|OutletStore|PawnShop|PetStore|ShoeStore|SportingGoodsStore|TireShop|ToyStore|WholesaleStore)$/;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

function typesOf(node: JsonLd): string[] {
  return asArray(node["@type"]).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^https?:\/\/schema\.org\//, ""));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isUrlish(v: unknown): boolean {
  const s = str(v);
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function imageOk(v: unknown): boolean {
  return asArray(v).some((x) => isUrlish(x) || (x && typeof x === "object" && isUrlish((x as JsonLd).url)));
}

function validateNode(node: JsonLd, path: string, issues: JsonLdIssue[], topLevel: boolean): void {
  const err = (p: string, message: string) => issues.push({ severity: "error", path: `${path}${p}`, message });
  const warn = (p: string, message: string) => issues.push({ severity: "warning", path: `${path}${p}`, message });
  const types = typesOf(node);
  if (topLevel) {
    const ctx = node["@context"];
    const ctxStr = typeof ctx === "string" ? ctx : Array.isArray(ctx) ? ctx.find((c) => typeof c === "string") : (ctx as JsonLd | undefined)?.["@vocab"];
    if (!(typeof ctxStr === "string" && /^https?:\/\/schema\.org\/?$/.test(ctxStr))) {
      err("@context", '@context must be "https://schema.org".');
    }
  }
  if (types.length === 0) {
    err("@type", "Every structured-data node needs an @type.");
    return;
  }
  const type = types[0];
  const p = (k: string) => `.${k}`;

  if (type === "Organization" || type === "Corporation" || type === "NGO") {
    if (!str(node.name)) err(p("name"), `${type} needs a name.`);
    if (!isUrlish(node.url)) warn(p("url"), `${type} should have an absolute url.`);
    if (node.logo !== undefined && !imageOk(node.logo)) err(p("logo"), "logo must be an absolute image URL.");
  } else if (type === "WebSite") {
    if (!str(node.name)) err(p("name"), "WebSite needs a name.");
    if (!isUrlish(node.url)) err(p("url"), "WebSite needs an absolute url.");
    for (const a of asArray(node.potentialAction)) {
      const act = a as JsonLd;
      if (typesOf(act)[0] !== "SearchAction") continue;
      const target = act.target as JsonLd | string | undefined;
      const tpl = typeof target === "string" ? target : str((target as JsonLd | undefined)?.urlTemplate);
      if (!tpl || !tpl.includes("{search_term_string}")) err(p("potentialAction.target"), "SearchAction target must be a URL template containing {search_term_string}.");
      if (!str(act["query-input"])) err(p("potentialAction.query-input"), 'SearchAction needs "query-input": "required name=search_term_string".');
    }
  } else if (LOCAL_BUSINESS_SUBTYPES.test(type)) {
    if (!str(node.name)) err(p("name"), `${type} needs a name.`);
    const addr = node.address;
    if (!addr) err(p("address"), `${type} needs an address.`);
    else if (typeof addr === "object") {
      const a = addr as JsonLd;
      if (!str(a.streetAddress) && !str(a.addressLocality)) err(p("address"), "address needs at least streetAddress or addressLocality.");
    }
    if (!str(node.telephone)) warn(p("telephone"), `${type} should have a telephone.`);
    if (node.geo && typeof node.geo === "object") {
      const g = node.geo as JsonLd;
      const lat = Number(g.latitude);
      const lng = Number(g.longitude);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) err(p("geo"), "geo latitude/longitude are out of range.");
    }
  } else if (type === "Product") {
    if (!str(node.name)) err(p("name"), "Product needs a name.");
    if (!node.offers && !node.review && !node.aggregateRating) {
      err(p("offers"), "Product needs offers, review or aggregateRating to be eligible for rich results.");
    }
    asArray(node.offers).forEach((o, i) => {
      const off = o as JsonLd;
      const op = `.offers${Array.isArray(node.offers) ? `[${i}]` : ""}`;
      if (typesOf(off)[0] === "AggregateOffer") {
        if (off.lowPrice === undefined) err(`${op}.lowPrice`, "AggregateOffer needs lowPrice.");
      } else if (off.price === undefined || off.price === "" || !Number.isFinite(Number(off.price))) {
        err(`${op}.price`, "Offer needs a numeric price.");
      }
      if (!str(off.priceCurrency) || !/^[A-Z]{3}$/.test(String(off.priceCurrency))) err(`${op}.priceCurrency`, "Offer needs a 3-letter ISO 4217 priceCurrency.");
    });
    if (node.aggregateRating && typeof node.aggregateRating === "object") {
      const r = node.aggregateRating as JsonLd;
      if (!Number.isFinite(Number(r.ratingValue))) err(p("aggregateRating.ratingValue"), "aggregateRating needs a numeric ratingValue.");
      if (!(Number(r.reviewCount) > 0) && !(Number(r.ratingCount) > 0)) err(p("aggregateRating.reviewCount"), "aggregateRating needs reviewCount or ratingCount.");
    }
    if (node.image === undefined) warn(p("image"), "Product should have an image.");
  } else if (type === "Article" || type === "NewsArticle" || type === "BlogPosting") {
    const headline = str(node.headline);
    if (!headline) err(p("headline"), `${type} needs a headline.`);
    else if (headline.length > 110) warn(p("headline"), "headline is longer than 110 characters.");
    if (!node.author) warn(p("author"), `${type} should name an author.`);
    if (!node.image) warn(p("image"), `${type} should have an image.`);
    for (const k of ["datePublished", "dateModified"] as const) {
      if (node[k] === undefined) {
        if (k === "datePublished") warn(p(k), `${type} should have datePublished.`);
      } else if (!ISO_DATE.test(String(node[k]))) err(p(k), `${k} must be an ISO 8601 date.`);
    }
  } else if (type === "FAQPage") {
    const qs = asArray(node.mainEntity);
    if (qs.length === 0) err(p("mainEntity"), "FAQPage needs at least one Question in mainEntity.");
    qs.forEach((q, i) => {
      const qq = q as JsonLd;
      const qp = `.mainEntity[${i}]`;
      if (typesOf(qq)[0] !== "Question") err(`${qp}.@type`, "FAQPage mainEntity items must be Question.");
      if (!str(qq.name)) err(`${qp}.name`, "Question needs a name (the question text).");
      const ans = qq.acceptedAnswer as JsonLd | undefined;
      if (!ans || !str(ans.text)) err(`${qp}.acceptedAnswer`, "Question needs acceptedAnswer.text.");
    });
  } else if (type === "BreadcrumbList") {
    const items = asArray(node.itemListElement);
    if (items.length === 0) err(p("itemListElement"), "BreadcrumbList needs itemListElement.");
    items.forEach((it, i) => {
      const li = it as JsonLd;
      const ip = `.itemListElement[${i}]`;
      if (!Number.isInteger(Number(li.position)) || Number(li.position) < 1) err(`${ip}.position`, "ListItem needs a positive integer position.");
      const item = li.item as JsonLd | string | undefined;
      const name = str(li.name) ?? (item && typeof item === "object" ? str(item.name) : null);
      if (!name) err(`${ip}.name`, "ListItem needs a name.");
      const isLast = i === items.length - 1;
      const itemUrl = typeof item === "string" ? item : item && typeof item === "object" ? (item["@id"] as string | undefined) : undefined;
      if (!isLast && !isUrlish(itemUrl)) err(`${ip}.item`, "Every ListItem except the last needs an absolute item URL.");
    });
  }
}

/** Validate a parsed JSON-LD value (object, array of objects, or @graph). */
export function validateJsonLd(value: unknown): JsonLdIssue[] {
  const issues: JsonLdIssue[] = [];
  const roots = Array.isArray(value) ? value : [value];
  roots.forEach((root, ri) => {
    const rp = Array.isArray(value) ? `[${ri}]` : "";
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      issues.push({ severity: "error", path: rp || "$", message: "JSON-LD must be an object (or an array of objects)." });
      return;
    }
    const node = root as JsonLd;
    if (Array.isArray(node["@graph"])) {
      const ctx = node["@context"];
      (node["@graph"] as unknown[]).forEach((g, gi) => {
        if (!g || typeof g !== "object") {
          issues.push({ severity: "error", path: `${rp}@graph[${gi}]`, message: "@graph entries must be objects." });
          return;
        }
        validateNode({ "@context": ctx, ...(g as JsonLd) }, `${rp}@graph[${gi}]`, issues, true);
      });
      return;
    }
    validateNode(node, rp, issues, true);
  });
  return issues;
}

/** JSON validity + validateJsonLd for a raw script body. */
export function validateJsonLdText(raw: string): JsonLdIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [{ severity: "error", path: "$", message: `Not valid JSON (${err instanceof Error ? err.message.slice(0, 100) : "parse error"}).` }];
  }
  return validateJsonLd(parsed);
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

const MARKER = 'data-shapes="jsonld"';
const OUR_BLOCK = /[ \t]*<script\b[^>]*data-shapes=["']jsonld["'][^>]*>[\s\S]*?<\/script\s*>\n?/gi;

/** Serialize for a <script> body: `</` and U+2028/9 escaped so content can't end the tag. */
export function serializeJsonLd(block: JsonLd): string {
  return JSON.stringify(block, null, 2)
    .replace(/<\//g, "<\\/")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Put `blocks` into the page's <head> as our own JSON-LD scripts, replacing
 * the ones we injected earlier. Hand-written JSON-LD is left alone. With no
 * blocks it only removes ours. Returns the page unchanged when nothing moves.
 */
export function injectJsonLd(html: string, blocks: JsonLd[]): string {
  const stripped = html.replace(OUR_BLOCK, "");
  if (blocks.length === 0) return stripped;
  const scripts = blocks.map((b) => `<script type="application/ld+json" ${MARKER}>\n${serializeJsonLd(b)}\n</script>`).join("\n");
  if (/<\/head\s*>/i.test(stripped)) return stripped.replace(/<\/head\s*>/i, `${scripts}\n</head>`);
  if (/<html\b[^>]*>/i.test(stripped)) return stripped.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>\n${scripts}\n</head>`);
  return `<head>\n${scripts}\n</head>\n${stripped}`;
}

/** JSON-LD we injected earlier into this page (parsed; unparseable ones dropped). */
export function injectedJsonLd(html: string): JsonLd[] {
  const out: JsonLd[] = [];
  for (const m of html.matchAll(/<script\b[^>]*data-shapes=["']jsonld["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      out.push(JSON.parse(m[1]) as JsonLd);
    } catch {
      // ignore
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suggestions from site / project data
// ---------------------------------------------------------------------------

export interface SiteIdentity {
  /** Organization / site name (workspace or site name). */
  name: string;
  /** Absolute origin, e.g. "https://acme.example". */
  origin: string;
  logo?: string | null;
  sameAs?: string[];
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Page URL path for a working-copy file ("/blog/index.html" → "/blog/", "/about.html" → "/about"). */
export function urlPathForFile(filePath: string): string {
  if (/(^|\/)index\.html?$/i.test(filePath)) return filePath.replace(/index\.html?$/i, "") || "/";
  return filePath.replace(/\.html?$/i, "");
}

function titleCase(seg: string): string {
  const s = decodeURIComponent(seg).replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : seg;
}

/** FAQ pairs from <details><summary>Q</summary>A</details> markup. */
export function extractFaqPairs(html: string): { question: string; answer: string }[] {
  const out: { question: string; answer: string }[] = [];
  for (const m of html.matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>([\s\S]*?)<\/details\s*>/gi)) {
    const question = stripTags(m[1]);
    const answer = stripTags(m[2]);
    if (question && answer) out.push({ question, answer });
  }
  return out;
}

/**
 * The JSON-LD a SiteBuilder page should carry, derived from the site's own
 * data. Pure and deterministic: the same page and identity give the same
 * blocks (so re-running the injector is a no-op).
 */
export function suggestJsonLdForPage(filePath: string, html: string, site: SiteIdentity): JsonLd[] {
  const origin = site.origin.replace(/\/+$/, "");
  const urlPath = urlPathForFile(filePath);
  const blocks: JsonLd[] = [];
  if (urlPath === "/") {
    blocks.push(generateJsonLd("Organization", { name: site.name, url: `${origin}/`, logo: site.logo ?? undefined, sameAs: site.sameAs }));
    blocks.push(generateJsonLd("WebSite", { name: site.name, url: `${origin}/` }));
  } else {
    const segs = urlPath.split("/").filter(Boolean);
    const pageTitle = stripTags(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ?? "") || stripTags(/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "");
    const items = [{ name: site.name, url: `${origin}/` }];
    let acc = "";
    segs.forEach((seg, i) => {
      acc += `/${seg}`;
      const last = i === segs.length - 1;
      items.push({ name: last && pageTitle ? pageTitle.slice(0, 110) : titleCase(seg), url: `${origin}${acc}${last && urlPath.endsWith("/") ? "/" : ""}` });
    });
    blocks.push(generateJsonLd("BreadcrumbList", { items }));
  }
  const faqs = extractFaqPairs(html);
  if (faqs.length) blocks.push(generateJsonLd("FAQPage", { questions: faqs }));
  return blocks;
}
