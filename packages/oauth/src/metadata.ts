import { issuerOrigin, mcpResource, SUPPORTED_SCOPES } from "./config.js";

// Discovery metadata the MCP clients consume before the flow (flow 003). Shapes
// match the Phase 0 spike (which used the MCP SDK's mcpAuthRouter and was proven
// against ChatGPT Web, Claude Code, and Codex): RFC 8414 for the authorization
// server, RFC 9728 for the protected resource.

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  response_modes_supported: string[];
  grant_types_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
}

export function authorizationServerMetadata(): AuthorizationServerMetadata {
  const origin = issuerOrigin();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Public PKCE clients use "none"; confidential clients may post a secret.
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    // PKCE S256 only — "plain" is rejected (OAuth 2.1).
    code_challenge_methods_supported: ["S256"],
  };
}

export function protectedResourceMetadata(): ProtectedResourceMetadata {
  return {
    resource: mcpResource(),
    authorization_servers: [issuerOrigin()],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Cigar Journal MCP",
  };
}
