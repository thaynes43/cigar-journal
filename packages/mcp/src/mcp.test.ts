import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerClient,
  getClient,
  validateAuthorizationParams,
  createAuthorizationTransaction,
  grantConsent,
  exchangeAuthorizationCode,
} from "@cj/oauth";
import { createHarness, type DomainHarness } from "@cj/domain/testing";
import type { Principal } from "@cj/domain";
import { buildApp } from "./app.js";
import { INSTRUCTIONS } from "./constants.js";

// End-to-end over the real HTTP surface: an embedded Postgres (domain harness),
// the app's own OAuth authorization server to mint genuine audience-bound tokens,
// and the official MCP SDK client speaking Streamable HTTP at /mcp. The adapter
// is exercised exactly as ChatGPT Web / Claude Code / Codex would.

const ORIGIN = "https://cigars.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example.com/callback";
const PRM = `${ORIGIN}/.well-known/oauth-protected-resource`;
const ALL_SCOPES = ["catalog:read", "journal:read", "journal:write", "offline_access"];

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface TextContent {
  type: string;
  text: string;
}

function payloadOf(result: CallToolResult): unknown {
  const content = result.content as TextContent[];
  return JSON.parse(content[0]!.text);
}

function errorOf(result: CallToolResult): Record<string, unknown> {
  expect(result.isError, `expected an isError result, got: ${JSON.stringify(result.content)}`).toBe(
    true,
  );
  const parsed = payloadOf(result) as { error: Record<string, unknown> };
  return parsed.error;
}

