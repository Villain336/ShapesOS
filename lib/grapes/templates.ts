// Marketr — Phase 12 (Worker 1): GrapesJS seed templates.
// 6 landing-page templates + 2 email templates. Templates carry brand tokens
// ({{brand.primary}} etc.) that the editor substitutes with the tenant's
// brand-kit colors/fonts at load time; the DEFAULT_BRAND values keep them
// renderable when no brand kit exists. Landing templates use class-based CSS
// (parsed into GrapesJS's Style Manager); email templates are table-based with
// inline styles (email-client safe; the newsletter preset inlines on export).

export type GrapesTemplateKind = "landing" | "email";

export interface GrapesTemplate {
  key: string;
  name: string;
  kind: GrapesTemplateKind;
  category: string;
  description: string;
  html: string;
  css: string;
}

export const BRAND_TOKENS = [
  "{{brand.primary}}",
  "{{brand.secondary}}",
  "{{brand.accent}}",
  "{{brand.text}}",
  "{{brand.headingFont}}",
  "{{brand.bodyFont}}",
] as const;

export interface BrandPalette {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  headingFont: string;
  bodyFont: string;
}

export const DEFAULT_BRAND: BrandPalette = {
  primary: "#6d28d9",
  secondary: "#ede9fe",
  accent: "#8b5cf6",
  text: "#1c1917",
  headingFont: "Inter, system-ui, sans-serif",
  bodyFont: "Inter, system-ui, sans-serif",
};

/** Replace {{brand.*}} tokens in a template with a real palette. */
export function applyBrand(html: string, css: string, brand: Partial<BrandPalette> = {}): { html: string; css: string } {
  const b: BrandPalette = { ...DEFAULT_BRAND, ...brand };
  const map: Record<string, string> = {
    "{{brand.primary}}": b.primary,
    "{{brand.secondary}}": b.secondary,
    "{{brand.accent}}": b.accent,
    "{{brand.text}}": b.text,
    "{{brand.headingFont}}": b.headingFont,
    "{{brand.bodyFont}}": b.bodyFont,
  };
  const sub = (s: string) =>
    Object.entries(map).reduce((acc, [tok, val]) => acc.split(tok).join(val), s);
  return { html: sub(html), css: sub(css) };
}

// ── Landing: SaaS hero ───────────────────────────────────────────────────────

