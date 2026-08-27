// @cj/oauth — the app's OAuth 2.1 authorization server for MCP (ADR-004/005),
// ported from the Phase 0 spike's proven OAuthServerProvider shape onto Postgres.
// Depends only on @cj/db (+ @cj/domain types) so the out-of-process MCP resource
// server can validate tokens without pulling Better Auth. The web app mounts the
// endpoints (metadata, /oauth/authorize, /oauth/token, /oauth/register,
// /oauth/revoke) and the consent UI as thin adapters over these functions.

export {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  AUTHORIZATION_TTL_SECONDS,
  CODE_TTL_SECONDS,
  SUPPORTED_SCOPES,
  SCOPE_DESCRIPTIONS,
  issuerOrigin,
  mcpResource,
  resourceMatches,
  type SupportedScope,
} from "./config.js";

export {
  authorizationServerMetadata,
  protectedResourceMetadata,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
} from "./metadata.js";

export { OAuthError, type OAuthErrorCode } from "./errors.js";
export { authEvent, type AuthEventName } from "./logger.js";

export {
  registerClient,
  getClient,
  authenticateClient,
  resolveAuthorizationClient,
  validateAuthorizationParams,
  createAuthorizationTransaction,
  getConsentView,
  grantConsent,
  denyConsent,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  revoke,
  type TokenResponse,
  type ClientRegistrationRequest,
  type RegisteredClient,
  type AuthorizationParams,
  type ValidatedAuthorization,
  type ConsentView,
} from "./provider.js";

export {
  validateAccessToken,
  type ValidateResult,
  type TokenErrorCode,
} from "./validate.js";
