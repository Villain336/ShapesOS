// ShapesOS — Phase 15.1: "Where each key comes from" (Settings → Providers).
// Renders the typed registry (lib/providers/key-sources.ts) — the same
// source docs/KEYS.md is checked against, so the page and the docs can't
// drift. Server component, no secrets: env var NAMES only.
// Source chips are configuration, not agent states: neutral chips only.

import {
  KEY_CLASS_LABEL,
  KEY_CLASS_MEANING,
  KEY_GROUP_LABEL,
  KEY_SOURCES,
  type KeyClass,
} from "@/lib/providers/key-sources";

const ORDER: KeyClass[] = ["both", "platform", "connect", "byok", "self_host"];

function SourceChip({ cls }: { cls: KeyClass }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink shadow-control">
      {KEY_CLASS_LABEL[cls]}
    </span>
  );
}

export default function KeySourcesTable() {
  return (
    <section className="rounded-lg bg-paper p-5 shadow-hairline" aria-labelledby="providers-key-sources">
      <h2 id="providers-key-sources" className="aos-subheading">
        Where each key comes from
      </h2>
      <dl className="mt-2 grid gap-1.5 text-[0.75rem] md:grid-cols-2">
        {ORDER.map((cls) => (
          <div key={cls} className="flex items-start gap-2">
            <dt className="shrink-0">
              <SourceChip cls={cls} />
            </dt>
            <dd className="text-muted">{KEY_CLASS_MEANING[cls]}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">Provider</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Source</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Your own key</th>
              <th scope="col" className="py-2 pr-3 font-semibold">Host env vars</th>
              <th scope="col" className="py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {ORDER.flatMap((cls) =>
              KEY_SOURCES.filter((e) => e.class === cls).map((e) => (
                <tr key={e.id} className="border-b border-line align-top last:border-0">
                  <td className="py-2 pr-3 text-xs font-semibold text-ink">
                    {e.label}
                    <span className="block font-normal text-subtle">{KEY_GROUP_LABEL[e.group]}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <SourceChip cls={e.class} />
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted">
                    {!e.byok ? "—" : "credential" in e.byok ? (
                      <a href="#providers-your-keys" className="font-semibold text-ink underline-offset-2 hover:underline">
                        Add above
                      </a>
                    ) : (
                      e.byok.where
                    )}
                  </td>
                  <td className="py-2 pr-3 font-mono text-[0.6875rem] text-ink">{e.envVars.length ? e.envVars.join(", ") : "—"}</td>
                  <td className="py-2 text-xs text-muted">{e.note}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
