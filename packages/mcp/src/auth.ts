import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Database } from "@cj/db";
import type { Principal } from "@cj/domain";
import { validateAccessToken, mcpResource } from "@cj/oauth";
import { TOOL_SCOPES, isToolName } from "./constants.js";
import { protectedResourceMetadataUrl } from "./config.js";
import { mcpEvent } from "./logger.js";

// Bearer-token gate for every /mcp request — the ONLY authorization path
// (ADR-004/005). validateAccessToken (@cj/oauth) is the whole check: a hash
// lookup + audience + scope, learned entirely from @cj/db (this process never
// calls back to the authorization server). The Principal comes ONLY from the
// token; a `userId` in tool arguments is never consulted for authz.
//
// Two failure classes, per RFC 6750 / RFC 9728:
//   missing / invalid / expired / wrong-audience → 401 + WWW-Authenticate
//     pointing at the protected-resource metadata (client re-runs OAuth).
//   valid token, insufficient scope for the tool  → 403.

// The AuthInfo the transport reads off req.auth and forwards to tool handlers
// as extra.authInfo. `extra.principal` carries the server-derived identity.
export interface McpAuthExtra extends Record<string, unknown> {
  principal: Principal;
}

type AuthedRequest = Request & { auth?: AuthInfo };

/** Scopes the request demands at the HTTP layer: a tools/call needs the named
 *  tool's scope; every other method (initialize, tools/list, ping, GET/DELETE) just
 *  needs a valid token. validateAccessToken enforces these ALL-of, so this returns
 *  only the scope EVERY acceptable caller must hold: a single-scope tool returns
 *  that scope; a tool that accepts ALTERNATIVES (get_cigar: catalog:read OR
 *  curation:read — TOOL_SCOPES lists both) has no universally-required scope, so it
 *  returns [] and defers to assertToolScope's any-of check inside the handler. That
 *  in-handler backstop runs on every call, so authorization is unchanged — a
 *  scope-short get_cigar is still rejected, as the contract's `unauthorized`. */
export function requiredScopesForBody(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const message = body as { method?: unknown; params?: unknown };
  if (message.method !== "tools/call") return [];
  const params = message.params as { name?: unknown } | undefined;
  const name = params?.name;
  if (typeof name === "string" && isToolName(name)) {
    const accepted = TOOL_SCOPES[name];
    return accepted.length === 1 ? accepted : [];
  }
  return [];
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer (.+)$/i.exec(header);
  return match?.[1];
}

function challenge(): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl()}"`;
}

export function bearerAuth(db: Database): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handle(db, req, res, next);
  };
}

async function handle(db: Database, req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    mcpEvent("auth_rejected", { reason: "no_bearer" });
    res
      .status(401)
      .set("WWW-Authenticate", challenge())
      .json({ error: "unauthenticated", error_description: "Bearer token required." });
    return;
  }

  const requiredScopes = requiredScopesForBody(req.body);
  const result = await validateAccessToken(db, token, requiredScopes);

  if (!result.ok) {
    if (result.error === "insufficient_scope") {
      mcpEvent("auth_rejected", { reason: "insufficient_scope", required: requiredScopes });
      res
        .status(403)
        .set("WWW-Authenticate", `Bearer error="insufficient_scope", resource_metadata="${protectedResourceMetadataUrl()}"`)
        .json({ error: "insufficient_scope" });
      return;
    }
    mcpEvent("auth_rejected", { reason: result.error });
    res
      .status(401)
      .set("WWW-Authenticate", challenge())
      .json({ error: "unauthenticated", error_description: result.error });
    return;
  }

  const extra: McpAuthExtra = { principal: result.principal };
  (req as AuthedRequest).auth = {
    token,
    clientId: result.clientId,
    scopes: result.scopes,
    resource: new URL(mcpResource()),
    extra,
  };
  next();
}
