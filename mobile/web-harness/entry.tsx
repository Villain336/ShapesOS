// react-native-web harness: renders the REAL DocsScreen (src/screens/DocsScreen.tsx)
// in a browser against an in-page fake of the Office docs routes. This shows
// the React Native components laid out by react-native-web, not a phone.
import React from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { DocsScreen } from "../src/screens/DocsScreen";

type Doc = { id: string; kind: string; title: string; version: number; updatedAt: string; snapshot: any };

const para = (texts: string[], bodyExtra: Record<string, unknown> = {}) => {
  let off = 0;
  const paragraphs = texts.map((t, i) => {
    const p = { startIndex: off, paragraphId: `p${i}` };
    off += t.length + 2;
    return p;
  });
  return { id: "snap", documentStyle: {}, body: { dataStream: texts.map((t) => `${t}\r\n`).join(""), paragraphs, textRuns: [], ...bodyExtra } };
};

const store: Doc[] = [
  { id: "plain", kind: "doc", title: "Meeting notes", version: 3, updatedAt: "2026-10-26T14:00:00Z", snapshot: para(["Quarterly plan", "", "Revenue grew 12% quarter over quarter.", "Next: hire two engineers."]) },
  { id: "rich", kind: "doc", title: "Board update", version: 1, updatedAt: "2026-10-25T09:00:00Z", snapshot: para(["Board update", "Revenue grew 12%."], { textRuns: [{ st: 0, ed: 12, ts: { bl: 1 } }] }) },
];
const w = window as unknown as { __log: Array<{ method: string; url: string; body?: any }>; __bumpOnSave: boolean };
w.__log = [];
w.__bumpOnSave = false;

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input).replace("https://harness.test", "");
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  w.__log.push({ method, url, body });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("/api/office/docs?")) return json({ docs: store.map(({ snapshot: _s, ...d }) => d) });
  const m = /^\/api\/office\/docs\/(.+)$/.exec(url);
  const doc = m ? store.find((d) => d.id === decodeURIComponent(m[1]!)) : undefined;
  if (!doc) return json({ error: "not found" }, 404);
  if (method === "GET") return json({ doc });
  if (method === "PATCH") {
    // The harness can simulate someone else saving first.
    if (w.__bumpOnSave) doc.version += 1;
    if (body.expectedVersion !== doc.version) return json({ error: `version conflict: expected ${body.expectedVersion}, have ${doc.version}` }, 409);
    doc.snapshot = body.snapshot;
    doc.version += 1;
    return json({ doc });
  }
  return json({ error: "unsupported" }, 400);
}) as typeof fetch;

createRoot(document.getElementById("root")!).render(
  <View style={{ height: "100vh", backgroundColor: "#F3F3F1" }}>
    <DocsScreen />
  </View>,
);
