// OAuth protocol errors (RFC 6749 §5.2, RFC 7591, RFC 8707). Thrown by the
// provider and mapped by the route adapters to the RFC status + JSON body. These
// are distinct from @cj/domain's DomainError taxonomy: these speak the OAuth
// wire protocol to clients, not the journal domain.

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target" // RFC 8707 — resource/audience not recognized
  | "access_denied"
  | "unsupported_response_type"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "server_error";

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toBody(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

export const invalidRequest = (d: string): OAuthError => new OAuthError("invalid_request", d);
export const invalidClient = (d: string): OAuthError => new OAuthError("invalid_client", d, 401);
export const invalidGrant = (d: string): OAuthError => new OAuthError("invalid_grant", d);
export const invalidTarget = (d: string): OAuthError => new OAuthError("invalid_target", d);
export const unsupportedGrantType = (d: string): OAuthError =>
  new OAuthError("unsupported_grant_type", d);
export const invalidScope = (d: string): OAuthError => new OAuthError("invalid_scope", d);
export const invalidRedirectUri = (d: string): OAuthError =>
  new OAuthError("invalid_redirect_uri", d);
export const invalidClientMetadata = (d: string): OAuthError =>
  new OAuthError("invalid_client_metadata", d);
