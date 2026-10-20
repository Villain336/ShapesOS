// ShapesOS — /terms: terms of service, DRAFT TEMPLATE (beta readiness,
// WS=legal). Written from what the product does; not legal advice; pending
// lawyer review (the banner comes from LEGAL_DRAFT_PENDING_REVIEW). English
// only. Lawyer placeholders are rendered visibly with <Placeholder>.

import Link from "next/link";
import { LegalPage, Placeholder, Section } from "@/components/site/LegalPage";
import { supportEmail } from "@/lib/legal/public-pages";

export const metadata = { title: "Terms of service — ShapesOS", description: "The terms for using the hosted ShapesOS service (draft, pending legal review)." };

const SECTIONS = [
  { id: "who", title: "Who we are and what this covers" },
  { id: "beta", title: "Private beta" },
  { id: "accounts", title: "Accounts and workspaces" },
  { id: "plans", title: "Plans, credits and billing" },
  { id: "ai", title: "AI agents: what they do and what always asks you" },
  { id: "content", title: "Your content and data" },
  { id: "connected", title: "Connected services and your own keys" },
  { id: "use", title: "Acceptable use" },
  { id: "open-source", title: "Open source" },
  { id: "availability", title: "Availability and support" },
  { id: "ending", title: "Suspension and ending the service" },
  { id: "liability", title: "Disclaimers, liability and indemnity" },
  { id: "changes", title: "Changes, law and contact" },
] as const;