describe("@cj/mcp adapter", () => {
  let h: DomainHarness;
  let server: Server;
  let baseUrl: string;
  let owner: Principal;
  let other: Principal;
  let primaryCigarId: string;

  // Tokens minted through the full OAuth grant, per scope set.
  let ownerFull: string;
  let ownerCatalogOnly: string;
  let ownerCatalogJournal: string;
  let otherFull: string;

  async function mintToken(
    scopes: string[],
    userId: string,
  ): Promise<{ token: string; clientId: string }> {
    const db = h.pg.db;
    const reg = await registerClient(db, {
      redirect_uris: [REDIRECT],
      client_name: "Test Client",
      token_endpoint_auth_method: "none",
    });
    const client = await getClient(db, reg.client_id);
    const { verifier, challenge } = pkce();
    const validated = validateAuthorizationParams({
      responseType: "code",
      scope: scopes.join(" "),
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource: RESOURCE,
    });
    const { txnId } = await createAuthorizationTransaction(db, {
      client: client!,
      userId,
      redirectUri: REDIRECT,
      state: "s",
      validated,
    });
    const { redirectUrl } = await grantConsent(db, txnId, userId);
    const code = new URL(redirectUrl).searchParams.get("code")!;
    const tokens = await exchangeAuthorizationCode(db, {
      client: client!,
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
      resource: RESOURCE,
    });
    return { token: tokens.access_token, clientId: client!.clientId };
  }

  async function connectClient(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  async function withClient<T>(token: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const client = await connectClient(token);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }

  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_URL = ORIGIN;
    process.env.MCP_JSON_RESPONSE = "true";
    h = await createHarness();
    owner = await h.createUser("owner@example.com");
    other = await h.createUser("other@example.com");
    primaryCigarId = await h.seedCigar({
      canonicalName: "Plasencia Alma del Fuego Concepcion",
      brand: "Plasencia",
      line: "Alma del Fuego",
      vitolaName: "Concepcion",
      lengthInches: "6.0",
      ringGauge: 52,
      type: "NC",
      verification: "verified",
    });
    // Two identically-named catalog rows force cigar_ambiguous on a described save.
    await h.seedCigar({ canonicalName: "Ambiguity Twin Robusto" });
    await h.seedCigar({ canonicalName: "Ambiguity Twin Robusto" });

    const app = buildApp(h.deps);
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    ownerFull = (await mintToken(ALL_SCOPES, owner.userId)).token;
    ownerCatalogOnly = (await mintToken(["catalog:read"], owner.userId)).token;
    ownerCatalogJournal = (await mintToken(["catalog:read", "journal:read"], owner.userId)).token;
    otherFull = (await mintToken(ALL_SCOPES, other.userId)).token;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await h?.stop();
  });

  // ---- auth -----------------------------------------------------------------

  it("rejects a request with no bearer token: 401 + WWW-Authenticate resource_metadata", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${PRM}"`);
  });

  it("rejects a tools/call the token lacks scope for: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogOnly}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "save_smoke", arguments: {} },
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
  });

  it("healthz returns 200", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toEqual({ status: "ok" });
  });

  // ---- discovery ------------------------------------------------------------

  it("lists exactly the six tools with readOnlyHint on the four reads, and sends the contract instructions", async () => {
    await withClient(ownerFull, async (client) => {
      expect(client.getInstructions()).toBe(INSTRUCTIONS);

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "get_cigar",
          "get_my_smokes",
          "get_smoke",
          "save_smoke",
          "search_cigars",
          "update_smoke",
        ].sort(),
      );

      const readOnly = (name: string): boolean | undefined =>
        tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
      for (const r of ["search_cigars", "get_cigar", "get_my_smokes", "get_smoke"])
        expect(readOnly(r)).toBe(true);
      for (const w of ["save_smoke", "update_smoke"]) expect(readOnly(w)).not.toBe(true);
    });
  });

  // ---- read happy paths + scope-bounding ------------------------------------

  it("search_cigars resolves a seeded cigar; personal userSmokeCount is journal:read-bounded", async () => {
    // "Plasencia" is only a brand → brand_match, returning that brand's cigars.
    // Without journal:read — no personal field.
    await withClient(ownerCatalogOnly, async (client) => {
      const result = await call(client, "search_cigars", { query: "Plasencia" });
      const data = payloadOf(result) as { matches: Record<string, unknown>[]; guidance: string };
      expect(data.guidance).toBe("brand_match");
      expect(data.matches[0]!.cigarId).toBe(primaryCigarId);
      expect(data.matches[0]).not.toHaveProperty("userSmokeCount");
    });
    // With journal:read — the personal field appears.
    await withClient(ownerCatalogJournal, async (client) => {
      const result = await call(client, "search_cigars", { query: "Plasencia" });
      const data = payloadOf(result) as { matches: Record<string, unknown>[] };
      expect(data.matches[0]).toHaveProperty("userSmokeCount");
    });
  });

  it("get_cigar returns catalog detail; personalProfile is journal:read-bounded", async () => {
    await withClient(ownerCatalogOnly, async (client) => {
      const result = await call(client, "get_cigar", { cigarId: primaryCigarId });
      const data = payloadOf(result) as Record<string, unknown>;
      expect((data.cigar as { canonicalName: string }).canonicalName).toContain("Alma del Fuego");
      expect(data).not.toHaveProperty("personalProfile");
    });
    await withClient(ownerCatalogJournal, async (client) => {
      const result = await call(client, "get_cigar", { cigarId: primaryCigarId });
      const data = payloadOf(result) as Record<string, unknown>;
      expect(data).toHaveProperty("personalProfile"); // present (may be null) with journal:read
    });
  });

  // ---- write happy path + sparse validity -----------------------------------

  it("saves a sparse smoke (cigarId + one substantive field) and reads it back", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["citrus", "cream"],
      });
      const data = payloadOf(result) as {
        smoke: { smokeId: string; version: number; url: string; cigar: { cigarId: string } };
        cigarCreated: boolean;
        replayed: boolean;
      };
      expect(data.smoke.version).toBe(1);
      expect(data.smoke.url).toBe(`${ORIGIN}/smokes/${data.smoke.smokeId}`);
      expect(data.smoke.cigar.cigarId).toBe(primaryCigarId);
      expect(data.cigarCreated).toBe(false);
      expect(data.replayed).toBe(false);

      const listed = await call(client, "get_my_smokes", { cigarId: primaryCigarId });
      const list = payloadOf(listed) as { smokes: { smokeId: string }[]; totalMatches: number };
      expect(list.smokes.some((s) => s.smokeId === data.smoke.smokeId)).toBe(true);
    });
  });

  it("get_my_smokes summaries stay contract-stable: no web-only progressionPositions", async () => {
    await withClient(ownerFull, async (client) => {
      await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        progression: [
          { stage: "opening", approximatePosition: 0.1, verbatim: "start" },
          { stage: "finish", approximatePosition: 0.9, verbatim: "Sparkline contract marker." },
        ],
        journal: { narrative: "Sparkline contract marker." },
      });

      // Text query → match provenance present; the web-only sparkline field is not.
      const byText = payloadOf(
        await call(client, "get_my_smokes", { text: "Sparkline contract marker." }),
      ) as { smokes: Record<string, unknown>[] };
      expect(byText.smokes.length).toBeGreaterThanOrEqual(1);
      for (const s of byText.smokes) expect(s).not.toHaveProperty("progressionPositions");
      expect(byText.smokes[0]).toHaveProperty("matchedIn");
      expect(byText.smokes[0]).toHaveProperty("descriptors");

      // Non-text query stays byte-for-byte: no progressionPositions, no match keys.
      const byCigar = payloadOf(
        await call(client, "get_my_smokes", { cigarId: primaryCigarId }),
      ) as { smokes: Record<string, unknown>[] };
      for (const s of byCigar.smokes) {
        expect(s).not.toHaveProperty("progressionPositions");
        expect(s).not.toHaveProperty("matchedIn");
        expect(s).not.toHaveProperty("matchSnippet");
      }
    });
  });

  // ---- error shapes ---------------------------------------------------------

  it("cigar_ambiguous: described name matching two catalog rows returns candidates", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { described: { canonicalName: "Ambiguity Twin Robusto" } },
        overallDescriptors: ["earth"],
      });
      const error = errorOf(result);
      expect(error.code).toBe("cigar_ambiguous");
      expect(error.recoverable).toBe(true);
      expect((error.action as { type: string }).type).toBe("ask_user");
      expect((error.candidates as unknown[]).length).toBe(2);
    });
  });

  it("validation_error: a string rating carries the field path assessment.rating", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["cedar"],
        assessment: { rating: "really good" },
      });
      const error = errorOf(result);
      expect(error.code).toBe("validation_error");
      const fields = error.fields as { path: string }[];
      expect(fields.some((f) => f.path === "assessment.rating")).toBe(true);
    });
  });

  it("validation_error: an out-of-range approximatePosition carries its indexed field path", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        progression: [{ approximatePosition: 4, verbatim: "way past the end" }],
      });
      const error = errorOf(result);
      expect(error.code).toBe("validation_error");
      const fields = error.fields as { path: string }[];
      expect(fields.some((f) => f.path === "progression[0].approximatePosition")).toBe(true);
    });
  });

  it("smoke_not_found: a cross-user get_smoke never leaks another user's smoke", async () => {
    // Owner saves a smoke.
    const smokeId = await withClient(ownerFull, async (client) => {
      const result = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        journal: { narrative: "A private entry only the owner may read." },
      });
      return (payloadOf(result) as { smoke: { smokeId: string } }).smoke.smokeId;
    });
    // A different user asks for it by id → not-found (existence never leaked).
    await withClient(otherFull, async (client) => {
      const result = await call(client, "get_smoke", { smokeId });
      expect(errorOf(result).code).toBe("smoke_not_found");
    });
  });

  it("version_conflict: a stale expectedVersion returns expected/current versions", async () => {
    await withClient(ownerFull, async (client) => {
      const saved = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["leather"],
      });
      const smokeId = (payloadOf(saved) as { smoke: { smokeId: string } }).smoke.smokeId;

      const result = await call(client, "update_smoke", {
        clientRequestId: randomUUID(),
        smokeId,
        expectedVersion: 2, // current is 1
        changes: { assessment: { rating: 90 } },
      });
      const error = errorOf(result);
      expect(error.code).toBe("version_conflict");
      expect(error.expectedVersion).toBe(2);
      expect(error.currentVersion).toBe(1);
    });
  });

  it("idempotent replay: the same clientRequestId + args returns replayed:true and no duplicate", async () => {
    await withClient(ownerFull, async (client) => {
      const clientRequestId = randomUUID();
      const args = {
        clientRequestId,
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["nutmeg"],
        journal: { narrative: "Replay-safety check." },
      };
      const first = payloadOf(await call(client, "save_smoke", args)) as {
        smoke: { smokeId: string };
        replayed: boolean;
      };
      expect(first.replayed).toBe(false);

      const second = payloadOf(await call(client, "save_smoke", args)) as {
        smoke: { smokeId: string };
        replayed: boolean;
      };
      expect(second.replayed).toBe(true);
      expect(second.smoke.smokeId).toBe(first.smoke.smokeId);

      const list = payloadOf(
        await call(client, "get_my_smokes", { text: "Replay-safety check." }),
      ) as {
        totalMatches: number;
      };
      expect(list.totalMatches).toBe(1);
    });
  });

  it("idempotency_conflict: the same clientRequestId with different args is rejected", async () => {
    await withClient(ownerFull, async (client) => {
      const clientRequestId = randomUUID();
      await call(client, "save_smoke", {
        clientRequestId,
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["coffee"],
      });
      const result = await call(client, "save_smoke", {
        clientRequestId,
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["coffee", "chocolate"], // different intent, same key
      });
      const error = errorOf(result);
      expect(error.code).toBe("idempotency_conflict");
      expect(error.recoverable).toBe(false);
    });
  });

  it("injected userId is rejected by the strict schema and never used for authz", async () => {
    await withClient(otherFull, async (client) => {
      const result = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["smoke-test"],
        userId: owner.userId, // attempt to write as someone else
      });
      // Strict schema rejects the unknown top-level key → isError, no write.
      expect(result.isError).toBe(true);

      // Nothing was written for the injected user id; the token's user governs.
      const asOwner = await call(client, "get_my_smokes", { descriptor: "smoke-test" });
      // `other` (this token's user) has no such smoke either — the call never ran.
      const list = payloadOf(asOwner) as { totalMatches: number };
      expect(list.totalMatches).toBe(0);
    });
  });

  // ---- conversational end-to-end --------------------------------------------

  it("conversation: search (no match) → save described → list → get → update rating → replay update", async () => {
    await withClient(ownerFull, async (client) => {
      // 1. The user names a cigar not in the catalog.
      const search = payloadOf(
        await call(client, "search_cigars", { query: "Nonexistent Nebula 9000" }),
      ) as {
        guidance: string;
        matches: unknown[];
      };
      expect(search.guidance).toBe("no_match");
      expect(search.matches.length).toBe(0);

      // 2. At finalize, save with described attributes → lazy catalog create.
      const saveReqId = randomUUID();
      const saved = payloadOf(
        await call(client, "save_smoke", {
          clientRequestId: saveReqId,
          cigar: { described: { canonicalName: "Nebula 9000 Toro", brand: "Nebula", type: "NC" } },
          overallDescriptors: ["spice", "cream"],
          progression: [
            {
              stage: "opening",
              approximatePosition: 0.05,
              descriptors: ["black-pepper"],
              verbatim: "Peppery start.",
            },
          ],
          assessment: { liked: true, impression: "Promising unknown stick." },
          journal: { title: "Nebula debut", narrative: "First time with this one." },
        }),
      ) as {
        smoke: { smokeId: string; version: number; cigar: { cigarId: string } };
        cigarCreated: boolean;
      };
      expect(saved.cigarCreated).toBe(true);
      const smokeId = saved.smoke.smokeId;
      const createdCigarId = saved.smoke.cigar.cigarId;

      // 3. History shows the new smoke (filter by the freshly-created cigar).
      const list = payloadOf(await call(client, "get_my_smokes", { cigarId: createdCigarId })) as {
        smokes: { smokeId: string }[];
      };
      expect(list.smokes.some((s) => s.smokeId === smokeId)).toBe(true);

      // 4. Full detail round-trips (verbatim + provenance).
      const full = payloadOf(await call(client, "get_smoke", { smokeId })) as {
        smoke: {
          progression: { verbatim: string }[];
          provenance: { source: string; client: string };
        };
      };
      expect(full.smoke.progression[0]!.verbatim).toContain("Peppery start.");
      expect(full.smoke.provenance.source).toBe("llm-conversation");
      expect(full.smoke.provenance.client).toBeTruthy();

      // 5. Correct the rating.
      const updateReqId = randomUUID();
      const updateArgs = {
        clientRequestId: updateReqId,
        smokeId,
        changes: { assessment: { rating: 90 } },
      };
      const updated = payloadOf(await call(client, "update_smoke", updateArgs)) as {
        smoke: { version: number };
        changedFields: string[];
        replayed: boolean;
      };
      expect(updated.smoke.version).toBe(2);
      expect(updated.changedFields).toContain("assessment.rating");
      expect(updated.replayed).toBe(false);

      // 6. Replaying the same correction is idempotent — no double-apply.
      const replay = payloadOf(await call(client, "update_smoke", updateArgs)) as {
        smoke: { version: number };
        replayed: boolean;
      };
      expect(replay.replayed).toBe(true);
      expect(replay.smoke.version).toBe(2);
    });
  });
});
