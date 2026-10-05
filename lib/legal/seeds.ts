// Marketr — Legal/Compliance slice 1: seed obligation templates.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §4. NC-first + national baseline;
// industries: food, drones, SaaS, services (the spec's named four).
//
// Coverage expands by DATA addition: a new industry or jurisdiction is a new
// entry in this array (industries[] / jurisdictions[] filters), never a code
// change. The engine in obligations.ts matches templates to profiles.
//
// Guardrail: no entry invents form numbers, statute citations, or deadlines.
// Every entry carries a source reference; anything not verified is flagged
// needsReview and rendered as "verify before acting", never as fact.

import type { SeedObligationTemplate } from "./types";

export const OBLIGATION_TEMPLATES: SeedObligationTemplate[] = [
  // ---- National baseline: applies to every industry and jurisdiction ----
  {
    key: "federal-ein",
    industries: [],
    jurisdictions: ["national"],
    category: "tax",
    title: "Get a federal employer identification number (EIN)",
    description:
      "Most businesses need an EIN from the IRS to hire employees, open a " +
      "business bank account, or file business taxes. Sole proprietors without " +
      "employees may use an SSN instead — confirm what fits your situation.",
    sourceRef: "IRS — irs.gov (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "business-structure-registration",
    industries: [],
    jurisdictions: ["national"],
    category: "filing",
    title: "Register your business structure",
    description:
      "If you formed an LLC, corporation, or partnership, register it with the " +
      "secretary of state in your formation state. The structure you choose " +
      "affects taxes and liability.",
    sourceRef: "State secretary of state offices (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "local-business-license",
    industries: [],
    jurisdictions: ["national"],
    category: "license",
    title: "Check local business license requirements",
    description:
      "Many cities and counties require a general business license to operate, " +
      "even for home-based businesses. Requirements and fees are set locally.",
    sourceRef: "Your city/county clerk or business office (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },
  {
    key: "general-liability-insurance",
    industries: [],
    jurisdictions: ["national"],
    category: "insurance",
    title: "Evaluate general liability insurance",
    description:
      "General liability coverage protects against common third-party claims. " +
      "A licensed insurance partner can quote coverage for your industry. " +
      "Licensed partner model: they hold the licenses, we provide the " +
      "software — ShapesOS lists the need only and never binds coverage.",
    sourceRef: "Licensed insurance partner (verify before acting)",
    renewalCadence: "Annual policy term (typical)",
    needsReview: true,
  },
  {
    key: "professional-licensing",
    industries: [],
    jurisdictions: ["national"],
    category: "license",
    title: "Check professional licensing for your trade",
    description:
      "Many trades — contractors, cosmetologists, home inspectors, and others " +
      "— need a state professional license to operate legally. Check your " +
      "state's licensing board for your trade.",
    sourceRef:
      "NC licensing boards / your state's licensing board (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },

  // ---- North Carolina layer: applies to every industry in NC ----
  {
    key: "nc-sos-registration",
    industries: [],
    jurisdictions: ["NC"],
    category: "filing",
    title: "Register with the NC Secretary of State",
    description:
      "Businesses operating in North Carolina as an LLC, corporation, or other " +
      "registered entity file formation documents with the NC Secretary of State.",
    sourceRef: "NC Secretary of State — sosnc.gov (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "nc-annual-report",
    industries: [],
    jurisdictions: ["NC"],
    category: "filing",
    title: "File the NC annual report",
    description:
      "Registered NC business entities file an annual report with the Secretary " +
      "of State to stay in good standing.",
    sourceRef: "NC Secretary of State — sosnc.gov (verify before acting)",
    renewalCadence: "Annual",
    needsReview: false,
  },
  {
    key: "nc-sales-tax-registration",
    industries: [],
    jurisdictions: ["NC"],
    category: "tax",
    title: "Register for NC sales and use tax if applicable",
    description:
      "If you sell taxable goods or certain services in North Carolina, " +
      "register with the NC Department of Revenue before you start collecting tax.",
    sourceRef: "NC Department of Revenue — ncdor.gov (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "nc-withholding-tax",
    industries: [],
    jurisdictions: ["NC"],
    category: "tax",
    title: "Register for NC withholding tax if you have employees",
    description:
      "NC employers withhold state income tax from employee wages and remit it " +
      "to the NC Department of Revenue.",
    sourceRef: "NC Department of Revenue — ncdor.gov (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "nc-workers-comp",
    industries: [],
    jurisdictions: ["NC"],
    category: "insurance",
    title: "Carry NC workers' compensation insurance if you have employees",
    description:
      "North Carolina generally requires workers' compensation coverage for " +
      "businesses with three or more employees. A licensed insurance partner " +
      "can confirm your requirement and place coverage. Licensed partner model: " +
      "they hold the licenses, we provide the software — ShapesOS never binds coverage.",
    sourceRef:
      "NC Industrial Commission / licensed insurance partner (verify before acting)",
    renewalCadence: "Annual policy term (typical)",
    needsReview: true,
  },

  // ---- Food industry ----
  {
    key: "nc-food-establishment-permit",
    industries: ["food"],
    jurisdictions: ["NC"],
    category: "permit",
    title: "Get a food establishment permit from your county health department",
    description:
      "NC food businesses — restaurants, caterers, food trucks, and food " +
      "manufacturers — need a permit from the local county health department " +
      "before opening.",
    sourceRef: "NC DHHS / your county health department (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "food-handler-training",
    industries: ["food"],
    jurisdictions: ["NC"],
    category: "license",
    title: "Complete food handler training",
    description:
      "NC food establishments must have trained food handlers on staff. Your " +
      "county health department sets the local training requirements.",
    sourceRef: "Your county health department (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },
  {
    key: "fda-food-facility-registration",
    industries: ["food"],
    jurisdictions: ["national"],
    category: "filing",
    title: "Check FDA food facility registration",
    description:
      "Facilities that manufacture, process, pack, or hold food for consumption " +
      "in the US may need to register with the FDA. Many small direct-to-consumer " +
      "operations are exempt — confirm your status.",
    sourceRef: "FDA — fda.gov (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },

  // ---- Drones industry ----
  {
    key: "faa-part-107",
    industries: ["drones"],
    jurisdictions: ["national"],
    category: "license",
    title: "FAA Part 107 remote pilot certificate for commercial flights",
    description:
      "Flying a drone commercially in the US requires an FAA Remote Pilot " +
      "Certificate under Part 107, earned by passing the FAA knowledge exam.",
    sourceRef: "FAA — faa.gov (verify before acting)",
    renewalCadence: "Recurrent training every 24 calendar months",
    needsReview: false,
  },
  {
    key: "faa-drone-registration",
    industries: ["drones"],
    jurisdictions: ["national"],
    category: "filing",
    title: "Register your drones with the FAA",
    description:
      "Drones used commercially must be registered with the FAA before flight.",
    sourceRef: "FAA — faa.gov (verify before acting)",
    renewalCadence: null,
    needsReview: false,
  },
  {
    key: "nc-drone-operator-permit",
    industries: ["drones"],
    jurisdictions: ["NC"],
    category: "permit",
    title: "Check NC drone operator permit requirements",
    description:
      "North Carolina has had state-level UAS operator permit requirements " +
      "through NCDOT's Division of Aviation — confirm the current rules before " +
      "commercial flights.",
    sourceRef: "NCDOT Division of Aviation (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },

  // ---- SaaS industry ----
  {
    key: "saas-terms-and-privacy",
    industries: ["saas"],
    jurisdictions: ["national"],
    category: "filing",
    title: "Publish terms of service and a privacy policy",
    description:
      "If you collect user data or charge customers, published terms and a " +
      "privacy policy are standard practice. Have an attorney review them " +
      "before you rely on them.",
    sourceRef: "State consumer-protection and privacy laws (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },
  {
    key: "saas-sales-tax-nexus",
    industries: ["saas"],
    jurisdictions: ["national"],
    category: "tax",
    title: "Evaluate sales-tax nexus for SaaS sales",
    description:
      "Many states tax SaaS. Where you have customers, employees, or servers " +
      "can create nexus and a registration duty — map your footprint before " +
      "selling widely.",
    sourceRef: "State departments of revenue (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },
  {
    key: "data-privacy-review",
    industries: ["saas"],
    jurisdictions: ["national"],
    category: "filing",
    title: "Review state data-privacy law obligations",
    description:
      "State privacy laws can apply based on where your users live, not where " +
      "you are. If you handle personal data, review which state laws reach you.",
    sourceRef: "State attorneys general / privacy statutes (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },

  // ---- Services industry ----
  {
    key: "service-agreements",
    industries: ["services"],
    jurisdictions: ["national"],
    category: "filing",
    title: "Use written service agreements",
    description:
      "Written agreements covering scope, payment, and termination reduce " +
      "disputes. Have an attorney review your template before you reuse it.",
    sourceRef: "Business attorney (verify before acting)",
    renewalCadence: null,
    needsReview: true,
  },
];
