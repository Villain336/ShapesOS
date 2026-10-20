// ShapesOS — /dpa: data processing addendum, DRAFT TEMPLATE (beta readiness,
// WS=legal). Processor terms for business customers; the technical annex is
// written from the code. Not legal advice; pending lawyer review.

import Link from "next/link";
import { LegalPage, Placeholder, Section } from "@/components/site/LegalPage";
import { supportEmail } from "@/lib/legal/public-pages";

export const metadata = { title: "Data processing addendum — ShapesOS", description: "Processor terms for business customers of the hosted ShapesOS service (draft, pending legal review)." };

const SECTIONS = [
  { id: "parties", title: "Parties and precedence" },
  { id: "processing", title: "Details of the processing" },
  { id: "instructions", title: "Instructions and confidentiality" },
  { id: "security", title: "Security measures" },
  { id: "subprocessors", title: "Subprocessors" },
  { id: "assistance", title: "Assistance and data subject requests" },
  { id: "breach", title: "Personal data breaches" },
  { id: "end", title: "Return and deletion" },
  { id: "audit", title: "Audits and certifications" },
  { id: "transfers", title: "International transfers" },
  { id: "liability", title: "Liability and term" },
] as const;

export default function DpaPage() {
  const email = supportEmail();
  return (
    <LegalPage pageKey="dpa" path="/dpa" title="Data processing addendum" lede="How ShapesOS processes personal data on behalf of a customer organisation (GDPR Article 28 terms)." sections={SECTIONS}>
      <Section id="parties" title="1. Parties and precedence">
        <p>
          This addendum is between the customer organisation that owns a ShapesOS workspace (&quot;Customer&quot;, the controller) and{" "}
          <Placeholder>legal entity</Placeholder> (&quot;ShapesOS&quot;, the processor). It forms part of the <Link href="/terms">Terms of
          service</Link>; where they conflict on personal data, this addendum wins. It applies to personal data in the Customer&apos;s workspaces
          (&quot;Customer data&quot;). Account data of individual users is covered by the <Link href="/privacy">Privacy policy</Link>, where
          ShapesOS is the controller.
        </p>
      </Section>

      <Section id="processing" title="2. Details of the processing">
        <dl>
          <dt>Subject matter and purpose</dt>
          <dd>Providing the hosted marketing and operations workspace: storing Customer data, running AI agents and automations on it, integrating the services the Customer connects, sending the messages the Customer sends.</dd>
          <dt>Duration</dt>
          <dd>The life of the Customer&apos;s workspaces plus the deletion periods in section 8.</dd>
          <dt>Nature</dt>
          <dd>Storage, retrieval, analysis, generation of text and images by AI models, transmission to connected services and messaging providers, backup.</dd>
          <dt>Categories of data subjects</dt>
          <dd>The Customer&apos;s staff and collaborators; its customers, leads and prospects; newsletter subscribers; call and meeting participants; portal clients; website visitors of pages the Customer publishes.</dd>
          <dt>Categories of personal data</dt>
          <dd>Names, business and personal contact details, company and role, communications (email, SMS, chat, call recordings and transcripts), CRM notes and deal data, bookings, invoices and payment status (not card numbers), files the Customer uploads, enrichment results, usage of the Customer&apos;s published pages.</dd>
          <dt>Special categories</dt>
          <dd>None intended. The Customer agrees not to put special-category data (health, biometrics, etc.) into ShapesOS unless agreed in writing.</dd>
        </dl>
      </Section>

      <Section id="instructions" title="3. Instructions and confidentiality">
        <ul>
          <li>ShapesOS processes Customer data only on the Customer&apos;s documented instructions: the Terms, this addendum, the settings and automation rules the Customer configures, and the actions its users and their agents take and approve.</li>
          <li>Agent actions are the Customer&apos;s instructions: money and irreversible actions are never taken without a human approval by a Customer user (Terms, section 5).</li>
          <li>ShapesOS tells the Customer if an instruction appears to break data protection law.</li>
          <li>Everyone ShapesOS authorises to process Customer data is bound by confidentiality. Platform operators are named in the install&apos;s configuration (MARKETR_PLATFORM_OPERATORS); every host-wide action they take is audited.</li>
        </ul>
      </Section>

      <Section id="security" title="4. Security measures (Annex II)">
        <p>Measures in force on the hosted service, as implemented in the code and the deployment:</p>
        <ul>
          <li><strong>Tenant isolation:</strong> every tenant table is under PostgreSQL row-level security with FORCE ROW LEVEL SECURITY; the application connects as a non-superuser, non-BYPASSRLS role, and the suite verifies isolation on every change.</li>
          <li><strong>Encryption:</strong> TLS in transit (Cloudflare, SSL Full strict to Render); secrets, connected-account tokens and two-factor secrets at rest under AES-256-GCM with a server-side key that can be rotated; passwords hashed with scrypt; recovery codes and sign-in tokens as SHA-256 hashes.</li>
          <li><strong>Access control:</strong> workspace roles (owner, admin, editor, viewer) enforced on every mutating route (a security battery fails the build if a route lacks an authorisation primitive); two-factor authentication and passkeys; session registry with revocation; sign-in lockout and CAPTCHA step-up; admins can block an app (for example Mail) for every agent in the workspace.</li>
          <li><strong>Agent safety:</strong> actions classed by effect at execution time; Tier 3 never auto-approved; destructive tools never auto-run; agent code runs in disposable sandboxes; no bot-detection evasion.</li>
          <li><strong>Application hardening:</strong> per-request CSP nonces, tiered rate limits, request body caps, schema validation of every write, signature verification on every inbound webhook.</li>
          <li><strong>Logging and monitoring:</strong> request ids on every response, a hash-chained audit log per workspace, a data access log of agent reads, scrubbed error reports, the public <Link href="/status">status page</Link>.</li>
          <li><strong>Backup and recovery:</strong> 7-day point-in-time recovery on the database; nightly exports to object storage kept 35 days; Time Machine snapshots per workspace with restore into a new workspace.</li>
          <li><strong>Operations:</strong> deploys only through a reviewed release workflow with approval, health smoke and rollback; secrets live in the platform&apos;s environment groups, never in the repository.</li>
        </ul>
        <p>The <Link href="/security">Security page</Link> keeps this list current and says plainly what is not yet in place.</p>
      </Section>

      <Section id="subprocessors" title="5. Subprocessors">
        <ul>
          <li>The Customer authorises the subprocessors on the <Link href="/subprocessors">subprocessors page</Link> (Annex III), which states each one&apos;s purpose, data and location, and distinguishes platform subprocessors from services that only process data for a workspace that connects them.</li>
          <li>ShapesOS gives at least <Placeholder>30</Placeholder> days&apos; notice of a new platform subprocessor by email to workspace owners and on that page. The Customer may object on reasonable data-protection grounds; if no solution is found, the Customer may end the affected service and export its data.</li>
          <li>ShapesOS imposes data-protection terms on each subprocessor that are no less protective than this addendum, and remains responsible for their performance.</li>
        </ul>
      </Section>

      <Section id="assistance" title="6. Assistance and data subject requests">
        <ul>
          <li>The Customer handles requests from its own data subjects using the built-in tools: workspace export (owners and admins), record deletion in the apps, memory controls, and workspace deletion.</li>
          <li>ShapesOS forwards any request it receives about Customer data to the Customer and does not answer it directly, unless the law requires.</li>
          <li>ShapesOS assists with data protection impact assessments and consultations with authorities on request, at reasonable cost where the work is substantial.</li>
        </ul>
      </Section>

      <Section id="breach" title="7. Personal data breaches">
        <p>
          ShapesOS notifies the Customer&apos;s workspace owners of a personal data breach affecting Customer data <strong>without undue delay and
          within 72 hours</strong> of becoming aware of it, with the nature of the breach, the categories and approximate number of records and
          data subjects, the likely consequences, the measures taken, and a contact. Updates follow as the investigation progresses. Security
          incidents affecting availability are posted on the <Link href="/status">status page</Link>.
        </p>
      </Section>

      <Section id="end" title="8. Return and deletion">
        <ul>
          <li>At any time the Customer can export every workspace as JSON and files (Settings → Workspace → Export).</li>
          <li>When a workspace is deleted, or the agreement ends, ShapesOS deletes the workspace&apos;s data; a lifecycle record of the deletion (ids and timestamps, no content) is kept.</li>
          <li>Copies in backups are removed on the backup schedule (point-in-time recovery 7 days, nightly backups 35 days) and are never restored into a live workspace by themselves.</li>
          <li>Data at subprocessors is deleted under their terms when the integration is removed or the account closed.</li>
        </ul>
      </Section>

      <Section id="audit" title="9. Audits and certifications">
        <ul>
          <li>ShapesOS makes available the information needed to show compliance with this addendum: this page, the Security page, the published source code, and the results of its automated security batteries on request.</li>
          <li>The Customer may audit, once a year or after a breach, on 30 days&apos; notice, during business hours, at its own cost, without disrupting the service, and with an auditor bound by confidentiality.</li>
          <li><strong>Honest statement:</strong> ShapesOS holds no SOC 2 or ISO 27001 certification of its own. Render&apos;s SOC 2 report covers Render&apos;s infrastructure and is available from Render. An external penetration test has not yet been performed on the hosted service; the date of the first one will be published on the Security page.</li>
        </ul>
      </Section>

      <Section id="transfers" title="10. International transfers">
        <p>
          Customer data is hosted in the United States (Render, Virginia) and passes through Cloudflare&apos;s global network. For transfers from
          the EEA, the UK and Switzerland the parties rely on <Placeholder>the EU Standard Contractual Clauses (module 2 and, for connected
          onward processors, module 3), the UK International Data Transfer Addendum and the Swiss amendments — lawyer to attach</Placeholder>,
          which are incorporated by reference, with the details of this addendum as their annexes.
        </p>
      </Section>

      <Section id="liability" title="11. Liability and term">
        <p>
          Each party&apos;s liability under this addendum is subject to the limitations in the <Link href="/terms#liability">Terms</Link>, to the
          extent the law allows. This addendum lasts as long as ShapesOS processes Customer data. Contact: <code>{email}</code>. <Placeholder>
          Signature block or click-acceptance wording</Placeholder>.
        </p>
      </Section>
    </LegalPage>
  );
}
