// ShapesOS — /subprocessors: generated from lib/legal/subprocessors.ts
// (beta readiness, WS=legal). The same registry feeds /privacy, and its unit
// test fails when a provider env var exists without a row here.

import Link from "next/link";
import { LegalPage, Placeholder, Section } from "@/components/site/LegalPage";
import { supportEmail } from "@/lib/legal/public-pages";
import { SUBPROCESSOR_BASIS_LABEL, SUBPROCESSOR_BASIS_MEANING, subprocessorsByBasis, type SubprocessorBasis } from "@/lib/legal/subprocessors";

export const metadata = { title: "Subprocessors — ShapesOS", description: "Every third party that can process customer data on the hosted ShapesOS service, what it receives and where." };

const ORDER: readonly SubprocessorBasis[] = ["platform", "when_configured", "connected", "customer_chosen"];

const SECTIONS = [
  { id: "how", title: "How to read this list" },
  ...ORDER.map((b) => ({ id: b.replace(/_/g, "-"), title: SUBPROCESSOR_BASIS_LABEL[b] })),
  { id: "changes", title: "Changes to this list" },
] as const;

export default function SubprocessorsPage() {
  const email = supportEmail();
  return (
    <LegalPage pageKey="subprocessors" path="/subprocessors" title="Subprocessors" lede="Every third party that can process customer data on the hosted service, generated from the registry the code is checked against." sections={SECTIONS}>
      <Section id="how" title="1. How to read this list">
        <p>
          The list is generated from <code>lib/legal/subprocessors.ts</code>. A unit test fails the build when a provider&apos;s configuration is
          added to the code without a row here, so a provider cannot be wired in silently. Each row says what the provider is used for, what data
          can reach it, where it processes it as far as the code and the deployment documents know (&quot;not verified in code&quot; means we have
          not confirmed the vendor&apos;s region), and what is retained.
        </p>
        <ul>
          {ORDER.map((b) => (
            <li key={b}>
              <strong>{SUBPROCESSOR_BASIS_LABEL[b]}</strong> — {SUBPROCESSOR_BASIS_MEANING[b]}
            </li>
          ))}
        </ul>
        <p>Only the first two groups are subprocessors in the GDPR sense. The last two are services you choose and authorise; they are listed for completeness.</p>
      </Section>

      {ORDER.map((b, i) => (
        <Section key={b} id={b.replace(/_/g, "-")} title={`${i + 2}. ${SUBPROCESSOR_BASIS_LABEL[b]}`}>
          <p>{SUBPROCESSOR_BASIS_MEANING[b]}</p>
          <table data-basis={b}>
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Purpose and data</th>
                <th scope="col">Location and retention</th>
              </tr>
            </thead>
            <tbody>
              {subprocessorsByBasis(b).map((s) => (
                <tr key={s.id} data-subprocessor={s.id}>
                  <th scope="row">{s.name}</th>
                  <td>
                    {s.purpose}
                    <br />
                    <span className="text-muted">{s.dataShared}</span>
                  </td>
                  <td>
                    {s.location}
                    <br />
                    <span className="text-muted">{s.retention}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}

      <Section id="changes" title={`${ORDER.length + 2}. Changes to this list`}>
        <p>
          A new platform subprocessor is announced at least <Placeholder>30</Placeholder> days before it processes customer data, by email to
          workspace owners and on this page (the revision date is at the top). To object, write to <code>{email}</code>; the process is in the{" "}
          <Link href="/dpa#subprocessors">Data processing addendum</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
