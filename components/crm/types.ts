// Marketr CRM — shared types + small primitives (client-safe).

export interface CrmStage {
  id: string;
  label: string;
  color: "violet" | "blue" | "teal" | "amber" | "green" | "gray" | "red";
}

export interface CrmPipeline {
  id: string;
  name: string;
  stages: CrmStage[];
  isDefault: boolean;
  client?: { id: string; name: string } | null;
  activeLeads: number;
}

export interface CrmLead {
  id: string;
  pipelineId: string;
  projectId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  title?: string | null;
  source: string;
  sourceDetail?: string | null;
  stage: string;
  score: number;
  valueCents?: number | null;
  ownerId?: string | null;
  ownerName?: string | null;
  starred: boolean;
  createdAt: string;
  lastActivityAt: string;
  pipeline?: { id: string; name: string };
  _count?: { activities: number };
}

export interface CrmActivity {
  id: string;
  type: string;
  body?: string | null;
  actor?: string | null;
  createdAt: string;
}

export const SOURCE_LABELS: Record<string, string> = {
  website_form: "Web form",
  phone: "Phone",
  referral: "Referral",
  import: "Import",
  ad: "Paid ad",
  ooh: "Billboard/OOH",
  direct_mail: "Direct mail",
  other: "Other",
};

export function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
