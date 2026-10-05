// ShapesOS — Phase 14 (connectors): which Gusto environment this deployment
// talks to (PURE; shared by the OAuth config and the API client).
//
// GUSTO_ENVIRONMENT=production → https://api.gusto.com; anything else (incl.
// unset) → https://api.gusto-demo.com, so nothing real happens until a person
// deliberately switches a deployment to production keys. Both the OAuth
// endpoints (/oauth/authorize, /oauth/token) and the API live on that host
// (docs.gusto.com/app-integrations/docs/oauth2; demo base URL from the
// App Integrations introduction).

export type GustoEnvironment = "demo" | "production";

export const GUSTO_DEMO_BASE_URL = "https://api.gusto-demo.com";
export const GUSTO_PRODUCTION_BASE_URL = "https://api.gusto.com";

export function gustoEnvironment(env: NodeJS.ProcessEnv = process.env): GustoEnvironment {
  return (env.GUSTO_ENVIRONMENT ?? "").trim().toLowerCase() === "production" ? "production" : "demo";
}

export function gustoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return gustoEnvironment(env) === "production" ? GUSTO_PRODUCTION_BASE_URL : GUSTO_DEMO_BASE_URL;
}