const heroSaas: GrapesTemplate = {
  key: "hero-saas",
  name: "SaaS hero",
  kind: "landing",
  category: "SaaS",
  description: "Nav, headline + CTA hero, logo strip, 3 features, testimonial, CTA band, footer.",
  html: `
<header class="g-nav">
  <div class="g-wrap g-nav-inner">
    <div class="g-logo">{{brand.accent}}● Acme</div>
    <nav class="g-links"><a href="#">Product</a><a href="#">Pricing</a><a href="#">Docs</a></nav>
    <a href="#" class="g-btn g-btn-sm">Get started</a>
  </div>
</header>
<section class="g-hero">
  <div class="g-wrap">
    <div class="g-eyebrow">New: Acme 2.0 is live</div>
    <h1>Ship marketing that <span class="g-hl">actually converts</span></h1>
    <p class="g-sub">One workspace for content, SEO, and campaigns — built for teams that move fast and measure everything.</p>
    <div class="g-cta-row">
      <a href="#" class="g-btn">Start free trial</a>
      <a href="#" class="g-btn g-btn-ghost">Watch demo</a>
    </div>
    <div class="g-shot">Product screenshot</div>
  </div>
</section>
<section class="g-logos"><div class="g-wrap g-logo-row"><span>AcmeCo</span><span>Globex</span><span>Initech</span><span>Umbrella</span><span>Hooli</span></div></section>
<section class="g-feats"><div class="g-wrap">
  <h2>Everything you need to grow</h2>
  <div class="g-grid3">
    <div class="g-card"><div class="g-ico">✦</div><h3>AI content engine</h3><p>Drafts, briefs, and refreshes in your brand voice.</p></div>
    <div class="g-card"><div class="g-ico">✦</div><h3>SEO visibility</h3><p>Track rankings and close competitor gaps.</p></div>
    <div class="g-card"><div class="g-ico">✦</div><h3>Campaign ops</h3><p>Plan, launch, and measure from one board.</p></div>
  </div>
</div></section>
<section class="g-quote"><div class="g-wrap">
  <p class="g-quote-text">“We replaced four tools with Acme and doubled organic pipeline in a quarter.”</p>
  <p class="g-quote-by">— Dana Cole, VP Growth at Globex</p>
</div></section>
<section class="g-band"><div class="g-wrap">
  <h2>Ready to grow?</h2>
  <p>Join 2,000+ teams shipping better marketing.</p>
  <a href="#" class="g-btn g-btn-light">Start free trial</a>
</div></section>
<footer class="g-foot"><div class="g-wrap"><span>© 2026 Acme Inc.</span><span class="g-foot-links"><a href="#">Privacy</a><a href="#">Terms</a></span></div></footer>`,
  css: `
body{font-family:{{brand.bodyFont}};color:{{brand.text}};margin:0;background:#ffffff;}
h1,h2,h3,.g-logo{font-family:{{brand.headingFont}};}
.g-wrap{max-width:1080px;margin:0 auto;padding:0 24px;}
.g-nav{border-bottom:1px solid #eee;}
.g-nav-inner{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;}
.g-logo{font-weight:800;font-size:18px;}
.g-links{display:flex;gap:24px;}
.g-links a{color:#57534e;text-decoration:none;font-size:14px;}
.g-btn{background:{{brand.primary}};color:#fff;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;display:inline-block;}
.g-btn:hover{background:{{brand.accent}};}
.g-btn-sm{padding:8px 16px;}
.g-btn-ghost{background:#fff;color:{{brand.primary}};border:1px solid {{brand.primary}};}
.g-btn-light{background:#fff;color:{{brand.primary}};}
.g-hero{text-align:center;padding:88px 0 64px;background:linear-gradient(180deg,{{brand.secondary}},#fff);}
.g-eyebrow{display:inline-block;background:#fff;border:1px solid {{brand.secondary}};color:{{brand.primary}};font-size:12px;font-weight:600;padding:6px 14px;border-radius:999px;margin-bottom:20px;}
.g-hero h1{font-size:52px;line-height:1.08;margin:0 0 16px;letter-spacing:-1px;}
.g-hl{color:{{brand.primary}};}
.g-sub{font-size:18px;color:#57534e;max-width:620px;margin:0 auto 32px;}
.g-cta-row{display:flex;gap:12px;justify-content:center;margin-bottom:48px;}
.g-shot{background:{{brand.secondary}};border:2px dashed {{brand.accent}};border-radius:16px;height:320px;display:flex;align-items:center;justify-content:center;color:{{brand.primary}};font-weight:600;}
.g-logos{padding:32px 0;border-bottom:1px solid #eee;}
.g-logo-row{display:flex;justify-content:space-between;color:#a8a29e;font-weight:700;font-size:15px;}
.g-feats{padding:72px 0;text-align:center;}
.g-feats h2{font-size:32px;margin:0 0 40px;}
.g-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;text-align:left;}
.g-card{border:1px solid #eee;border-radius:12px;padding:24px;}
.g-card h3{margin:12px 0 8px;font-size:17px;}
.g-card p{color:#57534e;font-size:14px;margin:0;}
.g-ico{width:40px;height:40px;border-radius:10px;background:{{brand.secondary}};color:{{brand.primary}};display:flex;align-items:center;justify-content:center;font-size:18px;}
.g-quote{background:#fafaf9;padding:64px 0;text-align:center;}
.g-quote-text{font-size:22px;font-style:italic;max-width:700px;margin:0 auto 12px;}
.g-quote-by{color:#78716c;font-size:14px;}
.g-band{background:{{brand.primary}};color:#fff;text-align:center;padding:72px 0;}
.g-band h2{font-size:34px;margin:0 0 8px;}
.g-band p{opacity:.85;margin:0 0 28px;}
.g-foot{padding:24px 0;font-size:13px;color:#78716c;}
.g-foot .g-wrap{display:flex;justify-content:space-between;}
.g-foot-links{display:flex;gap:16px;}
.g-foot a{color:#78716c;text-decoration:none;}`,
};

// ── Landing: webinar ─────────────────────────────────────────────────────────

