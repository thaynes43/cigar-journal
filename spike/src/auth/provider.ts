// A deliberately small OAuth 2.1 authorization server + resource server for the
// spike. Backed by the MCP TypeScript SDK's OAuthServerProvider interface, so
// the SDK's mcpAuthRouter gives us RFC 8414/9728 metadata, DCR (RFC 7591),
// authorization-code + PKCE (S256) and token/revocation endpoints for free.
//
// We supply: a login/consent gate (single shared passcode), audience binding
// (RFC 8707), short access tokens, and rotating refresh tokens. Clients and
// refresh tokens are persisted to a JSON file; codes and access tokens are
// in-memory (ephemeral by design).

import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidRequestError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { SpikeConfig } from "../config.js";
import { authEvent } from "../logger.js";

// The single spike user everyone authenticates as after the passcode gate.
const SPIKE_USER = { id: "spike-user", email: "spike@cigars.haynesnetwork.com" };

interface PendingAuth {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  createdAt: number;
}

interface CodeRecord {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  userId: string;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  userId: string;
  expiresAt: number;
}

interface RefreshRecord {
  clientId: string;
  scopes: string[];
  resource: string;
  userId: string;
}

interface AuthPersist {
  clients: Record<string, OAuthClientInformationFull>;
  refreshTokens: Record<string, RefreshRecord>;
}

const CODE_TTL_MS = 60_000;

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly provider: SpikeOAuthProvider) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.provider.clients.get(clientId);
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.provider.clients.set(client.client_id, client);
    this.provider.persist();
    authEvent("client_registered", {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUris: client.redirect_uris,
      tokenAuthMethod: client.token_endpoint_auth_method,
      grantTypes: client.grant_types,
      scope: client.scope,
    });
    return client;
  }
}

export class SpikeOAuthProvider implements OAuthServerProvider {
  readonly clients = new Map<string, OAuthClientInformationFull>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly accessTokens = new Map<string, TokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshRecord>();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly _clientsStore = new ClientsStore(this);