export default function TermsPage() {
  const email = supportEmail();
  return (
    <LegalPage pageKey="terms" path="/terms" title="Terms of service" lede="The agreement between you and ShapesOS for the hosted service." sections={SECTIONS}>
      <Section id="who" title="1. Who we are and what this covers">
        <p>
          ShapesOS is an open-source marketing and operations workspace. These terms cover the <strong>hosted service</strong> at the domains we
          operate (the website, the app and its API), provided by <Placeholder>legal entity name, registration number and address</Placeholder>{" "}
          (&quot;ShapesOS&quot;, &quot;we&quot;). By creating an account, joining a workspace or using the hosted service you agree to them, together
          with the <Link href="/privacy">Privacy policy</Link>, the <Link href="/acceptable-use">Acceptable use policy</Link> and, for business
          customers, the <Link href="/dpa">Data processing addendum</Link>.
        </p>
        <p>
          Running ShapesOS on your own servers is not covered here: the software is licensed to you under the GNU AGPL v3 (see{" "}
          <a href="#open-source">Open source</a>), and you are the operator of that install.
        </p>
      </Section>

      <Section id="beta" title="2. Private beta">
        <p>
          The hosted service is in a <strong>private beta</strong>. That means: features change and may be removed; there is no uptime commitment yet
          (the <Link href="/status">status page</Link> shows live health); we may limit usage to keep the service healthy; and we may end the beta.
          If we end the beta or your access to it, we will give you at least <Placeholder>30</Placeholder> days to export your data (Settings →
          Workspace → Export, and Settings → You → Export) before it is deleted.
        </p>
      </Section>

      <Section id="accounts" title="3. Accounts and workspaces">
        <ul>
          <li>You must be at least <Placeholder>18</Placeholder> years old and use the service for business purposes.</li>
          <li>
            Keep your sign-in private. You can turn on two-factor authentication and passkeys in Settings → You → Security, and sign out other
            sessions from there. You are responsible for what happens under your account until you tell us it was compromised.
          </li>
          <li>
            A workspace has roles (owner, admin, editor, viewer). Owners and admins are responsible for the people they invite, the connections
            they authorise and the automation rules they set.
          </li>
          <li>Invitation-only installs (SIGNUP_MODE=invite) accept only the addresses a workspace admin invited.</li>
        </ul>
      </Section>

      <Section id="plans" title="4. Plans, credits and billing">
        <ul>
          <li>
            Paid plans are a base fee plus seats, with a monthly pool of AI credits (1 credit = $0.01 of usage). Current prices are on the{" "}
            <Link href="/pricing">pricing page</Link>; they are in USD before tax.
          </li>
          <li>Extra seats are confirmed by you before they are billed. Credit top-ups are prepaid and roll over for 12 months.</li>
          <li>
            Overage is <strong>off by default</strong>. If you turn it on, it runs at the published per-credit price up to the hard cap you set; a
            capped workspace is refused further platform-key AI calls rather than billed past the cap.
          </li>
          <li>
            Usage on your own provider keys (bring your own key) is recorded at zero credits; your provider bills you directly under its own terms.
          </li>
          <li>Payments are processed by Stripe. Card details never touch ShapesOS.</li>
          <li>
            Fees are non-refundable except where the law requires or we say otherwise in writing. <Placeholder>Refund, trial and tax wording
            for the lawyer</Placeholder>.
          </li>
        </ul>
      </Section>

      <Section id="ai" title="5. AI agents: what they do and what always asks you">
        <p>
          ShapesOS runs AI agents on your behalf. Their text, images, plans and analyses are <strong>generated by machine-learning models</strong>{" "}
          (Anthropic&apos;s Claude and OpenAI&apos;s GPT and image models, or models under your own key). They can be wrong, out of date or
          inappropriate. You review outputs before you rely on them or publish them, and you are responsible for what you approve.
        </p>
        <p>Every agent action is classed by what it does, at execution time, never by what the agent calls it:</p>
        <ul>
          <li>
            <strong>Tier 0 — observe:</strong> reading, drafting, analysing. Runs without asking.
          </li>
          <li>
            <strong>Tier 1 — small actions</strong> on channels you own (publishing to your own site or social accounts, scheduling owned content),
            under the amount threshold you set (default $100) and only once you enable that automation.
          </li>
          <li>
            <strong>Tier 2 — significant actions</strong> (external audiences, spend above the threshold): ask you first unless you set a rule to
            auto-run them. An amount over your threshold always asks.
          </li>
          <li>
            <strong>Tier 3 — money and irreversible actions</strong> (moving money, buying, refunds, payouts, signing contracts, deleting or purging
            data) <strong>always require a human approval</strong>. No rule, plan, sub-agent, spoken yes or mandate can switch that off.
          </li>
        </ul>
        <p>
          Agents read the data you connect (the data access log in Settings → You → Privacy shows what they read), remember what they learned in
          your workspace (you can see and forget it there), and run code in disposable sandboxes. The web layer does not evade bot detection or
          solve CAPTCHAs. Automation rules are yours: an action an agent takes under a rule you set is your action.
        </p>
      </Section>

      <Section id="content" title="6. Your content and data">
        <ul>
          <li>
            You own your content: projects, keywords, pages, posts, leads, calls, files, notes, transcripts and everything else you put in or
            agents produce for you. You give us the licence we need to host, process, back up and display it to run the service.
          </li>
          <li>
            We process personal data in it as your processor under the <Link href="/dpa">Data processing addendum</Link> and as described in the{" "}
            <Link href="/privacy">Privacy policy</Link>.
          </li>
          <li>
            Personal data about third parties (leads, prospects, call participants, newsletter subscribers) is yours to justify: you confirm you
            have a lawful basis to collect, enrich, record and contact them (including consent where the law or a carrier requires it, for example
            for SMS and recorded calls).
          </li>
          <li>
            Your provider keys, site credentials and connected-account tokens are stored encrypted (AES-256-GCM) and used only for your workspace&apos;s
            calls.
          </li>
        </ul>
      </Section>

      <Section id="connected" title="7. Connected services and your own keys">
        <p>
          When you connect a third-party account (Google, Microsoft, Slack, HubSpot, Meta, Shopify, Stripe and others) or add your own API key,
          that provider&apos;s terms apply between you and them. We are not a party to them. You can disconnect at any time in Settings. The{" "}
          <Link href="/subprocessors">subprocessors page</Link> lists which providers process data as part of the hosted service and which only
          when you connect them.
        </p>
      </Section>

      <Section id="use" title="8. Acceptable use">
        <p>
          The <Link href="/acceptable-use">Acceptable use policy</Link> is part of these terms. In short: no unlawful content, no spam or
          unconsented messaging, no attacks on other people&apos;s systems, no circumventing limits, and no using the service to break a
          provider&apos;s terms.
        </p>
      </Section>

      <Section id="open-source" title="9. Open source">
        <p>
          The ShapesOS source code is published under the GNU Affero General Public License v3. These terms govern the hosted service only; they
          do not narrow the rights the licence gives you to the code. Third-party components and their licences are listed in the repository&apos;s{" "}
          <code>THIRD_PARTY.md</code>.
        </p>
      </Section>

      <Section id="availability" title="10. Availability and support">
        <p>
          Live health and incidents are on the <Link href="/status">status page</Link>. During the beta there is no service-level agreement; we
          may run maintenance with notice on the status page. Support is by email at <code>{email}</code> (see <Link href="/contact">Contact</Link>{" "}
          for response targets).
        </p>
      </Section>

      <Section id="ending" title="11. Suspension and ending the service">
        <ul>
          <li>
            <strong>By you:</strong> delete a workspace in Settings → Workspace (its data is purged; a lifecycle record of the deletion is kept) or
            delete your account in Settings → You (refused while you are the only owner of a workspace that still has other members or a paid
            subscription — transfer ownership first). Export first; deletion is not reversible.
          </li>
          <li>
            <strong>By us:</strong> we may suspend or end access for a material breach of these terms or the acceptable use policy, non-payment
            after notice, a legal requirement, or to protect the service and other customers. Where we can, we tell you first and give you{" "}
            <Placeholder>30</Placeholder> days to export.
          </li>
          <li>After the end, your data is deleted on the schedule in the <Link href="/privacy#retention">Privacy policy</Link>.</li>
        </ul>
      </Section>

      <Section id="liability" title="12. Disclaimers, liability and indemnity">
        <p>
          <Placeholder>Lawyer: warranty disclaimer (service provided &quot;as is&quot; during the beta, AI outputs not guaranteed accurate),
          limitation of liability (cap at fees paid in the preceding 12 months; exclusion of indirect and consequential loss; carve-outs the law
          requires), and the customer&apos;s indemnity for third-party personal data, content and actions approved under section 5</Placeholder>.
        </p>
      </Section>

      <Section id="changes" title="13. Changes, law and contact">
        <p>
          We may update these terms; the revision date is at the top of this page and material changes are announced by email to workspace owners
          at least <Placeholder>14</Placeholder> days before they apply. These terms are governed by the laws of{" "}
          <Placeholder>jurisdiction</Placeholder> and disputes go to the courts of <Placeholder>venue</Placeholder>. Contact:{" "}
          <code>{email}</code>.
        </p>
      </Section>
    </LegalPage>
  );
}