const webinar: GrapesTemplate = {
  key: "webinar",
  name: "Webinar registration",
  kind: "landing",
  category: "Events",
  description: "Title, date/time pills, speakers, takeaways, and a registration form.",
  html: `
<section class="w-top"><div class="g-wrap">
  <div class="w-live">● Live webinar</div>
  <h1>The 2026 playbook for <span class="g-hl">organic growth</span></h1>
  <div class="w-pills"><span>Oct 14, 2026</span><span>2:00 PM ET</span><span>60 min + Q&A</span><span>Free</span></div>
</div></section>
<section class="w-main"><div class="g-wrap w-cols">
  <div>
    <h2>What you'll learn</h2>
    <ul class="w-list">
      <li><b>Find the gaps</b> — steal competitor keywords in 20 minutes.</li>
      <li><b>Brief like a pro</b> — the content-brief template top teams use.</li>
      <li><b>Refresh, don't rewrite</b> — the decay engine that revives old posts.</li>
      <li><b>Measure what matters</b> — visibility score, pipeline, revenue.</li>
    </ul>
    <h2>Your hosts</h2>
    <div class="w-hosts">
      <div class="w-host"><div class="w-avatar">DC</div><div><b>Dana Cole</b><br><span>VP Growth, Globex</span></div></div>
      <div class="w-host"><div class="w-avatar">JM</div><div><b>Jo March</b><br><span>SEO Lead, Acme</span></div></div>
    </div>
  </div>
  <form class="w-form">
    <h3>Reserve your seat</h3>
    <p>1,200+ marketers already registered.</p>
    <label>Full name<input type="text" placeholder="Ada Lovelace"></label>
    <label>Work email<input type="email" placeholder="ada@company.com"></label>
    <label>Company<input type="text" placeholder="Company Inc."></label>
    <button type="submit" class="g-btn w-full">Save my spot</button>
    <small>We'll send the replay link after the session.</small>
  </form>
</div></section>
<footer class="g-foot"><div class="g-wrap"><span>© 2026 Acme Inc.</span></div></footer>`,
  css: `
body{font-family:{{brand.bodyFont}};color:{{brand.text}};margin:0;background:#fff;}
h1,h2,h3{font-family:{{brand.headingFont}};}
.g-wrap{max-width:1080px;margin:0 auto;padding:0 24px;}
.g-hl{color:{{brand.primary}};}
.g-btn{background:{{brand.primary}};color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;border:0;cursor:pointer;}
.g-btn:hover{background:{{brand.accent}};}
.w-full{width:100%;}
.w-top{background:{{brand.primary}};color:#fff;padding:80px 0 64px;text-align:center;}
.w-top h1{font-size:44px;margin:16px 0 24px;letter-spacing:-0.5px;}
.w-live{display:inline-block;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);padding:6px 16px;border-radius:999px;font-size:13px;font-weight:600;}
.w-pills{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.w-pills span{background:rgba(255,255,255,.15);padding:8px 18px;border-radius:999px;font-size:14px;}
.w-main{padding:64px 0;}
.w-cols{display:grid;grid-template-columns:1.4fr 1fr;gap:48px;}
.w-cols h2{font-size:24px;margin:0 0 20px;}
.w-list{list-style:none;padding:0;margin:0 0 40px;}
.w-list li{padding:12px 0;border-bottom:1px solid #f0edea;font-size:15px;color:#44403c;}
.w-hosts{display:grid;gap:16px;}
.w-host{display:flex;gap:14px;align-items:center;}
.w-avatar{width:52px;height:52px;border-radius:50%;background:{{brand.secondary}};color:{{brand.primary}};display:flex;align-items:center;justify-content:center;font-weight:800;}
.w-host span{color:#78716c;font-size:13px;}
.w-form{border:1px solid #e7e5e4;border-radius:16px;padding:32px;box-shadow:0 12px 32px rgba(0,0,0,.06);align-self:start;position:sticky;top:24px;}
.w-form h3{margin:0 0 6px;font-size:20px;}
.w-form p{color:#78716c;font-size:14px;margin:0 0 20px;}
.w-form label{display:block;font-size:13px;font-weight:600;margin-bottom:14px;}
.w-form input{width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:8px;font-size:14px;}
.w-form small{display:block;text-align:center;color:#a8a29e;margin-top:12px;font-size:12px;}
.g-foot{padding:24px 0;font-size:13px;color:#78716c;border-top:1px solid #eee;text-align:center;}`,
};

// ── Landing: newsletter signup ───────────────────────────────────────────────

