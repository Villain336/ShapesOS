// Phase 19B (WS=engine) — Figma import: a frame of named rectangles and lines
// → town layout JSON. Unit-tested on a fixture in the documented REST
// response shape (hand-authored, not a live capture — the live read is
// UNVERIFIED-LIVE) and a fake fetch for the request shape.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchFigmaFrame, FigmaImportError, figmaFrameToLayout, parseFigmaUrl } from "../figma";
import { parseTownLayout } from "../layout";
import { astar, roadGraph } from "../pathfind";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/figma-town-frame.json", import.meta.url), "utf8"));
const frame = fixture.nodes["12:34"].document;

describe("figmaFrameToLayout", () => {
  const town = figmaFrameToLayout(frame);

  it("produces a valid layout named after the frame, coordinates relative to the frame", () => {
    assert.doesNotThrow(() => parseTownLayout(town));
    assert.equal(town.source, "figma");
    assert.equal(town.name, "Harbor Point");
    assert.deepEqual(town.size, { width: 400, height: 300 });
    const store = town.lots.find((l) => l.name === "Our store")!;
    assert.deepEqual(store.rect, { x: 20, y: 180, w: 70, h: 50 });
    assert.equal(store.kind, "shop");
    assert.equal(store.owner, "you");
  });

  it("reads every named lot kind and district; ignores unnamed shapes", () => {
    assert.deepEqual(town.lots.map((l) => `${l.kind}${l.owner ? `:${l.owner}` : ""}:${l.name}`).sort(), [
      "billboard:Harbor board",
      "cafe:Tide Café",
      "home:1 Gull Lane",
      "home:3 Gull Lane",
      "park:Pier Park",
      "shop:competitor:Dock Goods",
      "shop:you:Our store",
      "work:Fish market",
    ]);
    assert.deepEqual(town.districts.map((d) => `${d.kind}:${d.name}`), ["residential:Northside", "commercial:Harbor front"]);
    assert.equal(town.lots.find((l) => l.name === "1 Gull Lane")!.districtId, town.districts[0]!.id);
    assert.equal(town.lots.find((l) => l.name === "Our store")!.districtId, town.districts[1]!.id);
  });

  it("splits crossing roads into a connected graph, keeps lanes / speed / one-way", () => {
    // Harbor Ave (y=150) crosses Mill St (x=200) and meets Pier Rd (x=300) at a T.
    const ids = (x: number, y: number) => town.roads.nodes.find((n) => n.x === x && n.y === y)?.id;
    for (const [x, y] of [[0, 150], [200, 150], [300, 150], [400, 150], [200, 0], [200, 300], [300, 300]] as const) assert.ok(ids(x, y), `node at ${x},${y}`);
    assert.equal(town.roads.nodes.length, 7);
    const avenue = town.roads.edges.filter((e) => e.lanes === 4);
    assert.equal(avenue.length, 3);
    assert.ok(avenue.every((e) => e.speedKph === 50 && !e.oneWay));
    const pier = town.roads.edges.find((e) => e.oneWay)!;
    assert.deepEqual([pier.from, pier.to], [ids(300, 150), ids(300, 300)]);
    const g = roadGraph(town);
    assert.ok(astar(g, ids(0, 150)!, ids(300, 300)!), "down the one-way");
    assert.equal(astar(g, ids(300, 300)!, ids(0, 150)!), null, "not back up it");
  });

  it("connects each lot to its nearest road node and gives pedestrians sidewalks along the roads", () => {
    const store = town.lots.find((l) => l.name === "Our store")!;
    const node = town.roads.nodes.find((n) => n.id === store.roadNode)!;
    assert.deepEqual([node.x, node.y], [0, 150]);
    assert.equal(town.walkways.edges.length, town.roads.edges.length);
  });

  it("refuses a frame with no road and a frame with no lots", () => {
    assert.throws(() => figmaFrameToLayout({ ...frame, children: frame.children.filter((c: { name: string }) => !c.name.startsWith("road")) }), FigmaImportError);
    assert.throws(() => figmaFrameToLayout({ ...frame, children: frame.children.filter((c: { type: string }) => c.type !== "GROUP") }), /no lots/);
  });
});

describe("parseFigmaUrl", () => {
  it("reads the file key and node id (dashes become colons)", () => {
    assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC123xyz/Town?node-id=12-34&t=x"), { fileKey: "AbC123xyz", nodeId: "12:34" });
    assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/AbC123xyz/branch/BrKey9/Town?node-id=1-2"), { fileKey: "BrKey9", nodeId: "1:2" });
    assert.equal(parseFigmaUrl("https://example.com/design/AbC/x?node-id=1-2"), null);
    assert.equal(parseFigmaUrl("https://www.figma.com/design/AbC123xyz/Town"), null);
  });
});

describe("fetchFigmaFrame (fake fetch, documented request shape)", () => {
  it("GETs /v1/files/:key/nodes?ids= with the X-Figma-Token header and returns the frame", async () => {
    const seen: Array<{ url: string; token: string | null }> = [];
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), token: new Headers(init?.headers).get("X-Figma-Token") });
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
    };
    const got = await fetchFigmaFrame({ fileKey: "AbC123xyz", nodeId: "12:34" }, { token: "figd_test", fetch: fakeFetch });
    assert.equal(got.id, "12:34");
    assert.deepEqual(seen, [{ url: "https://api.figma.com/v1/files/AbC123xyz/nodes?ids=12%3A34", token: "figd_test" }]);
  });

  it("explains a missing token, a 403 and a missing node", async () => {
    await assert.rejects(fetchFigmaFrame({ fileKey: "k", nodeId: "1:2" }, { token: "", fetch: async () => new Response("{}") }), /FIGMA_TOKEN/);
    await assert.rejects(fetchFigmaFrame({ fileKey: "k", nodeId: "1:2" }, { token: "t", fetch: async () => new Response("{}", { status: 403 }) }), /token was refused/);
    await assert.rejects(fetchFigmaFrame({ fileKey: "k", nodeId: "1:2" }, { token: "t", fetch: async () => new Response(JSON.stringify({ nodes: { "1:2": null } })) }), /frame 1:2 was not found/);
  });
});
