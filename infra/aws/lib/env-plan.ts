// ShapesOS on AWS — the same env plan as Render, mapped onto ECS.
//
// scripts/deploy/render-env.mjs is the single source of truth for every env
// var (Render env groups AND this app read it, so they can't drift):
//   value     → plain container environment (URLs rewritten for `domain`)
//   generate  → one generated Secrets Manager secret per key
//   paste     → a key in the JSON secret shapesos/<group> (the owner fills it
//               in; scripts/deploy/runtime-env.mjs exports non-empty keys)
//   service / exclude → handled here explicitly, or not set
// AWS differences (S3 instead of R2, two proxies in front, RDS TLS) are the
// overrides below.

import { APP_ORIGIN, TABLE } from "../../../scripts/deploy/render-env.mjs";
import { appHost, appOrigin, type ShapesConfig } from "./config.ts";

export type Group = "shared" | "web" | "worker";

const GROUP_OF: Record<string, Group | "db"> = {
  "shapesos-shared": "shared",
  "shapesos-web": "web",
  "shapesos-worker": "worker",
  "shapesos-db-app": "db",
};

export interface GeneratedSecretSpec {
  key: string;
  group: Group;
  /** MARKETR_CREDENTIALS_KEY must be 64 hex characters (lib/sitefiles/crypto.ts). */
  hex: boolean;
}

export interface EnvPlan {
  values: Record<Group, Record<string, string>>;
  generated: GeneratedSecretSpec[];
  pasted: Record<Group, string[]>;
}

export interface AwsEnvInputs {
  filesBucketName: string;
}

export function awsEnvPlan(config: ShapesConfig, inputs: AwsEnvInputs): EnvPlan {
  const values: EnvPlan["values"] = { shared: {}, web: {}, worker: {} };
  const pasted: EnvPlan["pasted"] = { shared: [], web: [], worker: [] };
  const generated: GeneratedSecretSpec[] = [];

  for (const [key, spec] of TABLE as Array<[string, { cls: string; group?: string; value?: string }]>) {
    const g = spec.group ? GROUP_OF[spec.group] : undefined;
    if (g === "db" || !g) continue; // the database role is wired by the app stack
    if (spec.cls === "value") {
      let v = spec.value ?? "";
      if (v === APP_ORIGIN) v = appOrigin(config);
      if (key === "WEBSITE_HOST") v = config.domain;
      if (key === "APP_HOST") v = appHost(config);
      values[g][key] = v;
    } else if (spec.cls === "generate") {
      generated.push({ key, group: g, hex: key === "MARKETR_CREDENTIALS_KEY" });
    } else if (spec.cls === "paste") {
      pasted[g].push(key);
    }
  }

  // S3 in this account instead of Cloudflare R2. The access keys stay pasted
  // until the storage adapter reads the ECS task role (the role and its
  // least-privilege grant exist already).
  Object.assign(values.shared, {
    MARKETR_S3_ENDPOINT: `https://s3.${config.region}.amazonaws.com`,
    MARKETR_S3_REGION: config.region,
    MARKETR_S3_BUCKET: inputs.filesBucketName,
    MARKETR_S3_FORCE_PATH_STYLE: "true",
  });
  pasted.shared = pasted.shared.filter((k) => k !== "MARKETR_S3_ENDPOINT");
  // CloudFront → ALB → task: X-Forwarded-For is "<client>, <CloudFront>".
  values.web.TRUSTED_PROXY_HOPS = "2";
  // rds.force_ssl=1: node-postgres (Payload) reads PGSSLMODE when the URL has
  // no sslmode; Prisma's default (prefer) already uses TLS. Encrypts without
  // verifying the RDS CA — docs/deploy/AWS.md has the verify-full upgrade.
  values.shared.PGSSLMODE = "no-verify";
  return { values, generated, pasted };
}

/** The JSON skeleton the owner pastes into Secrets Manager shapesos/<group>. */
export function secretSkeleton(plan: EnvPlan, group: Group): Record<string, string> {
  return Object.fromEntries(plan.pasted[group].map((k) => [k, ""]));
}