const newsletterLanding: GrapesTemplate = {
  key: "newsletter-landing",
  name: "Newsletter signup",
  kind: "landing",
  category: "Newsletter",
  description: "Centered signup hero, benefit bullets, social proof, minimal footer.",
  html: `
<section class="n-hero"><div class="g-wrap n-narrow">
  <div class="n-mark">✦</div>
  <div class="g-eyebrow">The Growth Memo · Weekly</div>
  <h1>One tactic. Every Tuesday. <span class="g-hl">Zero fluff.</span></h1>
  <p class="g-sub">Join 24,000+ marketers getting one actionable growth tactic a week — read in under 4 minutes.</p>
  <form class="n-form"><input type="email" placeholder="you@company.com"><button type="submit" class="g-btn">Subscribe free</button></form>
  <small>No spam. Unsubscribe anytime.</small>
  <div class="n-perks">
    <div><b>✓</b> Real teardowns, not theory</div>
    <div><b>✓</b> Templates you can steal</div>
    <div><b>✓</b> Read by teams at 400+ companies</div>
  </div>
</div></section>
<section class="n-proof"><div class="g-wrap n-narrow">
  <p class="g-quote-text">“The only newsletter I open every single week.”</p>
  <p class="g-quote-by">— 4.9/5 from 3,100 reader ratings</p>
</div></section>
<footer class="g-foot"><div class="g-wrap"><span>© 2026 The Growth Memo</span></div></footer>`,
  css: `
body{font-family:{{brand.bodyFont}};color:{{brand.text}};margin:0;background:#fff;}
h1{font-family:{{brand.headingFont}};}
.g-wrap{max-width:1080px;margin:0 auto;padding:0 24px;}
.n-narrow{max-width:640px;}
.n-hero{text-align:center;padding:96px 0 80px;background:linear-gradient(180deg,{{brand.secondary}},#fff);}
.n-mark{width:56px;height:56px;margin:0 auto 20px;border-radius:16px;background:{{brand.primary}};color:#fff;display:flex;align-items:center;justify-content:center;font-size:26px;}
.g-eyebrow{display:inline-block;background:#fff;border:1px solid {{brand.secondary}};color:{{brand.primary}};font-size:12px;font-weight:600;padding:6px 14px;border-radius:999px;margin-bottom:20px;}
.n-hero h1{font-size:46px;line-height:1.1;margin:0 0 16px;letter-spacing:-1px;}
.g-hl{color:{{brand.primary}};}
.g-sub{font-size:17px;color:#57534e;margin:0 auto 32px;}
.n-form{display:flex;gap:8px;max-width:440px;margin:0 auto 12px;}
.n-form input{flex:1;padding:12px 16px;border:1px solid #d6d3d1;border-radius:8px;font-size:15px;}
.g-btn{background:{{brand.primary}};color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;border:0;cursor:pointer;}
.g-btn:hover{background:{{brand.accent}};}
.n-hero small{color:#a8a29e;font-size:12px;}
.n-perks{display:flex;gap:24px;justify-content:center;margin-top:40px;font-size:14px;color:#57534e;flex-wrap:wrap;}
.n-perks b{color:{{brand.primary}};}
.n-proof{padding:64px 0;text-align:center;background:#fafaf9;}
.g-quote-text{font-size:22px;font-style:italic;max-width:640px;margin:0 auto 12px;}
.g-quote-by{color:#78716c;font-size:14px;}
.g-foot{padding:24px 0;font-size:13px;color:#78716c;border-top:1px solid #eee;text-align:center;}`,
};

// ── Landing: product launch ──────────────────────────────────────────────────