  constructor(private readonly config: SpikeConfig) {
    this.restore();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  // ---- persistence (clients + refresh tokens only) ----

  persist(): void {
    const data: AuthPersist = {
      clients: Object.fromEntries(this.clients),
      refreshTokens: Object.fromEntries(this.refreshTokens),
    };
    try {
      mkdirSync(dirname(this.config.authStateFile), { recursive: true });
      writeFileSync(this.config.authStateFile, JSON.stringify(data, null, 2));
    } catch (err) {
      authEvent("persist_failed", { error: String(err) });
    }
  }

  private restore(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.config.authStateFile, "utf8")) as AuthPersist;
      for (const [id, c] of Object.entries(parsed.clients ?? {})) this.clients.set(id, c);
      for (const [t, r] of Object.entries(parsed.refreshTokens ?? {})) this.refreshTokens.set(t, r);
      authEvent("state_restored", {
        clients: this.clients.size,
        refreshTokens: this.refreshTokens.size,
      });
    } catch {
      // fresh start
    }
  }

  // ---- authorization-code flow ----

  /** Called by the SDK authorize handler. We divert to a login/consent page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestedResource = params.resource?.href;
    if (requestedResource && !this.resourceMatches(requestedResource)) {
      authEvent("audience_mismatch", {
        phase: "authorize",
        clientId: client.client_id,
        requested: requestedResource,
        expected: this.config.resourceUrl,
      });
      throw new InvalidTargetError(`Unknown resource indicator: ${requestedResource}`);
    }
    const txn = randomUUID();
    this.pending.set(txn, { client, params, createdAt: Date.now() });
    authEvent("authorize_started", {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      scopes: params.scopes,
      resource: requestedResource ?? "(none — will default to server resource)",
      txn,
    });
    res.redirect(302, `/login?txn=${encodeURIComponent(txn)}`);
  }

  getPending(txn: string): PendingAuth | undefined {
    return this.pending.get(txn);
  }

  /** Login route calls this after the passcode + consent check. Returns the client redirect. */
  completeAuthorization(txn: string): string {
    const p = this.pending.get(txn);
    if (!p) throw new InvalidRequestError("Unknown or expired authorization transaction");
    this.pending.delete(txn);

    const code = randomBytes(24).toString("hex");
    const resource = p.params.resource?.href ?? this.config.resourceUrl;
    this.codes.set(code, {
      clientId: p.client.client_id,
      codeChallenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      scopes: p.params.scopes ?? [],
      resource,
      userId: SPIKE_USER.id,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    authEvent("code_issued", { clientId: p.client.client_id, scopes: p.params.scopes, resource });

    const redirect = new URL(p.params.redirectUri);
    redirect.searchParams.set("code", code);
    if (p.params.state) redirect.searchParams.set("state", p.params.state);
    return redirect.href;
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
    const rec = this.codes.get(code);
    if (!rec) throw new InvalidGrantError("Invalid authorization code");
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.codes.get(code);
    if (!rec) throw new InvalidGrantError("Invalid authorization code");
    this.codes.delete(code);
    if (rec.clientId !== client.client_id) throw new InvalidGrantError("Authorization code was issued to another client");
    if (rec.expiresAt < Date.now()) throw new InvalidGrantError("Authorization code expired");
    if (resource && !this.resourceMatches(resource.href)) {
      authEvent("audience_mismatch", {
        phase: "token",
        clientId: client.client_id,
        requested: resource.href,
        expected: this.config.resourceUrl,
      });
      throw new InvalidTargetError(`Unknown resource indicator: ${resource.href}`);
    }
    const tokens = this.issueTokens(client.client_id, rec.scopes, rec.resource, rec.userId);
    authEvent("code_exchanged", {
      clientId: client.client_id,
      scopes: rec.scopes,
      resource: rec.resource,
      accessTokenTtlSeconds: this.config.accessTokenTtlSeconds,
      offlineAccess: rec.scopes.includes("offline_access"),
    });
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const rec = this.refreshTokens.get(refreshToken);
    if (!rec) throw new InvalidGrantError("Invalid refresh token");
    if (rec.clientId !== client.client_id) throw new InvalidGrantError("Refresh token was issued to another client");
    if (resource && !this.resourceMatches(resource.href)) {
      authEvent("audience_mismatch", { phase: "refresh", clientId: client.client_id, requested: resource.href, expected: this.config.resourceUrl });
      throw new InvalidTargetError(`Unknown resource indicator: ${resource.href}`);
    }
    // Rotate: invalidate the presented refresh token and mint a fresh pair.
    this.refreshTokens.delete(refreshToken);
    const grantedScopes = scopes && scopes.length > 0 ? scopes.filter((s) => rec.scopes.includes(s)) : rec.scopes;
    const tokens = this.issueTokens(client.client_id, grantedScopes, rec.resource, rec.userId);
    authEvent("refresh_rotated", {
      clientId: client.client_id,
      oldRefreshToken: mask(refreshToken),
      newRefreshToken: mask(tokens.refresh_token ?? ""),
      scopes: grantedScopes,
    });
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.accessTokens.get(token);
    if (!rec) throw new Error("invalid_token");
    if (rec.expiresAt < Date.now()) {
      this.accessTokens.delete(token);
      throw new Error("token_expired");
    }
    // RFC 8707 audience check: token must be bound to this MCP resource.
    if (!this.resourceMatches(rec.resource)) {
      authEvent("audience_mismatch", { phase: "verify", requested: rec.resource, expected: this.config.resourceUrl });
      throw new Error("audience_mismatch");
    }
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: Math.floor(rec.expiresAt / 1000),
      resource: new URL(rec.resource),
      extra: { userId: rec.userId, email: SPIKE_USER.email },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const t = request.token;
    const wasAccess = this.accessTokens.delete(t);
    const wasRefresh = this.refreshTokens.delete(t);
    if (wasRefresh) this.persist();
    authEvent("token_revoked", { kind: wasAccess ? "access" : wasRefresh ? "refresh" : "unknown", token: mask(t) });
  }

  // ---- helpers ----

  private issueTokens(clientId: string, scopes: string[], resource: string, userId: string): OAuthTokens {
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + this.config.accessTokenTtlSeconds * 1000;
    this.accessTokens.set(accessToken, { clientId, scopes, resource, userId, expiresAt });
    this.refreshTokens.set(refreshToken, { clientId, scopes, resource, userId });
    this.persist();
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: scopes.join(" "),
      refresh_token: refreshToken,
    };
  }

  private resourceMatches(resource: string): boolean {
    // Compare ignoring a trailing slash difference.
    const norm = (s: string) => s.replace(/\/+$/, "");
    return norm(resource) === norm(this.config.resourceUrl);
  }
}

function mask(token: string): string {
  return token.length <= 8 ? "***" : `${token.slice(0, 4)}…${token.slice(-4)}`;
}
