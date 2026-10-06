// ShapesOS on AWS — deployment settings, read from CDK context
// (cdk.json defaults; override with `-c key=value`). No AWS lookups: the app
// synthesizes with no credentials (CI runs `cdk synth` without any).

export interface ShapesConfig {
  /** Account id; required only to deploy outside us-east-1 (cross-region edge references). */
  account?: string;
  /** Region for the network, data, app, edge and ops stacks. */
  region: string;
  /** Explicit Availability Zones (names). CloudFront VPC origins don't support use1-az3. */
  availabilityZones?: string[];
  /** Website host; the OS is app.<domain>. */
  domain: string;
  /** Route 53 hosted zone of `domain` (no lookup); when set, certificates validate and aliases are created automatically. */
  hostedZoneId?: string;
  /** Add one NAT gateway for a fixed outbound IP (tasks move to private subnets). */
  natGateway: boolean;
  /** Image tag web and worker run (releases deploy git sha tags). */
  imageTag: string;
  /** Image tag of the migrate task (a release migrates with the new tag first); defaults to imageTag. */
  migrateImageTag: string;
  logRetentionDays: number;
  monthlyBudgetUsd: number;
  alarmEmail?: string;
  githubRepo: string;
  githubEnvironment: string;
}

type ContextReader = (key: string) => unknown;

const truthy = (v: unknown) => v === true || v === "true" || v === "1";

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function num(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`context ${name} must be a positive number`);
  return n;
}

export function readConfig(ctx: ContextReader): ShapesConfig {
  const region = str(ctx("region")) ?? "us-east-1";
  const domain = (str(ctx("domain")) ?? "shapesos.com").toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Error(`context domain is not a domain name: ${domain}`);
  const account = str(ctx("account"));
  if (account && !/^\d{12}$/.test(account)) throw new Error("context account must be a 12-digit AWS account id");
  if (region !== "us-east-1" && !account) {
    throw new Error("deploying outside us-east-1 needs -c account=<id>: the CloudFront certificate and WAF live in us-east-1 and are referenced across regions");
  }
  const azs = str(ctx("availabilityZones"))?.split(",").map((s) => s.trim()).filter(Boolean);
  if (azs && azs.length !== 2) throw new Error("context availabilityZones must name exactly 2 zones");
  const logRetentionDays = num(ctx("logRetentionDays"), 30, "logRetentionDays");
  return {
    account,
    region,
    availabilityZones: azs,
    domain,
    hostedZoneId: str(ctx("hostedZoneId")),
    natGateway: truthy(ctx("natGateway")),
    imageTag: str(ctx("imageTag")) ?? "latest",
    migrateImageTag: str(ctx("migrateImageTag")) ?? str(ctx("imageTag")) ?? "latest",
    logRetentionDays,
    monthlyBudgetUsd: num(ctx("monthlyBudgetUsd"), 2000, "monthlyBudgetUsd"),
    alarmEmail: str(ctx("alarmEmail")),
    githubRepo: str(ctx("githubRepo")) ?? "Villain336/ShapesOS",
    githubEnvironment: str(ctx("githubEnvironment")) ?? "production",
  };
}

export const appHost = (c: ShapesConfig) => `app.${c.domain}`;
export const appOrigin = (c: ShapesConfig) => `https://${appHost(c)}`;