const productLaunch: GrapesTemplate = {
  key: "product-launch",
  name: "Product launch",
  kind: "landing",
  category: "Launch",
  description: "Announcement eyebrow, hero, feature grid, waitlist CTA, footer.",
  html: `
<section class="p-hero"><div class="g-wrap">
  <div class="p-badge">Launching Nov 2026</div>
  <h1>Meet <span class="g-hl">Pulse</span> — analytics your whole team will actually read</h1>
  <p class="g-sub">One dashboard. Every channel. Insights written in plain English, delivered every morning.</p>
  <form class="p-form"><input type="email" placeholder="you@company.com"><button type="submit" class="g-btn">Join the waitlist</button></form>
  <div class="p-count"><span><b>8,400+</b> on the list</span></div>
  <div class="g-shot">Pulse dashboard preview</div>
</div></section>
<section class="p-feats"><div class="g-wrap">
  <div class="g-grid3">
    <div class="g-card"><div class="g-ico">◈</div><h3>Morning brief</h3><p>What moved, why it moved, what to do — in your inbox by 8am.</p></div>
    <div class="g-card"><div class="g-ico">◈</div><h3>Anomaly alerts</h3><p>Know about the spike before your boss asks about it.</p></div>
    <div class="g-card"><div class="g-ico">◈</div><h3>Plain-English AI</h3><p>No SQL. No dashboards to decode. Just answers.</p></div>
  </div>
</div></section>
<section class="p-band"><div class="g-wrap">
  <h2>Be first in line</h2>
  <p>Early access opens to waitlist members first — with founding-member pricing locked for life.</p>
  <a href="#" class="g-btn g-btn-light">Join the waitlist</a>
</div></section>
<footer class="g-foot"><div class="g-wrap"><span>© 2026 Pulse Analytics</span></div></footer>`,
  css: `
body{font-family:{{brand.bodyFont}};color:{{brand.text}};margin:0;background:#0c0a09;color-scheme:dark;}
h1,h2,h3{font-family:{{brand.headingFont}};}
.g-wrap{max-width:1080px;margin:0 auto;padding:0 24px;}
.g-hl{color:{{brand.accent}};}
.g-btn{background:{{brand.primary}};color:#fff;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;border:0;cursor:pointer;display:inline-block;}
.g-btn:hover{background:{{brand.accent}};}
.g-btn-light{background:#fff;color:{{brand.primary}};}
.p-hero{background:radial-gradient(ellipse at 50% -10%,{{brand.primary}}55,transparent 60%),#0c0a09;color:#fafaf9;text-align:center;padding:88px 0 72px;}
.p-badge{display:inline-block;border:1px solid {{brand.accent}};color:{{brand.accent}};font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:8px 18px;border-radius:999px;margin-bottom:24px;}
.p-hero h1{font-size:52px;line-height:1.08;margin:0 auto 18px;max-width:760px;letter-spacing:-1px;color:#fff;}
.g-sub{font-size:18px;color:#a8a29e;max-width:600px;margin:0 auto 32px;}
.p-form{display:flex;gap:8px;max-width:440px;margin:0 auto 16px;}
.p-form input{flex:1;padding:12px 16px;border-radius:8px;border:1px solid #44403c;background:#1c1917;color:#fff;font-size:15px;}
.p-count{color:#78716c;font-size:14px;margin-bottom:48px;}
.p-count b{color:#fff;}
.g-shot{background:#1c1917;border:1px solid #44403c;border-radius:16px;height:300px;display:flex;align-items:center;justify-content:center;color:{{brand.accent}};font-weight:600;}
.p-feats{padding:72px 0;background:#0c0a09;}
.g-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;}
.g-card{background:#1c1917;border:1px solid #292524;border-radius:12px;padding:28px;}
.g-card h3{margin:14px 0 8px;font-size:17px;color:#fff;}
.g-card p{color:#a8a29e;font-size:14px;margin:0;}
.g-ico{width:40px;height:40px;border-radius:10px;background:{{brand.primary}}33;color:{{brand.accent}};display:flex;align-items:center;justify-content:center;font-size:18px;}
.p-band{background:{{brand.primary}};color:#fff;text-align:center;padding:72px 0;}
.p-band h2{font-size:34px;margin:0 0 8px;color:#fff;}
.p-band p{opacity:.85;margin:0 auto 28px;max-width:520px;}
.g-foot{padding:24px 0;font-size:13px;color:#78716c;background:#0c0a09;text-align:center;border-top:1px solid #292524;}`,
};

// ── Landing: event ───────────────────────────────────────────────────────────

