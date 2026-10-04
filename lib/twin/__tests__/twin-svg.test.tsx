// ShapesOS — Phase 13 (twinui): the server-renderable top-down SVG and the
// server-rendered overlays render to static markup (react-dom/server) with
// one element per object, a title/desc, and agent marks as the only status
// colours. No DB, no browser.
// Run: npx tsx --test lib/twin/__tests__/twin-svg.test.tsx

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { TwinTopDownSvg } from "@/components/twin/TwinTopDownSvg";
import { TwinKpis } from "@/components/twin/TwinKpis";
import { TwinShipmentStepper } from "@/components/twin/TwinShipmentStepper";
import { FACTORY_FIXTURE, STORE_FIXTURE, TWIN_FIXTURES, WAREHOUSE_FIXTURE } from "../fixtures";
import { pickShipment } from "../view-model";

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("TwinTopDownSvg (server render)", () => {
  it("renders one element per object, with a title and desc", () => {
    for (const s of Object.values(TWIN_FIXTURES)) {
      const html = renderToStaticMarkup(<TwinTopDownSvg snapshot={s} />);
      assert.equal(count(html, /data-twin-object="/g), s.objects.length, s.site.code);
      for (const o of s.objects) assert.ok(html.includes(`data-twin-object="${o.id}"`), o.id);
      assert.match(html, /<title id="twin-svg-title-[^"]+">[^<]+top-down plan<\/title>/);
      assert.match(html, /<desc id="twin-svg-desc-/);
      assert.match(html, /role="img"/, "a static drawing is one image");
      assert.doesNotMatch(html, /role="button"/);
    }
  });

  it("is interactive (focusable buttons) only when onSelect is passed", () => {
    const html = renderToStaticMarkup(<TwinTopDownSvg snapshot={STORE_FIXTURE} selectedId="o_s_reg_1" onSelect={() => {}} />);
    assert.equal(count(html, /role="button"/g), STORE_FIXTURE.objects.length);
    assert.equal(count(html, /tabindex="0"/g), STORE_FIXTURE.objects.length);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /role="group"/);
  });

  it("uses clay tokens for the scene; status colours only on agent marks", () => {
    const html = renderToStaticMarkup(<TwinTopDownSvg snapshot={WAREHOUSE_FIXTURE} />);
    assert.match(html, /var\(--aos-clay-0\)/);
    assert.doesNotMatch(html, /#[0-9a-fA-F]{6}/, "no raw hex");
    // 2 agents in the warehouse fixture: needs + running
    assert.equal(count(html, /var\(--aos-needs\)/g), 1);
    assert.equal(count(html, /var\(--aos-running\)/g), 1);
    assert.equal(count(html, /var\(--aos-(done|failed)\)/g), 0);
    const f = renderToStaticMarkup(<TwinTopDownSvg snapshot={FACTORY_FIXTURE} />);
    assert.equal(count(f, /var\(--aos-failed\)/g), 1, "the factory's failed agent");
  });

  it("says equipment positions are estimated and marks unbound objects", () => {
    const html = renderToStaticMarkup(<TwinTopDownSvg snapshot={WAREHOUSE_FIXTURE} />);
    assert.match(html, /Forklift 1, Equipment, Busy, position estimated/);
    const store = renderToStaticMarkup(<TwinTopDownSvg snapshot={STORE_FIXTURE} />);
    assert.match(store, /Seasonal, Shelf, Unbound, unbound/);
  });
});

describe("server-rendered overlays", () => {
  it("KPI cards and the shipment stepper render without a browser", () => {
    const k = renderToStaticMarkup(<TwinKpis kpis={WAREHOUSE_FIXTURE.kpis} />);
    assert.match(k, /Stock on hand/);
    assert.match(k, /4,973/);
    assert.match(k, /92%/);
    const st = renderToStaticMarkup(<TwinShipmentStepper shipment={pickShipment(WAREHOUSE_FIXTURE, null)} />);
    assert.match(st, /TR-0003/);
    assert.match(st, />Late</);
    assert.equal(count(st, /<li /g), 5);
    assert.match(st, /aria-current="step"/);
    const none = renderToStaticMarkup(<TwinShipmentStepper shipment={null} />);
    assert.match(none, /No open shipments/);
  });
});
