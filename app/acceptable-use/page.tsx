// ShapesOS — /acceptable-use: acceptable use policy, DRAFT TEMPLATE (beta
// readiness, WS=legal). Mirrors what the platform refuses in code (no
// CAPTCHA solving, no detection evasion, consent for messaging, money behind
// a human). Not legal advice; pending lawyer review.

import Link from "next/link";
import { LegalPage, Placeholder, Section } from "@/components/site/LegalPage";
import { supportEmail } from "@/lib/legal/public-pages";

export const metadata = { title: "Acceptable use policy — ShapesOS", description: "What you may and may not do with the hosted ShapesOS service (draft, pending legal review)." };

const SECTIONS = [
  { id: "law", title: "Follow the law and other people's rights" },
  { id: "messaging", title: "Messaging, calls and outreach" },
  { id: "automation", title: "Agents and automation" },
  { id: "web", title: "Crawling and the web" },
  { id: "systems", title: "Our systems and other people's" },
  { id: "providers", title: "Third-party providers" },
  { id: "enforcement", title: "Enforcement" },
] as const;

export default function AcceptableUsePage() {
  const email = supportEmail();
  return (
    <LegalPage pageKey="acceptableUse" path="/acceptable-use" title="Acceptable use policy" lede="The rules for using the hosted service. They are part of the Terms." sections={SECTIONS}>
      <Section id="law" title="1. Follow the law and other people's rights">
        <ul>
          <li>No unlawful, defamatory, fraudulent, hateful or sexually exploitative content, and nothing that targets children.</li>
          <li>No content you do not have the rights to: respect copyright, trademarks and the licences of stock media and fonts you pull in.</li>
          <li>No personal data you have no lawful basis to hold, enrich or contact. You are the controller of the people in your CRM, your call recordings and your subscriber lists.</li>
          <li>No impersonation of a person or organisation, and no deceptive AI-generated content presented as human or as fact without review.</li>
        </ul>
      </Section>

      <Section id="messaging" title="2. Messaging, calls and outreach">
        <ul>
          <li>Email, SMS, calls and direct mail only to people you may lawfully contact (CAN-SPAM, TCPA, GDPR/ePrivacy, CASL and local rules). SMS and recorded calls need the consent the law and the carriers require; the platform records STOP/HELP and opt-outs and you must honour them.</li>
          <li>Every marketing email carries a working unsubscribe; one-click unsubscribe links are built in and must not be removed.</li>
          <li>Cold outreach runs on your own sending domains and accounts (Smartlead, Instantly) under their rules and your reputation, never on the platform&apos;s system-mail domain.</li>
          <li>No bulk messaging that a provider would treat as spam, and no purchased lists.</li>
        </ul>
      </Section>

      <Section id="automation" title="3. Agents and automation">
        <ul>
          <li>You are responsible for the automation rules you set and the actions you approve. Money and irreversible actions always wait for a human; do not try to work around that, and do not ask agents to.</li>
          <li>Do not direct agents to deceive people, to evade a site&apos;s terms, to harvest personal data, or to take actions on accounts you do not control.</li>
          <li>Sandboxes are for the work of your workspace: no cryptocurrency mining, no attacks, no malware, no proxying of traffic to third parties.</li>
        </ul>
      </Section>

      <Section id="web" title="4. Crawling and the web">
        <ul>
          <li>The platform&apos;s crawler identifies itself, respects robots rules and rate limits itself; do not use it, or agents, to evade bot detection, solve CAPTCHAs, or bypass paywalls and access controls. The platform refuses to do these.</li>
          <li>Scrape only what you may lawfully use, and respect the terms of the sites you research.</li>
        </ul>
      </Section>

      <Section id="systems" title="5. Our systems and other people's">
        <ul>
          <li>No probing, scanning or testing of the hosted service without written permission (see <Link href="/security#disclosure">responsible disclosure</Link>), and no interference with other customers&apos; workspaces.</li>
          <li>No circumventing seats, credits, rate limits, caps or the invitation mode; no sharing one account between people.</li>
          <li>No uploading of malware; uploads may be scanned.</li>
        </ul>
      </Section>

      <Section id="providers" title="6. Third-party providers">
        <p>
          Using a connected service (Google, Meta, Slack, Shopify, Stripe and the others on the <Link href="/subprocessors">subprocessors page</Link>)
          through ShapesOS means following that provider&apos;s terms and developer policies. If a provider suspends your access for a breach, we
          cannot restore it.
        </p>
      </Section>

      <Section id="enforcement" title="7. Enforcement">
        <p>
          We may remove content, pause agents or automations, suspend a workspace or end an account for a breach, with notice where we can. Report
          abuse to <code>{email}</code>. <Placeholder>Lawyer: appeal process and notice periods</Placeholder>.
        </p>
      </Section>
    </LegalPage>
  );
}