const event: GrapesTemplate = {
  key: "event",
  name: "Event page",
  kind: "landing",
  category: "Events",
  description: "Date/venue hero, schedule, speakers, ticket CTA, footer.",
  html: `
<section class="e-hero"><div class="g-wrap">
  <div class="e-date">March 18–19, 2027 · Raleigh, NC</div>
  <h1>Growth Summit <span class="g-hl">2027</span></h1>
  <p class="g-sub">Two days. 40 speakers. The playbooks behind the fastest-growing teams in the Southeast.</p>
  <a href="#" class="g-btn">Get tickets — from $299</a>
</div></section>
<section class="e-sched"><div class="g-wrap n2">
  <h2>Schedule highlights</h2>
  <div class="e-row"><span class="e-time">9:00</span><div><b>Opening keynote</b><p>The state of growth in 2027</p></div></div>
  <div class="e-row"><span class="e-time">10:30</span><div><b>Breakout: SEO</b><p>Winning the AI-answer layer</p></div></div>
  <div class="e-row"><span class="e-time">13:00</span><div><b>Panel: Paid media</b><p>Creative testing at scale</p></div></div>
  <div class="e-row"><span class="e-time">15:30</span><div><b>Workshop: Lifecycle</b><p>Email flows that print revenue</p></div></div>
</div></section>
<section class="e-speakers"><div class="g-wrap">
  <h2>Speakers</h2>
  <div class="e-grid">
    <div class="e-sp"><div class="e-av">AK</div><b>Ana Kim</b><span>CMO, Northwind</span></div>
    <div class="e-sp"><div class="e-av">RS</div><b>Ravi Shah</b><span>Growth, Datawise</span></div>
    <div class="e-sp"><div class="e-av">LT</div><b>Lena Torres</b><span>Founder, Loop</span></div>
    <div class="e-sp"><div class="e-av">MO</div><b>Marcus Owen</b><span>VP Marketing, Hale</span></div>
  </div>
</div></section>
<section class="e-cta"><div class="g-wrap">
  <h2>Early-bird ends soon</h2>
  <p>Save $100 before February 1.</p>
  <a href="#" class="g-btn g-btn-light">Get tickets</a>
</div></section>
<footer class="g-foot"><div class="g-wrap"><span>© 2026 Growth Summit</span></div></footer>`,
  css: `
body{font-family:{{brand.bodyFont}};color:{{brand.text}};margin:0;background:#fff;}
h1,h2{font-family:{{brand.headingFont}};}
.g-wrap{max-width:1080px;margin:0 auto;padding:0 24px;}
.n2{max-width:760px;}
.g-hl{color:{{brand.primary}};}
.g-btn{background:{{brand.primary}};color:#fff;padding:13px 30px;border-radius:8px;font-weight:600;font-size:15px;text-decoration:none;display:inline-block;border:0;}
.g-btn:hover{background:{{brand.accent}};}
.g-btn-light{background:#fff;color:{{brand.primary}};}
.e-hero{background:linear-gradient(135deg,{{brand.primary}},{{brand.accent}});color:#fff;text-align:center;padding:96px 0 80px;}
.e-date{font-weight:700;letter-spacing:2px;text-transform:uppercase;font-size:13px;opacity:.9;}
.e-hero h1{font-size:56px;margin:16px 0;letter-spacing:-1px;color:#fff;}
.e-hero h1 .g-hl{color:#fff;text-decoration:underline;text-decoration-color:rgba(255,255,255,.5);}
.g-sub{font-size:18px;opacity:.9;max-width:600px;margin:0 auto 32px;}
.e-sched{padding:72px 0;}
.e-sched h2,.e-speakers h2{font-size:30px;margin:0 0 32px;text-align:center;}
.e-row{display:flex;gap:24px;padding:20px 0;border-bottom:1px solid #f0edea;align-items:baseline;}
.e-time{font-weight:800;color:{{brand.primary}};min-width:64px;font-size:15px;}
.e-row b{font-size:16px;}
.e-row p{margin:4px 0 0;color:#78716c;font-size:14px;}
.e-speakers{padding:24px 0 72px;text-align:center;}
.e-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px;}
.e-sp{display:flex;flex-direction:column;align-items:center;gap:6px;}
.e-av{width:88px;height:88px;border-radius:50%;background:{{brand.secondary}};color:{{brand.primary}};display:flex;align-items:center;justify-content:center;font-weight:800;font-size:22px;margin-bottom:6px;}
.e-sp span{color:#78716c;font-size:13px;}
.e-cta{background:#1c1917;color:#fff;text-align:center;padding:72px 0;}
.e-cta h2{font-size:32px;margin:0 0 8px;color:#fff;}
.e-cta p{color:#a8a29e;margin:0 0 28px;}
.g-foot{padding:24px 0;font-size:13px;color:#78716c;border-top:1px solid #eee;text-align:center;}`,
};

// ── Landing: coming soon ─────────────────────────────────────────────────────

