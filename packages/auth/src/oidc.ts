// Authentik OIDC configuration (ADR-010). Read from env, NEVER thrown from: a
// missing or malformed value degrades to "SSO is off" and the local email+password
// path is untouched. A throw here would 500 the whole auth handler — including
// /signin — which is exactly the lockout this feature must not be able to cause.

export const AUTHENTIK_PROVIDER_ID = "authentik";

export interface OidcConfig {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  // The stable account namespace for `account.issuer`. Passed explicitly because
  // better-auth's generic-oauth plugin THROWS at init when discovery is
  // unreachable and no issuer was configured; with it set, an Authentik outage
  // logs an error and leaves the provider inert instead of breaking sign-in.
  issuer: string;
}

// `<issuer>/.well-known/openid-configuration` is the discovery convention, and
// Authentik's issuer keeps its trailing slash (`.../application/o/<slug>/`).
function issuerFromDiscoveryUrl(url: URL): string {
  const issuer = new URL(url.href);
  issuer.search = "";
  issuer.hash = "";
  issuer.pathname = issuer.pathname.replace(/\.well-known\/openid-configuration\/?$/, "");
  return issuer.href;
}

export function readOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();
  const discoveryUrl = env.OIDC_DISCOVERY_URL?.trim();
  if (!clientId || !clientSecret || !discoveryUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(discoveryUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

  return { clientId, clientSecret, discoveryUrl, issuer: issuerFromDiscoveryUrl(parsed) };
}