const comingSoon: GrapesTemplate = {
  key: "coming-soon",
  name: "Coming soon",
  kind: "landing",
  category: "Launch",
  description: "Centered teaser, email capture, launch countdown placeholders, social links.",
  html: `
<section class="c-hero"><div class="g-wrap n3">
  <div class="c-mark">✦</div>
  <h1>Something big is <span class="g-hl">brewing</span></h1>
  <p class="g-sub">We're putting the finishing touches on the easiest way to launch your next product. Be the first to know.</p>
  <form class="c-form"><input type="email" placeholder="you@company.com"><button type="submit" class="g-btn">Notify me</button></form>
  <div class="c-timer">
    <div><b>24</b><span>days</span></div><div><b>11</b><span>hrs</span></div><div><b>36</b><span>min</span></div><div><b>09</b><span>sec</span></div>
  </div>
  <div class="c-social"><a href="#">X</a><a href="#">LinkedIn</a><a href="#">Instagram</a></div>
</div></section>
<footer class="g-foot"><div class="g-wrap"><span>© 2026 Stealth Co.</span></div></footer>`,
  css: `
body{font-family:{{brand.bodyFont}};color:{{brand.text}};margin:0;background:#fff;}
h1{font-family:{{brand.headingFont}};}
.g-wrap{max-width:1080px;margin:0 auto;padding:0 24px;}
.n3{max-width:620px;}
.g-hl{color:{{brand.primary}};}
.g-btn{background:{{brand.primary}};color:#fff;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px;border:0;cursor:pointer;}
.g-btn:hover{background:{{brand.accent}};}
.c-hero{text-align:center;padding:120px 0 100px;background:linear-gradient(180deg,#fff,{{brand.secondary}}66);}
.c-mark{width:64px;height:64px;margin:0 auto 24px;border-radius:20px;background:{{brand.primary}};color:#fff;display:flex;align-items:center;justify-content:center;font-size:30px;}
.c-hero h1{font-size:50px;margin:0 0 16px;letter-spacing:-1px;}
.g-sub{font-size:17px;color:#57534e;margin:0 auto 36px;}
.c-form{display:flex;gap:8px;max-width:420px;margin:0 auto 48px;}
.c-form input{flex:1;padding:12px 16px;border:1px solid #d6d3d1;border-radius:8px;font-size:15px;}
.c-timer{display:flex;gap:16px;justify-content:center;margin-bottom:48px;}
.c-timer div{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:16px 20px;min-width:72px;}
.c-timer b{display:block;font-size:28px;color:{{brand.primary}};}
.c-timer span{font-size:12px;color:#78716c;text-transform:uppercase;letter-spacing:1px;}
.c-social{display:flex;gap:20px;justify-content:center;}
.c-social a{color:{{brand.primary}};font-weight:600;font-size:14px;text-decoration:none;}
.g-foot{padding:24px 0;font-size:13px;color:#78716c;border-top:1px solid #eee;text-align:center;}`,
};

// ── Email: newsletter (table-based, inline styles) ──────────────────────────

const emailNewsletter: GrapesTemplate = {
  key: "email-newsletter",
  name: "Newsletter email",
  kind: "email",
  category: "Newsletter",
  description: "Table-based newsletter: preheader, header, hero, article rows, CTA, footer.",
  html: `
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f4f2;margin:0;padding:0;">
<tr><td align="center" style="padding:24px 12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;">
<tr><td style="padding:12px 24px;font-family:{{brand.bodyFont}};font-size:12px;color:#a8a29e;text-align:center;">Your weekly growth tactic — read in 4 minutes · <a href="#" style="color:#a8a29e;">View in browser</a></td></tr>
<tr><td style="background-color:{{brand.primary}};padding:28px 32px;font-family:{{brand.headingFont}};font-size:22px;font-weight:800;color:#ffffff;">✦ The Growth Memo</td></tr>
<tr><td style="padding:36px 32px 8px;font-family:{{brand.bodyFont}};">
<p style="font-size:13px;color:{{brand.primary}};font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:0 0 8px;">Issue #142 · Tuesday</p>
<h1 style="font-family:{{brand.headingFont}};font-size:30px;margin:0 0 12px;color:{{brand.text}};">The 20-minute keyword gap audit</h1>
<p style="font-size:15px;line-height:1.6;color:#57534e;margin:0 0 20px;">Your competitors rank for hundreds of keywords you don't. Here's the exact workflow to find them, prioritize them, and turn the best ones into briefs — before lunch.</p>
</td></tr>
<tr><td style="padding:0 32px 8px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="120" valign="top" style="padding:12px 0;"><div style="width:104px;height:80px;background-color:{{brand.secondary}};border-radius:8px;text-align:center;line-height:80px;color:{{brand.primary}};font-weight:700;font-size:12px;">IMG</div></td>
<td valign="top" style="padding:12px 0 12px 16px;font-family:{{brand.bodyFont}};"><b style="font-size:15px;color:{{brand.text}};">Step 1: Pull the gap</b><p style="font-size:14px;color:#57534e;margin:6px 0 0;line-height:1.5;">Export the competitor keyword overlap and filter for intent you can actually win.</p></td>
</tr>
<tr>
<td width="120" valign="top" style="padding:12px 0;"><div style="width:104px;height:80px;background-color:{{brand.secondary}};border-radius:8px;text-align:center;line-height:80px;color:{{brand.primary}};font-weight:700;font-size:12px;">IMG</div></td>
<td valign="top" style="padding:12px 0 12px 16px;font-family:{{brand.bodyFont}};"><b style="font-size:15px;color:{{brand.text}};">Step 2: Score the brief</b><p style="font-size:14px;color:#57534e;margin:6px 0 0;line-height:1.5;">Volume × difficulty × fit. Anything scoring 70+ goes straight to the content queue.</p></td>
</tr>
</table>
</td></tr>
<tr><td align="center" style="padding:28px 32px;"><a href="#" style="display:inline-block;background-color:{{brand.primary}};color:#ffffff;font-family:{{brand.bodyFont}};font-weight:600;font-size:15px;text-decoration:none;padding:14px 36px;border-radius:8px;">Read the full playbook</a></td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #eee;font-family:{{brand.bodyFont}};font-size:12px;color:#a8a29e;text-align:center;line-height:1.6;">© 2026 The Growth Memo<br>123 Main St, Raleigh, NC<br><a href="#" style="color:#a8a29e;">Unsubscribe</a> · <a href="#" style="color:#a8a29e;">Preferences</a></td></tr>
</table>
</td></tr>
</table>`,
  css: "",
};

// ── Email: promo (table-based, inline styles) ────────────────────────────────

const emailPromo: GrapesTemplate = {
  key: "email-promo",
  name: "Promo / launch email",
  kind: "email",
  category: "Launch",
  description: "Table-based promo: banner, hero, offer box with code, product rows, CTA, footer.",
  html: `
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f4f2;margin:0;padding:0;">
<tr><td align="center" style="padding:24px 12px;">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;max-width:600px;">
<tr><td style="background-color:{{brand.primary}};padding:14px 24px;font-family:{{brand.bodyFont}};font-size:13px;font-weight:700;color:#ffffff;text-align:center;letter-spacing:1px;">LAUNCH WEEK — 30% OFF EVERYTHING</td></tr>
<tr><td style="padding:40px 32px 16px;font-family:{{brand.bodyFont}};text-align:center;">
<h1 style="font-family:{{brand.headingFont}};font-size:32px;margin:0 0 12px;color:{{brand.text}};">Meet Pulse</h1>
<p style="font-size:16px;line-height:1.6;color:#57534e;margin:0;">Analytics your whole team will actually read. Launch week only: lock in founding-member pricing for life.</p>
</td></tr>
<tr><td style="padding:8px 32px 8px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:{{brand.secondary}};border-radius:10px;">
<tr><td style="padding:24px;text-align:center;font-family:{{brand.bodyFont}};">
<p style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:1px;color:{{brand.primary}};">USE CODE AT CHECKOUT</p>
<p style="margin:0;font-family:{{brand.headingFont}};font-size:28px;font-weight:800;letter-spacing:4px;color:{{brand.text}};">LAUNCH30</p>
<p style="margin:12px 0 0;font-size:13px;color:#78716c;">Expires Sunday at midnight ET</p>
</td></tr>
</table>
</td></tr>
<tr><td style="padding:16px 32px;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr>
<td width="50%" valign="top" style="padding:12px 8px 12px 0;font-family:{{brand.bodyFont}};"><div style="height:120px;background-color:#f5f4f2;border-radius:8px;text-align:center;line-height:120px;color:#a8a29e;font-weight:700;">IMG</div><b style="font-size:15px;color:{{brand.text}};">Morning brief</b><p style="font-size:13px;color:#57534e;margin:4px 0 0;">What moved, why, what to do.</p></td>
<td width="50%" valign="top" style="padding:12px 0 12px 8px;font-family:{{brand.bodyFont}};"><div style="height:120px;background-color:#f5f4f2;border-radius:8px;text-align:center;line-height:120px;color:#a8a29e;font-weight:700;">IMG</div><b style="font-size:15px;color:{{brand.text}};">Anomaly alerts</b><p style="font-size:13px;color:#57534e;margin:4px 0 0;">Know about the spike first.</p></td>
</tr>
</table>
</td></tr>
<tr><td align="center" style="padding:24px 32px 32px;"><a href="#" style="display:inline-block;background-color:{{brand.primary}};color:#ffffff;font-family:{{brand.bodyFont}};font-weight:600;font-size:16px;text-decoration:none;padding:15px 48px;border-radius:8px;">Claim 30% off</a></td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #eee;font-family:{{brand.bodyFont}};font-size:12px;color:#a8a29e;text-align:center;line-height:1.6;">© 2026 Pulse Analytics<br><a href="#" style="color:#a8a29e;">Unsubscribe</a></td></tr>
</table>
</td></tr>
</table>`,
  css: "",
};

export const GRAPES_TEMPLATES: GrapesTemplate[] = [
  heroSaas,
  webinar,
  newsletterLanding,
  productLaunch,
  event,
  comingSoon,
  emailNewsletter,
  emailPromo,
];

export function getGrapesTemplate(key: string): GrapesTemplate | undefined {
  return GRAPES_TEMPLATES.find((t) => t.key === key);
}

export function grapesTemplatesByKind(kind: GrapesTemplateKind): GrapesTemplate[] {
  return GRAPES_TEMPLATES.filter((t) => t.kind === kind);
}
