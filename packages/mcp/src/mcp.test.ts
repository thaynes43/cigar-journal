import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createMemoryPhotoStorage, type PhotoStorage } from "@cj/photos";
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
import {
  purchases,
  vendors,
  crawlRuns,
  enrichmentRequests,
  offers,
  listingMatches,
  productPhotos,
  auditLog,
  cigars,
  brands,
  lines,
  blends,
  blenders,
} from "@cj/db";
import { buildApp } from "./app.js";
import { INSTRUCTIONS, TOOL_SCOPES } from "./constants.js";
import { splitCigarSchema } from "./schemas.js";

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
  let storage: PhotoStorage;
  let owner: Principal;
  let other: Principal;
  let primaryCigarId: string;

  // A valid 8x8 PNG the shared pipeline decodes cleanly, served by a local fixture
  // HTTP server to stand in for ChatGPT's short-lived signed download_url.
  const PNG_FIXTURE = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4oaGBFTEMLQkAgl1GAXRgBQ4AAAAASUVORK5CYII=",
    "base64",
  );

  // Tokens minted through the full OAuth grant, per scope set.
  let ownerFull: string;
  let ownerCatalogOnly: string;
  let ownerCatalogJournal: string;
  let otherFull: string;
  // Curation surface (DESIGN-003 wave 4a): an admin principal carrying curation
  // scope (the ops agent), and the SAME scope on a non-admin user (the gate test).
  let adminUser: Principal;
  let adminCuration: string;
  let adminCurationClientId: string;
  let ownerCuration: string;

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

  // Enrichment-queue rows for one cigar, filtered in JS (this package does not
  // depend on drizzle-orm operators directly).
  async function enrichmentRows(
    cigarId: string,
  ): Promise<{ cigarId: string; status: string; requestedBy: string | null }[]> {
    const all = await h.pg.db.select().from(enrichmentRequests);
    return all.filter((r) => r.cigarId === cigarId);
  }

  // A chat/ad-hoc offer linked directly to a cigar (no listing match) — enough to
  // exercise browse_catalog's price/inStock surface and get_offers. The named
  // source satisfies the vendor-or-source CHECK; pricePerStickCents is the price
  // sort/tile key.
  async function seedAdhocOffer(
    cigarId: string,
    over: {
      pricePerStickCents?: number | null;
      price?: number | null;
      inStock?: boolean | null;
      seenAt?: Date;
      packaging?: string | null;
      sticksPerPackage?: number | null;
    } = {},
  ): Promise<void> {
    await h.pg.db.insert(offers).values({
      cigarId,
      sourceName: "Test Source",
      currency: "USD",
      inStock: over.inStock ?? true,
      seenAt: over.seenAt ?? new Date("2026-08-20T00:00:00Z"),
      packaging: over.packaging ?? "single",
      sticksPerPackage: over.sticksPerPackage ?? 1,
      price: over.price != null ? String(over.price) : null,
      pricePerStickCents: over.pricePerStickCents ?? null,
    });
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

    storage = createMemoryPhotoStorage();
    const app = buildApp(h.deps, storage);
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    ownerFull = (await mintToken(ALL_SCOPES, owner.userId)).token;
    ownerCatalogOnly = (await mintToken(["catalog:read"], owner.userId)).token;
    ownerCatalogJournal = (await mintToken(["catalog:read", "journal:read"], owner.userId)).token;
    otherFull = (await mintToken(ALL_SCOPES, other.userId)).token;

    adminUser = await h.createUser("curator@example.com", "admin");
    const adminCurationToken = await mintToken(["curation:read", "curation:write"], adminUser.userId);
    adminCuration = adminCurationToken.token;
    adminCurationClientId = adminCurationToken.clientId;
    ownerCuration = (await mintToken(["curation:read", "curation:write"], owner.userId)).token;
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

  it("lists exactly the thirty tools with readOnlyHint on the eight reads, and sends the contract instructions", async () => {
    await withClient(ownerFull, async (client) => {
      expect(client.getInstructions()).toBe(INSTRUCTIONS);

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "add_cigar",
          "add_smoke_photo",
          "browse_catalog",
          "get_cigar",
          "get_my_inventory",
          "get_my_smokes",
          "get_offers",
          "get_smoke",
          "record_price",
          "record_purchase",
          "request_cigar_enrichment",
          "save_smoke",
          "search_cigars",
          "set_favorite",
          "set_want",
          "update_cigar",
          "update_smoke",
          // curation surface (admin only)
          "get_curation_queue",
          "set_listing_match_status",
          "set_cigar_facts",
          "verify_cigar",
          "exclude_cigar",
          "restore_cigar",
          "set_product_photo_rights",
          "rename_cigar",
          "queue_enrichment_backlog",
          // taxonomy curation (ADR-012 Wave 3, issue #196)
          "register_taxonomy",
          "update_registry_aliases",
          "assign_cigar_taxonomy",
          "split_cigar",
        ].sort(),
      );

      const readOnly = (name: string): boolean | undefined =>
        tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
      for (const r of [
        "search_cigars",
        "get_cigar",
        "browse_catalog",
        "get_offers",
        "get_my_smokes",
        "get_smoke",
        "get_my_inventory",
        "get_curation_queue",
      ])
        expect(readOnly(r)).toBe(true);
      for (const w of [
        "save_smoke",
        "add_cigar",
        "record_purchase",
        "update_smoke",
        "add_smoke_photo",
        "set_want",
        "set_favorite",
        "request_cigar_enrichment",
        "update_cigar",
        "record_price",
        "set_listing_match_status",
        "set_cigar_facts",
        "verify_cigar",
        "exclude_cigar",
        "restore_cigar",
        "set_product_photo_rights",
        "rename_cigar",
        "queue_enrichment_backlog",
      ])
        expect(readOnly(w)).not.toBe(true);
    });
  });

  it("tools/list declares the add_smoke_photo file input and an outputSchema on every tool", async () => {
    await withClient(ownerFull, async (client) => {
      const { tools } = await client.listTools();

      // Every tool advertises a structured outputSchema (ChatGPT flags "Output
      // schema recommended" per tool). The SDK publishes it as a JSON object schema.
      for (const t of tools) {
        expect(t.outputSchema, `${t.name} is missing an outputSchema`).toBeDefined();
        expect((t.outputSchema as { type?: string }).type).toBe("object");
      }

      // add_smoke_photo DECLARES its file input: the tool-level _meta lists `image`,
      // and `image` is a real top-level input property — without both, ChatGPT never
      // forwards the attached photo (the owner-blocking bug).
      const photo = tools.find((t) => t.name === "add_smoke_photo")!;
      expect((photo._meta as Record<string, unknown> | undefined)?.["openai/fileParams"]).toEqual([
        "image",
      ]);
      const inputSchema = photo.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(inputSchema.properties ?? {}).toHaveProperty("image");
      // `image` stays OUT of required — a missing/partial file must never block the call.
      expect(inputSchema.required ?? []).not.toContain("image");
    });
  });

  it("tools/list publishes the exact add_smoke_photo `image` schema (manifest stability)", async () => {
    // A PIN, not a nicety, and after issue #202 experiment 1 it is the experiment's
    // own assertion: the published shape IS the change. Integrations that reportedly
    // receive files from ChatGPT declare a strict four-property file object, and
    // host-side hydration may key on the emitted schema rather than on the
    // `openai/fileParams` declaration alone — so the whole object is compared
    // WHOLE. A zod/SDK upgrade that adds a key, drops a description, or flips
    // `additionalProperties` back to `{}` silently rewrites the file-input
    // declaration ChatGPT reads; this fails first.
    await withClient(ownerFull, async (client) => {
      const { tools } = await client.listTools();
      const photo = tools.find((t) => t.name === "add_smoke_photo")!;
      const inputSchema = photo.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };

      expect(inputSchema.properties.image).toEqual({
        type: "object",
        properties: {
          download_url: {
            type: "string",
            description:
              "Host-provided signed download URL for the file. Set by the client, never by you.",
          },
          file_id: {
            type: "string",
            description: "Host-provided file id. Set by the client, never by you.",
          },
          mime_type: {
            type: "string",
            description: "File MIME type, if the host provided one.",
          },
          file_name: {
            type: "string",
            description: "Original file name, if the host provided one.",
          },
        },
        additionalProperties: false,
        description:
          "The user's attached photo. The client fills this when a file is attached to the message — never populate it, invent its fields, or paste a URL/id here yourself. Omit it and the tool returns a one-time upload link instead.",
      });

      // Restated outside the whole-object compare because they are the two
      // properties a well-meaning edit is most likely to break: no sub-field is
      // required, and `image` itself stays out of `required` — a partial or missing
      // file must never block the call.
      expect((inputSchema.properties.image as { required?: string[] }).required).toBeUndefined();
      expect(inputSchema.required ?? []).not.toContain("image");
      expect((photo._meta as Record<string, unknown> | undefined)?.["openai/fileParams"]).toEqual([
        "image",
      ]);
    });
  });

  it("tool results carry structuredContent identical to the text payload", async () => {
    // The SDK validates structuredContent against each outputSchema on every
    // successful call, so this asserts the additive structured output is present
    // and byte-for-byte the same object the text block already carries.
    await withClient(ownerCatalogOnly, async (client) => {
      const result = await call(client, "search_cigars", { query: "Plasencia" });
      expect(result.structuredContent).toEqual(payloadOf(result));
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
      expect(data).not.toHaveProperty("wanted"); // want overlay is journal:read-bounded
      expect(data).not.toHaveProperty("favorited"); // favorite overlay is journal:read-bounded
    });
    await withClient(ownerCatalogJournal, async (client) => {
      const result = await call(client, "get_cigar", { cigarId: primaryCigarId });
      const data = payloadOf(result) as Record<string, unknown>;
      expect(data).toHaveProperty("personalProfile"); // present (may be null) with journal:read
      expect(data).toHaveProperty("wanted"); // want overlay present with journal:read
      expect(data).toHaveProperty("favorited"); // favorite overlay present with journal:read
    });
  });

  // ---- browse_catalog (PRD-003 R-MCP-1) -------------------------------------

  interface BrowseTilePayload {
    cigarId: string;
    canonicalName: string;
    price: {
      perStick: boolean;
      amount: number;
      packaging: string | null;
      currency: string | null;
      seenAt: string;
    } | null;
    smokeCount?: number;
    myRating?: number | null;
    remaining?: number;
    wanted?: boolean;
    favorited?: boolean;
  }
  interface BrowsePayload {
    cigars: BrowseTilePayload[];
    nextCursor: string | null;
    totalCount: number;
  }

  it("browse_catalog: price-at-a-glance is catalog-scoped; personal overlay is journal:read-bounded", async () => {
    const brand = `MBrowseScope-${randomUUID().slice(0, 8)}`;
    const cigarId = await h.seedCigar({ canonicalName: `${brand} Toro`, brand, type: "NC" });
    await seedAdhocOffer(cigarId, { pricePerStickCents: 1670, packaging: "box", sticksPerPackage: 20 });

    // catalog:read only — price-at-a-glance present, NO personal overlay fields.
    await withClient(ownerCatalogOnly, async (client) => {
      const data = payloadOf(await call(client, "browse_catalog", { q: brand })) as BrowsePayload;
      const tile = data.cigars.find((c) => c.cigarId === cigarId)!;
      expect(tile.price).toEqual({
        perStick: true,
        amount: 16.7,
        packaging: "box",
        sticksPerPackage: 20,
        currency: "USD",
        seenAt: "2026-08-20T00:00:00.000Z",
      });
      expect(tile).not.toHaveProperty("smokeCount");
      expect(tile).not.toHaveProperty("myRating");
      expect(tile).not.toHaveProperty("remaining");
      expect(tile).not.toHaveProperty("wanted");
      expect(tile).not.toHaveProperty("favorited");
    });

    // With journal:read — the personal overlay appears; price stays.
    await withClient(ownerCatalogJournal, async (client) => {
      const result = await call(client, "browse_catalog", { q: brand });
      expect(result.structuredContent).toEqual(payloadOf(result)); // SDK-validated structured output
      const tile = (payloadOf(result) as BrowsePayload).cigars.find((c) => c.cigarId === cigarId)!;
      expect(tile).toHaveProperty("smokeCount");
      expect(tile).toHaveProperty("myRating");
      expect(tile).toHaveProperty("remaining");
      expect(tile).toHaveProperty("wanted");
      expect(tile).toHaveProperty("favorited");
      expect(tile.price?.perStick).toBe(true);
    });
  });

  it("browse_catalog composes independent overlay filters in one call (wanted AND NOT inHumidor AND inStock)", async () => {
    const brand = `MCombo-${randomUUID().slice(0, 8)}`;
    const match = await h.seedCigar({ canonicalName: `${brand} Match`, brand });
    const ownedToo = await h.seedCigar({ canonicalName: `${brand} Owned`, brand });
    const noStock = await h.seedCigar({ canonicalName: `${brand} NoStock`, brand });
    const notWanted = await h.seedCigar({ canonicalName: `${brand} NotWanted`, brand });

    await seedAdhocOffer(match, { pricePerStickCents: 1400, inStock: true });
    await seedAdhocOffer(ownedToo, { pricePerStickCents: 1400, inStock: true });
    await seedAdhocOffer(noStock, { pricePerStickCents: 1400, inStock: false });
    await seedAdhocOffer(notWanted, { pricePerStickCents: 1400, inStock: true });

    await withClient(ownerFull, async (client) => {
      // Wanted marks via the tool; ownedToo also acquired (in humidor).
      for (const id of [match, ownedToo, noStock]) await call(client, "set_want", { cigarId: id, wanted: true });
      await call(client, "record_purchase", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: ownedToo },
        quantity: 1,
      });

      const data = payloadOf(
        await call(client, "browse_catalog", {
          q: brand,
          wanted: true,
          inHumidor: false,
          inStock: true,
        }),
      ) as BrowsePayload;
      expect(data.cigars.map((c) => c.cigarId)).toEqual([match]);
      expect(data.totalCount).toBe(1);
    });

    // A catalog-only token cannot filter by personal state: the personal filters
    // are dropped, so the wanted/inHumidor filters do not narrow the result.
    await withClient(ownerCatalogOnly, async (client) => {
      const data = payloadOf(
        await call(client, "browse_catalog", { q: brand, wanted: true, inHumidor: false }),
      ) as BrowsePayload;
      expect(data.cigars.map((c) => c.cigarId).sort()).toEqual(
        [match, ownedToo, noStock, notWanted].sort(),
      );
    });
  });

  it("browse_catalog price sort keyset round-trips, unpriced cigars last", async () => {
    const brand = `MPriceSort-${randomUUID().slice(0, 8)}`;
    const cheap = await h.seedCigar({ canonicalName: `${brand} Cheap`, brand });
    const mid = await h.seedCigar({ canonicalName: `${brand} Mid`, brand });
    const noPrice = await h.seedCigar({ canonicalName: `${brand} NoPrice`, brand });
    await seedAdhocOffer(cheap, { pricePerStickCents: 1000 });
    await seedAdhocOffer(mid, { pricePerStickCents: 1500 });

    await withClient(ownerFull, async (client) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const data = payloadOf(
          await call(client, "browse_catalog", { q: brand, sort: "price", limit: 1, cursor }),
        ) as BrowsePayload;
        for (const c of data.cigars) seen.push(c.cigarId);
        cursor = data.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      // Cheapest per-stick first, the unpriced cigar walked last via the null-key
      // cursor, with no dupes or gaps.
      expect(seen).toEqual([cheap, mid, noPrice]);
      expect(new Set(seen).size).toBe(3);
    });
  });

  it("browse_catalog: bad enum errors; a negative limit and a garbage cursor degrade gracefully", async () => {
    await withClient(ownerFull, async (client) => {
      // Strict enums reject an invalid value (schema-shape violation → isError).
      expect((await call(client, "browse_catalog", { type: "XX" })).isError).toBe(true);
      expect((await call(client, "browse_catalog", { sort: "cheapest" })).isError).toBe(true);

      // A negative limit is domain-clamped, not an error (lenient, like the other
      // reads) — a valid page comes back.
      const clamped = await call(client, "browse_catalog", { limit: -5 });
      expect(clamped.isError).toBeFalsy();
      expect(Array.isArray((payloadOf(clamped) as BrowsePayload).cigars)).toBe(true);

      // A garbage cursor decodes as absent → the first page, never an error.
      const garbage = await call(client, "browse_catalog", { sort: "name", cursor: "@@@not-base64@@@" });
      expect(garbage.isError).toBeFalsy();
      expect(Array.isArray((payloadOf(garbage) as BrowsePayload).cigars)).toBe(true);
    });
  });

  // ---- get_offers (PRD-003 R-MCP-2) -----------------------------------------

  interface OffersPayload {
    offers: {
      vendor: string;
      isRegistryVendor: boolean;
      pricePerStick: number | null;
      packaging: string | null;
      inStock: boolean | null;
      seenAt: string;
    }[];
    history: {
      firstSeenAt: string | null;
      lastSeenAt: string | null;
      minPricePerStick: number | null;
      maxPricePerStick: number | null;
      observationCount: number;
    };
  }

  it("get_offers returns current offers + a compact history block under catalog:read", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `MOffers-${randomUUID().slice(0, 8)}`, brand: "Chronicle" });
    await seedAdhocOffer(cigarId, { pricePerStickCents: 1420, price: 142, packaging: "box", sticksPerPackage: 20, seenAt: new Date("2026-06-01T00:00:00Z") });
    await seedAdhocOffer(cigarId, { pricePerStickCents: 1650, price: 165, packaging: "box", sticksPerPackage: 20, seenAt: new Date("2026-08-15T00:00:00Z") });

    // catalog:read alone is enough — offers are market data, not personal.
    await withClient(ownerCatalogOnly, async (client) => {
      const result = await call(client, "get_offers", { cigarId });
      expect(result.structuredContent).toEqual(payloadOf(result));
      const data = payloadOf(result) as OffersPayload;
      // Latest per (source, packaging) series — one current offer here.
      expect(data.offers).toHaveLength(1);
      expect(data.offers[0]!.pricePerStick).toBe(16.5);
      expect(data.offers[0]!.packaging).toBe("box"); // per-stick always with packaging
      expect(data.history.observationCount).toBe(2);
      expect(data.history.minPricePerStick).toBe(14.2);
      expect(data.history.maxPricePerStick).toBe(16.5);
      expect(data.history.firstSeenAt).toBe("2026-06-01T00:00:00.000Z");
    });
  });

  it("get_offers returns empty offers and a zeroed history for a cigar with none; malformed args error", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `MNoOffers-${randomUUID().slice(0, 8)}`, brand: "Nobody" });
    await withClient(ownerCatalogOnly, async (client) => {
      const data = payloadOf(await call(client, "get_offers", { cigarId })) as OffersPayload;
      expect(data.offers).toEqual([]);
      expect(data.history.observationCount).toBe(0);
      expect(data.history.minPricePerStick).toBeNull();

      // Missing cigarId and an unknown top-level key both fail the strict schema.
      expect((await call(client, "get_offers", {})).isError).toBe(true);
      expect((await call(client, "get_offers", { cigarId, extra: "x" })).isError).toBe(true);
    });
  });

  // ---- inventory ------------------------------------------------------------

  interface InventoryHoldingPayload {
    cigar: { cigarId: string; canonicalName: string; vitola: { ringGauge: number | null } };
    remaining: number;
    totalAcquired: number;
    smokedCount: number;
    agingSince: string | null;
    myRating: number | null;
    lots: Record<string, unknown>[];
  }

  it("get_my_inventory returns the caller's holdings from seeded purchases", async () => {
    // A fresh cigar the owner buys but never smokes → remaining equals acquired.
    const invCigarId = await h.seedCigar({
      canonicalName: "Aging Reserve Toro",
      brand: "Aging Reserve",
      vitolaName: "Toro",
      lengthInches: "6.0",
      ringGauge: 52,
      type: "NC",
    });
    const [vendor] = await h.pg.db
      .insert(vendors)
      .values({ name: "Small Batch Cigar" })
      .returning({ id: vendors.id });
    await h.pg.db.insert(purchases).values({
      userId: owner.userId,
      cigarId: invCigarId,
      purchasedAt: "2026-01-10",
      quantity: 10,
      packaging: "box",
      humidorAt: "2025-06-01",
      vendorId: vendor!.id,
      pricePerStick: "12.5",
      notes: "owner ledger",
    });

    await withClient(ownerFull, async (client) => {
      const data = payloadOf(await call(client, "get_my_inventory", {})) as {
        holdings: InventoryHoldingPayload[];
        totalSticksRemaining: number;
      };
      const holding = data.holdings.find((hh) => hh.cigar.cigarId === invCigarId)!;
      expect(holding.totalAcquired).toBe(10);
      expect(holding.remaining).toBe(10); // never smoked
      expect(holding.smokedCount).toBe(0);
      expect(holding.agingSince).toBe("2025-06-01");
      expect(holding.cigar.vitola.ringGauge).toBe(52);
      expect(holding.lots[0]!.vendor).toBe("Small Batch Cigar");
      expect(holding.lots[0]!.pricePerStick).toBe(12.5);
      // Web-only lot fields stay off the contract payload.
      expect(holding.lots[0]).not.toHaveProperty("purchaseId");
      expect(holding.lots[0]).not.toHaveProperty("notes");
      expect(data.totalSticksRemaining).toBeGreaterThanOrEqual(10);
    });
  });

  it("rejects get_my_inventory for a token without journal:read: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogOnly}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_my_inventory", arguments: {} },
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
  });

  it("get_my_inventory is scoped to the caller — another user never sees these holdings", async () => {
    await withClient(otherFull, async (client) => {
      const data = payloadOf(await call(client, "get_my_inventory", {})) as {
        holdings: InventoryHoldingPayload[];
      };
      expect(data.holdings.some((hh) => hh.cigar.canonicalName === "Aging Reserve Toro")).toBe(false);
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

  it("get_my_smokes summaries stay contract-stable: no web-only strength/photoCount fields", async () => {
    await withClient(ownerFull, async (client) => {
      await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        assessment: { strength: "medium-full" },
        journal: { narrative: "Strength contract marker." },
      });

      // Text query → match provenance present; the web-only fields are not.
      const byText = payloadOf(
        await call(client, "get_my_smokes", { text: "Strength contract marker." }),
      ) as { smokes: Record<string, unknown>[] };
      expect(byText.smokes.length).toBeGreaterThanOrEqual(1);
      for (const s of byText.smokes) {
        expect(s).not.toHaveProperty("strength");
        expect(s).not.toHaveProperty("photoCount");
        expect(s).not.toHaveProperty("fromHumidor");
      }
      expect(byText.smokes[0]).toHaveProperty("matchedIn");
      expect(byText.smokes[0]).toHaveProperty("descriptors");

      // Non-text query stays byte-for-byte: no strength, no photoCount, no match keys.
      const byCigar = payloadOf(
        await call(client, "get_my_smokes", { cigarId: primaryCigarId }),
      ) as { smokes: Record<string, unknown>[] };
      for (const s of byCigar.smokes) {
        expect(s).not.toHaveProperty("strength");
        expect(s).not.toHaveProperty("photoCount");
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
      const candidates = error.candidates as Record<string, unknown>[];
      expect(candidates.length).toBe(2);
      // Candidates carry the differentiators that make ask_user answerable.
      for (const c of candidates) {
        expect(c).toHaveProperty("brand");
        expect(c).toHaveProperty("vitola");
        expect(c).toHaveProperty("verification");
      }
    });
  });

  it("smokedAt provenance is client-pinned to 'user'; a forged system/import source is rejected", async () => {
    await withClient(ownerFull, async (client) => {
      // A stated time with source:user persists and reads back as user provenance.
      const saved = payloadOf(
        await call(client, "save_smoke", {
          clientRequestId: randomUUID(),
          cigar: { cigarId: primaryCigarId },
          overallDescriptors: ["provenance-user"],
          smokedAt: { value: "2026-08-20T20:15:00-04:00", source: "user", precision: "minute" },
        }),
      ) as { smoke: { smokeId: string } };
      const full = payloadOf(await call(client, "get_smoke", { smokeId: saved.smoke.smokeId })) as {
        smoke: { smokedAt: { source: string } };
      };
      expect(full.smoke.smokedAt.source).toBe("user");

      // Forging server/import provenance is rejected by the pinned schema — no write.
      const forged = await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: ["provenance-forged"],
        smokedAt: {
          value: "2026-08-20T20:15:00-04:00",
          source: "system-finalized",
          precision: "minute",
        },
      });
      expect(forged.isError).toBe(true);
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

  it("smoke_not_found: a malformed get_smoke id is answered, not thrown", async () => {
    // `smokeId` is a bare `z.string()` here, as every id input in this adapter is,
    // so a non-uuid used to reach the uuid column and raise Postgres 22P02 — an
    // untyped error that escaped the contract and surfaced as a bare failure. The
    // domain read now treats it as the unknown id it is indistinguishable from.
    await withClient(ownerFull, async (client) => {
      const malformed = await call(client, "get_smoke", { smokeId: "not-a-uuid" });
      const unknown = await call(client, "get_smoke", { smokeId: randomUUID() });
      expect(errorOf(malformed).code).toBe("smoke_not_found");
      expect(errorOf(unknown)).toEqual(errorOf(malformed));
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
        enrichmentQueued: boolean;
      };
      expect(saved.cigarCreated).toBe(true);
      const smokeId = saved.smoke.smokeId;
      const createdCigarId = saved.smoke.cigar.cigarId;

      // The safety net (#177). The documented path is add_cigar → save_smoke, but a
      // client that skips the prelude must still not lose the entry: this save
      // published it, created the cigar, and — because it CREATED it — queued the
      // enrichment the prelude would have queued.
      expect(saved.enrichmentQueued).toBe(true);
      const queued = await enrichmentRows(createdCigarId);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.status).toBe("pending");

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

  // ---- gap-fill: add_cigar + record_purchase --------------------------------

  it("add_cigar creates an unverified entry, queues enrichment (row visible in DB), and replays", async () => {
    await withClient(ownerFull, async (client) => {
      // Nothing matches → the model creates from the user's words.
      const search = payloadOf(await call(client, "search_cigars", { query: "Quasar Comet 7" })) as {
        guidance: string;
      };
      expect(search.guidance).toBe("no_match");

      const clientRequestId = randomUUID();
      const args = {
        clientRequestId,
        cigar: { canonicalName: "Quasar Comet 7 Toro", brand: "Quasar", type: "NC" },
      };
      const created = payloadOf(await call(client, "add_cigar", args)) as {
        cigar: { cigarId: string; verification: string };
        created: boolean;
        enrichmentQueued: boolean;
        guidance: string;
        replayed: boolean;
      };
      expect(created.created).toBe(true);
      expect(created.enrichmentQueued).toBe(true);
      expect(created.guidance).toBe("created");
      expect(created.replayed).toBe(false);
      expect(created.cigar.verification).toBe("unverified");

      // The enrichment queue row is really in the DB, owned by the requester.
      const queued = await enrichmentRows(created.cigar.cigarId);
      expect(queued).toHaveLength(1);
      expect(queued[0]!.status).toBe("pending");
      expect(queued[0]!.requestedBy).toBe(owner.userId);

      // Replay: same envelope + args → original result, no duplicate enrichment.
      const replay = payloadOf(await call(client, "add_cigar", args)) as {
        cigar: { cigarId: string };
        replayed: boolean;
      };
      expect(replay.replayed).toBe(true);
      expect(replay.cigar.cigarId).toBe(created.cigar.cigarId);
      expect(await enrichmentRows(created.cigar.cigarId)).toHaveLength(1);
    });
  });

  it("add_cigar always reports journalEntryCreated:false — on create, on an existing link, and on replay", async () => {
    // The point-of-use half of the #177 fix. Whatever else add_cigar reports, it
    // must say it wrote no journal entry: the live loss was a client that read a
    // successful add_cigar as "logged" and never issued the save_smoke. The flag
    // is an ADAPTER constant, so the replay assertion is the load-bearing one —
    // it proves the field rides the stored idempotency envelope too, rather than
    // vanishing on exactly the retry path a confused client is most likely to take.
    const existing = "Halcyon Drift Robusto";
    await h.seedCigar({ canonicalName: existing, brand: "Halcyon" });
    await withClient(ownerFull, async (client) => {
      const args = {
        clientRequestId: randomUUID(),
        cigar: { canonicalName: "Zenith Meridian Lancero", brand: "Zenith", type: "NC" },
      };
      const created = payloadOf(await call(client, "add_cigar", args)) as {
        created: boolean;
        guidance: string;
        journalEntryCreated: boolean;
      };
      expect(created.created).toBe(true);
      expect(created.guidance).toBe("created");
      expect(created.journalEntryCreated).toBe(false);

      const replay = payloadOf(await call(client, "add_cigar", args)) as {
        replayed: boolean;
        journalEntryCreated: boolean;
      };
      expect(replay.replayed).toBe(true);
      expect(replay.journalEntryCreated).toBe(false);

      // An exact-name hit links rather than creates — still nothing journaled.
      const linked = payloadOf(
        await call(client, "add_cigar", {
          clientRequestId: randomUUID(),
          cigar: { canonicalName: existing, brand: "Halcyon" },
        }),
      ) as { created: boolean; guidance: string; journalEntryCreated: boolean };
      expect(linked.created).toBe(false);
      expect(linked.guidance).toBe("already_existed");
      expect(linked.journalEntryCreated).toBe(false);
    });
  });

  it("add_cigar with confirmedDistinct overrides a near-match deadlock and creates a distinct entry", async () => {
    // Two same-number, non-packaging siblings the guard cannot separate: without
    // the flag add_cigar deadlocks (cigar_ambiguous); with confirmedDistinct —
    // set only after the user confirmed none of the candidates is theirs — it
    // creates the distinct product through the tool surface.
    await h.seedCigar({ canonicalName: "Zephyr Nova 2001 Alpha", brand: "Zephyr" });
    await h.seedCigar({ canonicalName: "Zephyr Nova 2001 Beta", brand: "Zephyr" });
    await withClient(ownerFull, async (client) => {
      const deadlock = await call(client, "add_cigar", {
        clientRequestId: randomUUID(),
        cigar: { canonicalName: "Zephyr Nova 2001", brand: "Zephyr" },
      });
      expect(errorOf(deadlock).code).toBe("cigar_ambiguous");

      const created = payloadOf(
        await call(client, "add_cigar", {
          clientRequestId: randomUUID(),
          cigar: { canonicalName: "Zephyr Nova 2001", brand: "Zephyr" },
          confirmedDistinct: true,
        }),
      ) as { created: boolean; guidance: string; cigar: { cigarId: string; canonicalName: string } };
      expect(created.created).toBe(true);
      expect(created.guidance).toBe("created");
      expect(created.cigar.canonicalName).toBe("Zephyr Nova 2001");
    });
  });

  it("rejects add_cigar for a token without journal:write: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogJournal}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "add_cigar",
          arguments: { clientRequestId: randomUUID(), cigar: { canonicalName: "Scope Probe" } },
        },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("record_purchase logs an acquisition of a described cigar and returns holdingAfter", async () => {
    await withClient(ownerFull, async (client) => {
      const data = payloadOf(
        await call(client, "record_purchase", {
          clientRequestId: randomUUID(),
          cigar: { described: { canonicalName: "Pulsar Prime Robusto", brand: "Pulsar", type: "NC" } },
          quantity: 5,
          purchasedAt: "2026-02-01",
          packaging: "box",
          pricePerStick: 9.5,
        }),
      ) as {
        purchaseId: string;
        cigar: { cigarId: string; verification: string };
        holdingAfter: { totalAcquired: number; remaining: number };
        replayed: boolean;
      };
      expect(data.purchaseId).toBeTruthy();
      expect(data.cigar.verification).toBe("unverified"); // described → auto-created
      expect(data.holdingAfter).toEqual({ totalAcquired: 5, remaining: 5 });

      // A described purchase queues enrichment through the same path add_cigar uses.
      expect(await enrichmentRows(data.cigar.cigarId)).toHaveLength(1);

      // It shows up in the humidor.
      const inv = payloadOf(await call(client, "get_my_inventory", {})) as {
        holdings: { cigar: { cigarId: string }; remaining: number }[];
      };
      expect(inv.holdings.find((hh) => hh.cigar.cigarId === data.cigar.cigarId)!.remaining).toBe(5);
    });
  });

  it("record_purchase corrects an over-count with a negative-quantity row", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Correction Corona", brand: "Correction" });
    await withClient(ownerFull, async (client) => {
      const bought = payloadOf(
        await call(client, "record_purchase", {
          clientRequestId: randomUUID(),
          cigar: { cigarId },
          quantity: 3,
        }),
      ) as { holdingAfter: { totalAcquired: number } };
      expect(bought.holdingAfter.totalAcquired).toBe(3);

      const corrected = payloadOf(
        await call(client, "record_purchase", {
          clientRequestId: randomUUID(),
          cigar: { cigarId },
          quantity: -1,
          notes: "Miscounted the box.",
        }),
      ) as { holdingAfter: { totalAcquired: number; remaining: number } };
      expect(corrected.holdingAfter.totalAcquired).toBe(2);
      expect(corrected.holdingAfter.remaining).toBe(2);
    });
  });

  it("record_purchase rejects a negative quantity with no notes: validation_error on notes", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "record_purchase", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        quantity: -2,
      });
      const error = errorOf(result);
      expect(error.code).toBe("validation_error");
      expect((error.fields as { path: string }[]).some((f) => f.path === "notes")).toBe(true);
    });
  });

  it("record_purchase is scoped to the caller — another user never sees the lot", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Private Panatela", brand: "Private" });
    await withClient(ownerFull, async (client) => {
      await call(client, "record_purchase", {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        quantity: 4,
      });
    });
    await withClient(otherFull, async (client) => {
      const inv = payloadOf(await call(client, "get_my_inventory", {})) as {
        holdings: { cigar: { cigarId: string } }[];
      };
      expect(inv.holdings.some((hh) => hh.cigar.cigarId === cigarId)).toBe(false);
    });
  });

  // ---- set_want + record_purchase want flag ---------------------------------

  it("set_want marks and clears a cigar idempotently; get_cigar reflects it under journal:read", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Wanted Wide Churchill", brand: "WW" });
    await withClient(ownerFull, async (client) => {
      const marked = payloadOf(
        await call(client, "set_want", { cigarId, wanted: true, note: "for the holidays" }),
      ) as { cigarId: string; wanted: boolean; note: string | null; changed: boolean };
      expect(marked).toMatchObject({ cigarId, wanted: true, note: "for the holidays", changed: true });

      // Idempotent re-mark: no change.
      const again = payloadOf(await call(client, "set_want", { cigarId, wanted: true })) as {
        changed: boolean;
      };
      expect(again.changed).toBe(false);

      // get_cigar (journal:read on ownerFull) reflects the want.
      const got = payloadOf(await call(client, "get_cigar", { cigarId })) as { wanted: boolean };
      expect(got.wanted).toBe(true);

      // Clear it; get_cigar flips back.
      const cleared = payloadOf(await call(client, "set_want", { cigarId, wanted: false })) as {
        wanted: boolean;
        note: string | null;
      };
      expect(cleared.wanted).toBe(false);
      expect(cleared.note).toBeNull();
      expect((payloadOf(await call(client, "get_cigar", { cigarId })) as { wanted: boolean }).wanted).toBe(
        false,
      );
    });
  });

  it("rejects set_want for a token without journal:write: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogJournal}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "set_want", arguments: { cigarId: primaryCigarId, wanted: true } },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("set_want isolates by caller — another user's mark never appears in get_cigar", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Want Isolation Robusto", brand: "WI" });
    await withClient(ownerFull, async (client) => {
      await call(client, "set_want", { cigarId, wanted: true });
    });
    await withClient(otherFull, async (client) => {
      const got = payloadOf(await call(client, "get_cigar", { cigarId })) as { wanted: boolean };
      expect(got.wanted).toBe(false);
    });
  });

  it("record_purchase carries wanted:true when the cigar was on the want list (never auto-cleared)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Buy What You Want Toro", brand: "BW" });
    await withClient(ownerFull, async (client) => {
      await call(client, "set_want", { cigarId, wanted: true });
      const bought = payloadOf(
        await call(client, "record_purchase", {
          clientRequestId: randomUUID(),
          cigar: { cigarId },
          quantity: 3,
        }),
      ) as { wanted: boolean };
      expect(bought.wanted).toBe(true);
      // Buying did not clear the want — the model is expected to OFFER the clear.
      expect((payloadOf(await call(client, "get_cigar", { cigarId })) as { wanted: boolean }).wanted).toBe(
        true,
      );
    });
  });

  it("set_want on an unknown cigar returns cigar_not_found", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "set_want", { cigarId: randomUUID(), wanted: true });
      expect(errorOf(result).code).toBe("cigar_not_found");
    });
  });

  // ---- set_favorite (the second cigar-level mark) ---------------------------

  it("set_favorite marks and clears a cigar idempotently; get_cigar reflects it under journal:read", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Favorite Wide Churchill", brand: "FW" });
    await withClient(ownerFull, async (client) => {
      const marked = payloadOf(
        await call(client, "set_favorite", { cigarId, favorited: true, note: "my desert-island stick" }),
      ) as { cigarId: string; favorited: boolean; note: string | null; changed: boolean };
      expect(marked).toMatchObject({
        cigarId,
        favorited: true,
        note: "my desert-island stick",
        changed: true,
      });

      // Idempotent re-mark: no change.
      const again = payloadOf(await call(client, "set_favorite", { cigarId, favorited: true })) as {
        changed: boolean;
      };
      expect(again.changed).toBe(false);

      // get_cigar (journal:read on ownerFull) reflects the favorite.
      const got = payloadOf(await call(client, "get_cigar", { cigarId })) as { favorited: boolean };
      expect(got.favorited).toBe(true);

      // Clear it; get_cigar flips back.
      const cleared = payloadOf(await call(client, "set_favorite", { cigarId, favorited: false })) as {
        favorited: boolean;
        note: string | null;
      };
      expect(cleared.favorited).toBe(false);
      expect(cleared.note).toBeNull();
      expect(
        (payloadOf(await call(client, "get_cigar", { cigarId })) as { favorited: boolean }).favorited,
      ).toBe(false);
    });
  });

  it("rejects set_favorite for a token without journal:write: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogJournal}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "set_favorite", arguments: { cigarId: primaryCigarId, favorited: true } },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("set_favorite isolates by caller — another user's mark never appears in get_cigar", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Favorite Isolation Robusto", brand: "FI" });
    await withClient(ownerFull, async (client) => {
      await call(client, "set_favorite", { cigarId, favorited: true });
    });
    await withClient(otherFull, async (client) => {
      const got = payloadOf(await call(client, "get_cigar", { cigarId })) as { favorited: boolean };
      expect(got.favorited).toBe(false);
    });
  });

  it("set_favorite is independent of set_want — one mark never implies the other", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Favorite Not Want Toro", brand: "FNW" });
    await withClient(ownerFull, async (client) => {
      await call(client, "set_favorite", { cigarId, favorited: true });
      const got = payloadOf(await call(client, "get_cigar", { cigarId })) as {
        favorited: boolean;
        wanted: boolean;
      };
      expect(got.favorited).toBe(true);
      expect(got.wanted).toBe(false); // favoriting did not want it
    });
  });

  it("set_favorite on an unknown cigar returns cigar_not_found", async () => {
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "set_favorite", { cigarId: randomUUID(), favorited: true });
      expect(errorOf(result).code).toBe("cigar_not_found");
    });
  });

  // ---- catalog repair + price observations (ADR-009) ------------------------

  it("request_cigar_enrichment queues a sparse cigar (row in DB), then reports already_queued", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Diplomaticos No 2", verification: "unverified" });
    await withClient(ownerFull, async (client) => {
      const first = payloadOf(await call(client, "request_cigar_enrichment", { cigarId })) as {
        status: string;
        queued: boolean;
        missingFields: string[];
        verification: string;
      };
      expect(first.status).toBe("queued");
      expect(first.queued).toBe(true);
      expect(first.missingFields).toContain("productPhoto");
      expect(first.verification).toBe("unverified");
      expect(await enrichmentRows(cigarId)).toHaveLength(1);

      const second = payloadOf(await call(client, "request_cigar_enrichment", { cigarId })) as {
        status: string;
      };
      expect(second.status).toBe("already_queued");
      expect(await enrichmentRows(cigarId)).toHaveLength(1);
    });
  });

  it("update_cigar fills only null fields and never overwrites a verified entry", async () => {
    const sparse = await h.seedCigar({ canonicalName: "Repair Target", brand: "Kept Brand", verification: "unverified" });
    const locked = await h.seedCigar({ canonicalName: "Verified Entry", verification: "verified" });
    await withClient(ownerFull, async (client) => {
      const filled = payloadOf(
        await call(client, "update_cigar", {
          clientRequestId: randomUUID(),
          cigarId: sparse,
          fields: { brand: "New Brand", line: "New Line", type: "CC" },
        }),
      ) as { changedFields: string[]; skipped: string[] };
      expect(filled.changedFields).toEqual(expect.arrayContaining(["line", "type"]));
      expect(filled.skipped).toContain("brand"); // already non-null

      const detail = payloadOf(await call(client, "get_cigar", { cigarId: sparse })) as {
        cigar: { brand: string | null; line: string | null };
      };
      expect(detail.cigar.brand).toBe("Kept Brand");
      expect(detail.cigar.line).toBe("New Line");

      const onVerified = payloadOf(
        await call(client, "update_cigar", {
          clientRequestId: randomUUID(),
          cigarId: locked,
          fields: { brand: "Should Not Land" },
        }),
      ) as { changedFields: string[]; skipped: string[] };
      expect(onVerified.changedFields).toEqual([]);
      expect(onVerified.skipped).toContain("brand");
    });
  });

  it("record_price observes a price, dedupes an identical repeat, and surfaces per-stick-with-packaging on get_cigar", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Priced Via MCP", verification: "unverified" });
    await h.pg.db.insert(vendors).values({ name: "MCP Box Shop" });
    await withClient(ownerFull, async (client) => {
      const first = payloadOf(
        await call(client, "record_price", {
          clientRequestId: randomUUID(),
          cigarId,
          vendorName: "mcp box shop",
          price: 334,
          packaging: "box",
          sticksPerPackage: 20,
          inStock: true,
          observedAt: "2026-08-29T10:00:00Z",
        }),
      ) as { recorded: boolean; deduped: boolean; pricePerStick: number; source: { vendorName: string | null } };
      expect(first.recorded).toBe(true);
      expect(first.pricePerStick).toBeCloseTo(16.7, 2);
      expect(first.source.vendorName).toBe("MCP Box Shop");

      // Identical observation within 24h (different envelope) → deduped.
      const dupe = payloadOf(
        await call(client, "record_price", {
          clientRequestId: randomUUID(),
          cigarId,
          vendorName: "mcp box shop",
          price: 334,
          packaging: "box",
          sticksPerPackage: 20,
          inStock: true,
          observedAt: "2026-08-29T16:00:00Z",
        }),
      ) as { recorded: boolean; deduped: boolean };
      expect(dupe.recorded).toBe(false);
      expect(dupe.deduped).toBe(true);

      const detail = payloadOf(await call(client, "get_cigar", { cigarId })) as {
        pricing: { lowest: { perStick: boolean; amount: number; packaging: string | null } | null } | null;
        enrichment: { recommended: boolean };
      };
      expect(detail.pricing?.lowest).toEqual({
        perStick: true,
        amount: 16.7,
        packaging: "box",
        sticksPerPackage: 20,
      });
      expect(detail.enrichment.recommended).toBe(true);
    });
  });

  it("record_price requires a source when no registry vendor matches", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "No Source Cigar" });
    await withClient(ownerFull, async (client) => {
      const result = await call(client, "record_price", {
        clientRequestId: randomUUID(),
        cigarId,
        price: 12,
      });
      expect(errorOf(result).code).toBe("validation_error");
    });
  });

  it("rejects record_price for a token without journal:write: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogJournal}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "record_price",
          arguments: { clientRequestId: randomUUID(), cigarId: primaryCigarId, sourceName: "Somewhere", price: 10 },
        },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  // ---- explicit consumption (ADR-008) ---------------------------------------

  async function remainingFor(client: Client, cigarId: string): Promise<number> {
    const inv = payloadOf(await call(client, "get_my_inventory", {})) as {
      holdings: { cigar: { cigarId: string }; remaining: number }[];
    };
    return inv.holdings.find((hh) => hh.cigar.cigarId === cigarId)?.remaining ?? 0;
  }

  it("save_smoke consumption: omitted/false deducts nothing, fromHumidor deducts, replay does not double-deduct", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "MCP Consume Toro", brand: "MCPConsume" });
    await withClient(ownerFull, async (client) => {
      await call(client, "record_purchase", {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        quantity: 3,
      });
      expect(await remainingFor(client, cigarId)).toBe(3);

      // Omitted consumption = unknown = no deduction.
      await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        overallDescriptors: ["omitted"],
      });
      expect(await remainingFor(client, cigarId)).toBe(3);

      // Explicit false (off-humidor) = no deduction.
      await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        overallDescriptors: ["lounge"],
        consumption: { fromHumidor: false },
      });
      expect(await remainingFor(client, cigarId)).toBe(3);

      // fromHumidor: true deducts exactly one; the result carries holdingAfter
      // (present only when a consumption block was supplied — mirrors record_purchase).
      const args = {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        overallDescriptors: ["humidor"],
        consumption: { fromHumidor: true },
      };
      const saved = payloadOf(await call(client, "save_smoke", args)) as {
        holdingAfter?: { totalAcquired: number; remaining: number };
      };
      expect(saved.holdingAfter).toEqual({ totalAcquired: 3, remaining: 2 });
      expect(await remainingFor(client, cigarId)).toBe(2);

      // Replaying the identical save is idempotent — no second deduction.
      const replay = payloadOf(await call(client, "save_smoke", args)) as { replayed: boolean };
      expect(replay.replayed).toBe(true);
      expect(await remainingFor(client, cigarId)).toBe(2);
    });
  });

  it("update_smoke consumption set/clear moves the remaining count; over-consumption is surfaced", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "MCP Update Consume Robusto", brand: "MCPUpd" });
    await withClient(ownerFull, async (client) => {
      await call(client, "record_purchase", {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        quantity: 1,
      });
      const saved = payloadOf(
        await call(client, "save_smoke", {
          clientRequestId: randomUUID(),
          cigar: { cigarId },
          overallDescriptors: ["marker"],
        }),
      ) as { smoke: { smokeId: string } };
      expect(await remainingFor(client, cigarId)).toBe(1); // no link yet

      // Set the link → deducts.
      await call(client, "update_smoke", {
        clientRequestId: randomUUID(),
        smokeId: saved.smoke.smokeId,
        changes: { consumption: { fromHumidor: true } },
      });
      expect(await remainingFor(client, cigarId)).toBe(0);

      // A second linked smoke over-consumes: remaining floors at 0, overConsumed surfaces it.
      await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId },
        overallDescriptors: ["second"],
        consumption: { fromHumidor: true },
      });
      const inv = payloadOf(await call(client, "get_my_inventory", {})) as {
        holdings: { cigar: { cigarId: string }; remaining: number; overConsumed: number }[];
      };
      const holding = inv.holdings.find((hh) => hh.cigar.cigarId === cigarId)!;
      expect(holding.remaining).toBe(0);
      expect(holding.overConsumed).toBe(1);

      // Clear the first link → back to one remaining.
      await call(client, "update_smoke", {
        clientRequestId: randomUUID(),
        smokeId: saved.smoke.smokeId,
        changes: { consumption: { fromHumidor: false } },
      });
      expect(await remainingFor(client, cigarId)).toBe(0); // still one consumption stands
    });
  });

  // ---- add_smoke_photo: dual-mode photo intake ------------------------------

  async function saveBareSmoke(client: Client, marker: string): Promise<string> {
    const saved = payloadOf(
      await call(client, "save_smoke", {
        clientRequestId: randomUUID(),
        cigar: { cigarId: primaryCigarId },
        overallDescriptors: [marker],
      }),
    ) as { smoke: { smokeId: string } };
    return saved.smoke.smokeId;
  }

  it("add_smoke_photo mode B (no image) mints a one-time upload link bound to the smoke", async () => {
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "photo-mode-b");
      const data = payloadOf(await call(client, "add_smoke_photo", { smokeId, kind: "band" })) as {
        mode: string;
        uploadUrl: string;
        expiresAt: string;
      };
      expect(data.mode).toBe("upload_url");
      // Mirrors smokeUrl: the web origin + /u/<opaque base64url token>.
      expect(data.uploadUrl).toMatch(new RegExp(`^${ORIGIN}/u/[A-Za-z0-9_-]+$`));
      expect(Number.isNaN(Date.parse(data.expiresAt))).toBe(false);
      // No image bytes stored — mode B only mints a link.
      expect(data).not.toHaveProperty("photo");
    });
  });

  it("add_smoke_photo mode A (attached image) fetches openai/fileParams, stores it, and it rides get_smoke", async () => {
    // A local fixture server stands in for ChatGPT's short-lived signed URL.
    const fixture: HttpServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG_FIXTURE.byteLength });
      res.end(PNG_FIXTURE);
    });
    await new Promise<void>((resolve) => fixture.listen(0, resolve));
    const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/img.png`;

    try {
      await withClient(ownerFull, async (client) => {
        const smokeId = await saveBareSmoke(client, "photo-mode-a");

        const result = (await client.callTool({
          name: "add_smoke_photo",
          arguments: { smokeId, kind: "band", caption: "The band" },
          _meta: {
            "openai/fileParams": [
              { download_url: fixtureUrl, file_id: "file_1", mime_type: "image/png", name: "band.png" },
            ],
          },
        })) as CallToolResult;

        const data = payloadOf(result) as {
          mode: string;
          photo: { photoId: string; smokeId: string; kind: string; caption: string };
        };
        expect(data.mode).toBe("attached");
        expect(data.photo.smokeId).toBe(smokeId);
        expect(data.photo.kind).toBe("band");
        expect(data.photo.caption).toBe("The band");

        // Both objects landed in storage, and the photo rides get_smoke additively.
        const full = payloadOf(await call(client, "get_smoke", { smokeId })) as {
          smoke: { photos: { photoId: string }[] };
        };
        expect(full.smoke.photos.some((p) => p.photoId === data.photo.photoId)).toBe(true);
      });
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });

  it("add_smoke_photo mode A via the declared `image` argument fetches, stores, and rides get_smoke", async () => {
    // The Apps SDK file-param path: ChatGPT fills the declared `image` property with
    // { download_url, file_id, mime_type?, file_name? }. A local fixture stands in
    // for the short-lived signed URL — no live fetches.
    const fixture: HttpServer = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": PNG_FIXTURE.byteLength });
      res.end(PNG_FIXTURE);
    });
    await new Promise<void>((resolve) => fixture.listen(0, resolve));
    const fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/img.png`;

    try {
      await withClient(ownerFull, async (client) => {
        const smokeId = await saveBareSmoke(client, "photo-arg-mode-a");

        const data = payloadOf(
          await call(client, "add_smoke_photo", {
            smokeId,
            kind: "cigar",
            caption: "As an argument",
            image: {
              download_url: fixtureUrl,
              file_id: "file_2",
              mime_type: "image/png",
              file_name: "stick.png",
            },
          }),
        ) as { mode: string; photo: { photoId: string; smokeId: string; kind: string } };
        expect(data.mode).toBe("attached");
        expect(data.photo.smokeId).toBe(smokeId);
        expect(data.photo.kind).toBe("cigar");

        const full = payloadOf(await call(client, "get_smoke", { smokeId })) as {
          smoke: { photos: { photoId: string }[] };
        };
        expect(full.smoke.photos.some((p) => p.photoId === data.photo.photoId)).toBe(true);
      });
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  });

  it("add_smoke_photo with a malformed `image` argument falls back to mode B, never errors", async () => {
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "photo-malformed-arg");
      // No usable download_url → the file object is treated as ABSENT → mode-B upload
      // link, not an error (contract: unknown/malformed shapes fall back, never fail).
      const result = await call(client, "add_smoke_photo", {
        smokeId,
        image: { file_id: "file_x", mime_type: "image/png" },
      });
      expect(result.isError).not.toBe(true);
      const data = payloadOf(result) as { mode: string; uploadUrl: string };
      expect(data.mode).toBe("upload_url");
      expect(data.uploadUrl).toMatch(new RegExp(`^${ORIGIN}/u/[A-Za-z0-9_-]+$`));
    });
  });


  // ---- add_smoke_photo intake diagnostics (issue: in-chat images never arrive) --
  //
  // THE ACCEPTANCE BAR these tests defend: from ONE `[mcp] photo_intake` line, a
  // human must be able to say which of these happened — nothing delivered /
  // delivered without a usable URL (and which keys it had) / URL present but
  // unfetchable / success. Before this change all four produced the same output and
  // the same single log line (`tool_called … latencyMs:9`).

  // Capture the structured `[mcp]` lines emitted while `fn` runs. mcpEvent writes
  // through console.log, so this is the real wire format an operator greps in Loki.
  async function captureMcpLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    try {
      const value = await fn();
      return { value, lines };
    } finally {
      spy.mockRestore();
    }
  }

  // Parse the JSON payload of the single `[mcp] <event>` line.
  function eventPayload(lines: string[], event: string): Record<string, unknown> {
    const marker = `[mcp] ${event} `;
    const line = lines.find((l) => l.includes(marker));
    expect(line, `no ${event} line was emitted; saw: ${lines.join(" | ")}`).toBeDefined();
    return JSON.parse(line!.slice(line!.indexOf("{", line!.indexOf(marker)))) as Record<
      string,
      unknown
    >;
  }

  // A one-shot fixture server standing in for the host's short-lived signed URL.
  async function withFixture<T>(
    handler: (req: unknown, res: ServerResponse) => void,
    fn: (url: string) => Promise<T>,
    path = "/img.png",
  ): Promise<T> {
    const fixture: HttpServer = createServer((req, res) => {
      res.on("error", () => {});
      req.on("error", () => {});
      handler(req, res);
    });
    await new Promise<void>((resolve) => fixture.listen(0, resolve));
    try {
      return await fn(`http://127.0.0.1:${(fixture.address() as AddressInfo).port}${path}`);
    } finally {
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    }
  }

  it("records `no_delivery` when nothing arrived on either channel", async () => {
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "intake-no-delivery");
      const { value, lines } = await captureMcpLog(() =>
        call(client, "add_smoke_photo", { smokeId, kind: "band" }),
      );

      const data = payloadOf(value) as { mode: string; delivery: { status: string } };
      expect(data.mode).toBe("upload_url");
      expect(data.delivery.status).toBe("no_image_received");

      const record = eventPayload(lines, "photo_intake");
      expect(record.outcome).toBe("no_delivery");
      expect(record.channel).toBe("none");
      expect(record.argument).toEqual({ type: "absent", keys: [], filled: [] });
      expect(record.requestMeta).toEqual({ type: "absent", keys: [], filled: [], count: 0 });
    });
  });

  it("records `no_url` and the keys that DID arrive for a file_id-only handle", async () => {
    // The owner's exact reported failure: ChatGPT sends a handle the server cannot
    // resolve. The file lives in the user's ChatGPT workspace and only the host can
    // turn it into a download_url — so this is a NAMED permanent outcome, not a
    // retryable bug, and mode B stays the working path.
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "intake-file-id-only");
      const { value, lines } = await captureMcpLog(() =>
        call(client, "add_smoke_photo", {
          smokeId,
          image: { file_id: "file_abc123", mime_type: "image/jpeg" },
        }),
      );

      expect(value.isError).not.toBe(true);
      const data = payloadOf(value) as { mode: string; delivery: { status: string } };
      expect(data.mode).toBe("upload_url");
      expect(data.delivery.status).toBe("image_reference_unusable");

      const record = eventPayload(lines, "photo_intake");
      expect(record.outcome).toBe("no_url");
      expect(record.channel).toBe("argument");
      expect(record.argument).toEqual({
        type: "object",
        keys: ["file_id", "mime_type"],
        filled: ["file_id", "mime_type"],
      });
      // Key NAMES only — the file id itself is a value and never lands in the log.
      expect(JSON.stringify(record)).not.toContain("file_abc123");
    });
  });

  it("refuses an `image` the strict schema rejects, and the probe still records its shape", async () => {
    // The trade issue #202 experiment 1 accepts, pinned so it cannot drift silently.
    // These shapes previously reached the handler through a preprocess wrapper and
    // fell back to a mode-B link; against the strict published schema the SDK now
    // refuses them before `run()`. That is the POINT — the published shape is the
    // experiment — and it costs no observability, which is the half this test
    // exists to prove: the raw-body probe describes every one of them from the
    // unparsed JSON-RPC body, before validation.
    //
    // `image: null` is the case worth naming: a plausible "no file attached" host
    // shape that is now a hard error on the argument channel. The request-`_meta`
    // channel is unvalidated and unaffected, and the probe sees both.
    const cases: { image: unknown; type: string; keys: string[]; filled: string[] }[] = [
      { image: "https://chatgpt.com/c/file-abc", type: "string", keys: [], filled: [] },
      { image: null, type: "null", keys: [], filled: [] },
      { image: 5, type: "number", keys: [], filled: [] },
      // An object whose declared key carries the wrong type.
      { image: { download_url: 12 }, type: "object", keys: ["download_url"], filled: [] },
      // An undeclared key — newly refused, and the class most likely to be a real
      // host sending a URL under a name we do not publish. `additionalProperties:
      // false` is what makes this a rejection, and the probe names the key so a
      // live host doing exactly this is still diagnosable from Loki.
      { image: { url: "https://cdn.example/x.png" }, type: "object", keys: ["url"], filled: ["url"] },
    ];

    await withClient(ownerFull, async (client) => {
      for (const testCase of cases) {
        const smokeId = await saveBareSmoke(client, "intake-rejected");
        const { value, lines } = await captureMcpLog(() =>
          call(client, "add_smoke_photo", { smokeId, image: testCase.image }),
        );

        expect(value.isError, `image=${JSON.stringify(testCase.image)} must be refused`).toBe(true);

        const probe = eventPayload(lines, "photo_intake_request");
        expect(probe.tool).toBe("add_smoke_photo");
        expect(probe.argKeys).toEqual(["image", "smokeId"]);
        expect(probe.argImage).toEqual({
          type: testCase.type,
          keys: testCase.keys,
          filled: testCase.filled,
        });
        // The handler never ran, so there is no `photo_intake` line — the probe is
        // the whole record, exactly as the strict-schema trade assumes.
        expect(lines.some((l) => l.includes("[mcp] photo_intake {"))).toBe(false);
        // Key names only: the probe never copies a handle's values.
        expect(lines.join("\n")).not.toContain("cdn.example");
        expect(lines.join("\n")).not.toContain("chatgpt.com/c/file-abc");
      }
    });
  });

  it("falls back to mode B with `fetch_failed` when the signed URL does not resolve", async () => {
    // Behavior change: this used to return the contract error `unavailable`. Mode B
    // is guaranteed, so a dead URL now yields a working upload link and the signal
    // moves into the record — queryable and alertable, unlike an error the user
    // never sees.
    await withFixture(
      (_req, res) => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("gone");
      },
      async (fixtureUrl) => {
        await withClient(ownerFull, async (client) => {
          const smokeId = await saveBareSmoke(client, "intake-fetch-failed");
          const { value, lines } = await captureMcpLog(() =>
            call(client, "add_smoke_photo", { smokeId, image: { download_url: fixtureUrl } }),
          );

          expect(value.isError).not.toBe(true);
          const data = payloadOf(value) as { mode: string; delivery: { status: string } };
          expect(data.mode).toBe("upload_url");
          expect(data.delivery.status).toBe("image_fetch_failed");

          const record = eventPayload(lines, "photo_intake");
          expect(record.outcome).toBe("fetch_failed");
          expect(record.urlKey).toBe("download_url");
          const fetched = record.fetch as { host: string; scheme: string; status: number };
          expect(fetched.status).toBe(404);
          expect(fetched.host).toBe("127.0.0.1");
          expect(fetched.scheme).toBe("http");
        });
      },
    );
  });

  it("enforces the 20MB cap on the streamed byte count, not the header", async () => {
    const megabyte = Buffer.alloc(1024 * 1024, 0x41);
    await withFixture(
      (_req, res) => {
        // No content-length: chunked, so only the streamed count can stop it.
        res.writeHead(200, { "content-type": "image/png" });
        let sent = 0;
        const pump = (): void => {
          while (sent < 21) {
            sent += 1;
            if (!res.write(megabyte)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
      },
      async (fixtureUrl) => {
        await withClient(ownerFull, async (client) => {
          const smokeId = await saveBareSmoke(client, "intake-too-large");
          const { value, lines } = await captureMcpLog(() =>
            call(client, "add_smoke_photo", { smokeId, image: { download_url: fixtureUrl } }),
          );

          const data = payloadOf(value) as { mode: string; delivery: { status: string } };
          expect(data.mode).toBe("upload_url");
          expect(data.delivery.status).toBe("image_fetch_failed");

          const record = eventPayload(lines, "photo_intake");
          expect(record.outcome).toBe("too_large");
          expect((record.fetch as { bytes: number }).bytes).toBeGreaterThan(20 * 1024 * 1024);
        });
      },
    );
  });

  it("falls back to mode B with `unreadable` when the bytes are not a photo", async () => {
    // Used to be a `validation_error` telling the model to attach a supported
    // image — advice the model cannot act on, since it never attached anything.
    await withFixture(
      (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("this is definitely not an image, it is just prose");
      },
      async (fixtureUrl) => {
        await withClient(ownerFull, async (client) => {
          const smokeId = await saveBareSmoke(client, "intake-unreadable");
          const { value, lines } = await captureMcpLog(() =>
            call(client, "add_smoke_photo", { smokeId, image: { download_url: fixtureUrl } }),
          );

          expect(value.isError).not.toBe(true);
          const data = payloadOf(value) as { mode: string; delivery: { status: string } };
          expect(data.mode).toBe("upload_url");
          expect(data.delivery.status).toBe("image_unreadable");
          const record = eventPayload(lines, "photo_intake");
          expect(record.outcome).toBe("unreadable");
          // The error CLASS is recorded, never its message.
          expect(record.decodeError).toBe("UnsupportedImageTypeError");
        });
      },
    );
  });

  it("attaches a PNG served as application/octet-stream by sniffing magic bytes", async () => {
    // The pipeline gates on the DECLARED type, so a perfectly good photo used to
    // fail on a bad header alone. Magic bytes now win.
    await withFixture(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(PNG_FIXTURE);
      },
      async (fixtureUrl) => {
        await withClient(ownerFull, async (client) => {
          const smokeId = await saveBareSmoke(client, "intake-sniffed");
          // Delivered on the request-`_meta` channel, which is where alternate URL
          // keys live now: the published `image` schema is strict (issue #202
          // experiment 1) and admits only `download_url`, while `_meta` is not
          // schema-validated at all, so `url`/`uri`/`href`/`file_url` are still
          // accepted there — the naming-drift coverage this test carries.
          const { value, lines } = await captureMcpLog(
            () =>
              client.callTool({
                name: "add_smoke_photo",
                arguments: { smokeId },
                _meta: { "openai/fileParams": [{ url: fixtureUrl, file_id: "file_sniff" }] },
              }) as Promise<CallToolResult>,
          );

          const data = payloadOf(value) as { mode: string; photo: { photoId: string } };
          expect(data.mode).toBe("attached");
          expect(data.photo.photoId).toBeTruthy();

          const record = eventPayload(lines, "photo_intake");
          expect(record.outcome).toBe("attached");
          expect(record.mode).toBe("attached");
          expect(record.channel).toBe("request_meta");
          // The alternate URL key was accepted, and the record says which one hit.
          expect(record.urlKey).toBe("url");
          const fetched = record.fetch as { declaredType: string; sniffedType: string };
          expect(fetched.declaredType).toBe("application/octet-stream");
          expect(fetched.sniffedType).toBe("image/png");
        });
      },
    );
  });

  it("refuses a non-loopback http reference before opening a socket", async () => {
    // `image.download_url` is model-writable and the server fetches it from inside
    // the cluster, so widening the accepted URL keys had to ship WITH this guard.
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "intake-bad-scheme");
      const { value, lines } = await captureMcpLog(() =>
        call(client, "add_smoke_photo", {
          smokeId,
          image: { download_url: "http://169.254.169.254/latest/meta-data" },
        }),
      );

      const data = payloadOf(value) as { mode: string; delivery: { status: string } };
      expect(data.mode).toBe("upload_url");
      expect(data.delivery.status).toBe("image_reference_unusable");

      const record = eventPayload(lines, "photo_intake");
      expect(record.outcome).toBe("bad_scheme");
      // No fetch was attempted, so there is no fetch record to report.
      expect(record.fetch).toBeUndefined();
    });
  });


  it("follows a redirect to the real object, and refuses one that escapes the scheme guard", async () => {
    // Signed download URLs commonly 302 to a CDN, so redirects must work — but they
    // are followed MANUALLY and revalidated on every hop, because auto-following
    // would be a free bypass of the guard (https://host/ -> http://169.254.169.254/).
    await withFixture(
      (req, res) => {
        const url = (req as { url?: string }).url ?? "";
        if (url.startsWith("/hop")) {
          res.writeHead(302, { location: "/img.png" });
          res.end();
          return;
        }
        if (url.startsWith("/escape")) {
          res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_FIXTURE);
      },
      async (fixtureUrl) => {
        const origin = new URL(fixtureUrl).origin;
        await withClient(ownerFull, async (client) => {
          const smokeId = await saveBareSmoke(client, "intake-redirect");

          const followed = await captureMcpLog(() =>
            call(client, "add_smoke_photo", {
              smokeId,
              image: { download_url: `${origin}/hop` },
            }),
          );
          expect((payloadOf(followed.value) as { mode: string }).mode).toBe("attached");
          const okRecord = eventPayload(followed.lines, "photo_intake");
          expect(okRecord.outcome).toBe("attached");
          expect((okRecord.fetch as { redirects: number }).redirects).toBe(1);

          const blocked = await captureMcpLog(() =>
            call(client, "add_smoke_photo", {
              smokeId,
              image: { download_url: `${origin}/escape` },
            }),
          );
          const data = payloadOf(blocked.value) as { mode: string; delivery: { status: string } };
          expect(data.mode).toBe("upload_url");
          expect(data.delivery.status).toBe("image_reference_unusable");
          const blockedRecord = eventPayload(blocked.lines, "photo_intake");
          // A hop the GUARD refused is its own outcome, not a generic
          // `fetch_failed`: it is an attempted SSRF escape and has to be greppable
          // as one, apart from the timeouts and 404s it used to be buried among.
          expect(blockedRecord.outcome).toBe("bad_scheme");
          const blockedFetch = blockedRecord.fetch as { host: string; redirectFailure: string };
          expect(blockedFetch.redirectFailure).toBe("scheme_refused");
          // The guard bit at the redirect, so the recorded host is still the origin
          // we were allowed to talk to — the link-local address was never contacted.
          expect(blockedFetch.host).toBe("127.0.0.1");
          expect(blocked.lines.join("\n")).not.toContain("169.254.169.254");
        });
      },
      "/img.png",
    );
  });

  it("logs shapes, never values: no URL, query, token, or inline payload reaches the log", async () => {
    await withFixture(
      (_req, res) => {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG_FIXTURE);
      },
      async (fixtureUrl) => {
        await withClient(ownerFull, async (client) => {
          const smokeId = await saveBareSmoke(client, "intake-hygiene");
          const signed = `${fixtureUrl}?sig=SUPERSECRETSIGNATURE&exp=99`;
          const { value, lines } = await captureMcpLog(async () => {
            await client.callTool({
              name: "add_smoke_photo",
              arguments: { smokeId, image: { download_url: signed, file_id: "file_secret_id" } },
              _meta: { "openai/fileParams": [{ download_url: signed, file_id: "file_secret_id" }] },
            });
            // A second call carrying a base64 `data:` URL. Inline delivery is not
            // accepted (photo-intake.ts), so this is a `bad_scheme` fallback — and
            // the payload must not reach a log line on the way there either.
            return (await call(client, "add_smoke_photo", {
              smokeId,
              image: { download_url: `data:image/png;base64,${PNG_FIXTURE.toString("base64")}` },
            })) as CallToolResult;
          });

          const mcpLines = lines.filter((l) => l.includes("[mcp] "));
          const blob = mcpLines.join("\n");
          for (const secret of [
            "SUPERSECRETSIGNATURE",
            "file_secret_id",
            "/img.png",
            "sig=",
            PNG_FIXTURE.toString("base64").slice(0, 24),
          ]) {
            expect(blob, `a log line leaked ${secret}`).not.toContain(secret);
          }
          // …but the useful key names ARE there, on both channels.
          expect(blob).toContain('"download_url"');
          expect(blob).toContain('"file_id"');

          // The `data:` URL is refused by the guard, with no socket opened — and,
          // crucially, without its payload appearing anywhere in the record.
          const inline = payloadOf(value) as { mode: string; delivery: { status: string } };
          expect(inline.mode).toBe("upload_url");
          expect(inline.delivery.status).toBe("image_reference_unusable");
          expect(blob).toContain('"bad_scheme"');
        });
      },
    );
  });

  it("records an add_smoke_photo call the SDK rejects before the handler runs", async () => {
    // The one class of call today's instrumentation cannot see AT ALL: `.strict()`
    // refuses an undeclared top-level key inside the SDK, before `run()` — so no
    // `tool_called`, no `tool_error`, nothing. The HTTP probe records it anyway,
    // which is what will finally answer "does the host put the file somewhere we
    // never looked?". The strict schema is deliberately unchanged: relaxing it
    // would flip `additionalProperties` in the published manifest.
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "intake-probe");
      const { value, lines } = await captureMcpLog(
        () =>
          client.callTool({
            name: "add_smoke_photo",
            arguments: { smokeId, attachments: [{ file_id: "file_zzz" }] },
          }) as Promise<CallToolResult>,
      );

      expect(value.isError).toBe(true);

      const probe = eventPayload(lines, "photo_intake_request");
      expect(probe.tool).toBe("add_smoke_photo");
      // `params` ITSELF is described, not just `arguments` and `params._meta`. A
      // host that puts the file somewhere we never looked would show up right here
      // as an extra key — which is the probe's entire stated purpose, and was the
      // one thing it did not record.
      expect(probe.paramKeys).toEqual(["arguments", "name"]);
      expect(probe.argKeys).toEqual(["attachments", "smokeId"]);
      expect(probe.argImage).toEqual({ type: "absent", keys: [], filled: [] });
      expect(probe.metaFileParams).toEqual({ type: "absent", keys: [], filled: [], count: 0 });
      // The handler never ran, so there is no photo_intake line — the probe is the
      // only record, exactly as designed.
      expect(lines.some((l) => l.includes("[mcp] photo_intake {"))).toBe(false);
      // Nothing from the rejected arguments leaks as a value.
      expect(lines.join("\n")).not.toContain("file_zzz");
    });
  });

  it("records a body express.json() refuses, instead of failing it silently", async () => {
    // The gap that decided against inline base64 delivery. A body over the limit is
    // rejected by the body parser BEFORE bearerAuth, before the probe and before the
    // SDK — so it used to produce a 413 with zero server-side record and an HTML
    // error page on a JSON-RPC endpoint. That is the exact silent-unlogged-failure
    // class this change exists to remove, so the parser rejection is a record too.
    const { value, lines } = await captureMcpLog(async () =>
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerFull}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "add_smoke_photo",
            arguments: { smokeId: randomUUID(), caption: "x".repeat(200_000) },
          },
        }),
      }),
    );

    expect(value.status).toBe(413);
    expect(value.headers.get("content-type")).toContain("application/json");
    const record = eventPayload(lines, "request_rejected");
    expect(record.path).toBe("/mcp");
    expect(record.status).toBe(413);
    expect(record.reason).toBe("entity.too.large");
    // Only the type, the status and the declared length — the body is untrusted and
    // was never parsed, so nothing from it is logged.
    expect(lines.join("\n")).not.toContain("xxxxxxxxxx");
  });

  it("emits a probe record carrying the request-_meta file-param shape", async () => {
    await withClient(ownerFull, async (client) => {
      const smokeId = await saveBareSmoke(client, "intake-probe-meta");
      const { lines } = await captureMcpLog(() =>
        client.callTool({
          name: "add_smoke_photo",
          arguments: { smokeId, image: { file_id: "f" } },
          _meta: { "openai/fileParams": [{ file_id: "f1" }, { file_id: "f2" }] },
        }),
      );

      const probe = eventPayload(lines, "photo_intake_request");
      expect(probe.argImage).toEqual({ type: "object", keys: ["file_id"], filled: ["file_id"] });
      expect(probe.metaFileParams).toEqual({
        type: "object",
        keys: ["file_id"],
        filled: ["file_id"],
        count: 2,
      });
      expect(probe.metaKeys).toEqual(["openai/fileParams"]);
      // `_meta` is a key of `params`, so the params-level shape sees it as well.
      expect(probe.paramKeys).toEqual(["_meta", "arguments", "name"]);
      // The probe and the handler record join on (sessionId, rpcId).
      const record = eventPayload(lines, "photo_intake");
      expect(record.rpcId).toEqual(probe.rpcId);
      expect(record.sessionId).toEqual(probe.sessionId);
    });
  });

  it("rejects add_smoke_photo for a token without journal:write: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerCatalogJournal}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "add_smoke_photo", arguments: { smokeId: randomUUID() } },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("add_smoke_photo isolates by owner — another user cannot attach to a non-owned smoke", async () => {
    const smokeId = await withClient(ownerFull, async (client) => {
      const saved = payloadOf(
        await call(client, "save_smoke", {
          clientRequestId: randomUUID(),
          cigar: { cigarId: primaryCigarId },
          journal: { narrative: "Owner-only smoke for photo isolation." },
        }),
      ) as { smoke: { smokeId: string } };
      return saved.smoke.smokeId;
    });
    // `other` mints against the owner's smoke → smoke_not_found (existence never leaks).
    await withClient(otherFull, async (client) => {
      const result = await call(client, "add_smoke_photo", { smokeId });
      expect(errorOf(result).code).toBe("smoke_not_found");
    });
  });

  // ---- curation surface (admin only; DESIGN-003 wave 4a, issue #126) --------

  // A listing match at status 'auto' linked to a fresh cigar, with an offer that
  // carries the listing URL — the match_triage row shape the agent judges.
  async function seedAutoMatch(cigarName: string): Promise<{ matchId: string; cigarId: string }> {
    const cigarId = await h.seedCigar({ canonicalName: cigarName, verification: "unverified" });
    const [vendor] = await h.pg.db
      .insert(vendors)
      .values({ name: `Vendor ${randomUUID().slice(0, 8)}` })
      .returning({ id: vendors.id });
    const [match] = await h.pg.db
      .insert(listingMatches)
      .values({ vendorId: vendor!.id, listingKey: `sku-${randomUUID().slice(0, 8)}`, cigarId, status: "auto" })
      .returning({ id: listingMatches.id });
    await h.pg.db.insert(offers).values({
      vendorId: vendor!.id,
      listingMatchId: match!.id,
      listingUrl: "https://vendor.example.com/product/xyz",
      seenAt: new Date("2026-08-25T00:00:00Z"),
    });
    return { matchId: match!.id, cigarId };
  }

  // Audit row for an action within a run — filtered in JS (this package does not
  // depend on drizzle-orm operators directly, per enrichmentRows above).
  async function auditFor(
    action: string,
    runId: string,
  ): Promise<
    | {
        actor: string;
        runId: string | null;
        confidence: number | null;
        clientId: string | null;
        after: unknown;
      }
    | undefined
  > {
    const all = await h.pg.db.select().from(auditLog);
    const row = all.find((r) => r.runId === runId && r.action === action);
    return row
      ? {
          actor: row.actor,
          runId: row.runId,
          confidence: row.confidence,
          clientId: row.clientId,
          after: row.after,
        }
      : undefined;
  }

  async function cigarById(cigarId: string): Promise<(typeof cigars.$inferSelect) | undefined> {
    const all = await h.pg.db.select().from(cigars);
    return all.find((r) => r.id === cigarId);
  }

  it("rejects every curation tool for a curation-scoped NON-admin principal: unauthorized (scope present, role missing)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Gate Test Robusto", verification: "unverified" });
    await withClient(ownerCuration, async (client) => {
      const queue = await call(client, "get_curation_queue", { kind: "unverified" });
      expect(errorOf(queue).code).toBe("unauthorized");
      const verify = await call(client, "verify_cigar", { clientRequestId: randomUUID(), cigarId });
      expect(errorOf(verify).code).toBe("unauthorized");
    });
    // The non-admin attempt wrote nothing — the cigar is still unverified.
    expect((await cigarById(cigarId))!.verification).toBe("unverified");
  });

  it("rejects a curation tools/call for a journal:write token lacking the curation scope: 403", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerFull}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "set_cigar_facts",
          arguments: { clientRequestId: randomUUID(), cigarId: primaryCigarId, fields: { brand: "X" } },
        },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("get_curation_queue pages the unverified backlog with a cursor and serves the other kinds", async () => {
    // Three unverified cigars older than every other seed, so paging order is stable.
    const base = new Date("2026-07-01T00:00:00Z").getTime();
    for (let i = 0; i < 3; i++) {
      await h.pg.db.insert(cigars).values({
        canonicalName: `Queue Backlog ${i} ${randomUUID().slice(0, 6)}`,
        verification: "unverified",
        createdAt: new Date(base + i * 1000),
      });
    }
    await withClient(adminCuration, async (client) => {
      const p1 = payloadOf(
        await call(client, "get_curation_queue", { kind: "unverified", limit: 2 }),
      ) as { cigars: { cigarId: string; canonicalName: string }[]; nextCursor: string | null };
      expect(p1.cigars.length).toBe(2);
      expect(p1.nextCursor).toBeTruthy();

      const p2 = payloadOf(
        await call(client, "get_curation_queue", { kind: "unverified", limit: 2, cursor: p1.nextCursor }),
      ) as { cigars: { cigarId: string }[]; nextCursor: string | null };
      expect(p2.cigars.length).toBeGreaterThanOrEqual(1);
      // No overlap between the two pages (keyset advanced correctly).
      const ids1 = new Set(p1.cigars.map((c) => c.cigarId));
      for (const c of p2.cigars) expect(ids1.has(c.cigarId)).toBe(false);

      // Each other kind returns its own payload array under the same tool.
      const untyped = payloadOf(await call(client, "get_curation_queue", { kind: "untyped", limit: 5 })) as {
        cigars: unknown[];
      };
      expect(Array.isArray(untyped.cigars)).toBe(true);
      const unbranded = payloadOf(await call(client, "get_curation_queue", { kind: "unbranded", limit: 5 })) as {
        cigars: unknown[];
      };
      expect(Array.isArray(unbranded.cigars)).toBe(true);
      const dupes = payloadOf(await call(client, "get_curation_queue", { kind: "duplicates", limit: 5 })) as {
        duplicates: unknown[];
      };
      expect(Array.isArray(dupes.duplicates)).toBe(true);
    });
  });

  it("set_listing_match_status confirms an auto match; match_triage carries the listing + cigar facts; audit stamps agent + runId/confidence", async () => {
    const { matchId, cigarId } = await seedAutoMatch("Curation Match Toro");
    const runId = randomUUID();
    await withClient(adminCuration, async (client) => {
      const q = payloadOf(await call(client, "get_curation_queue", { kind: "match_triage", limit: 200 })) as {
        matches: { matchId: string; listingUrl: string | null; cigar: { cigarId: string; canonicalName: string } | null }[];
      };
      const row = q.matches.find((m) => m.matchId === matchId);
      expect(row).toBeTruthy();
      expect(row!.listingUrl).toBe("https://vendor.example.com/product/xyz");
      expect(row!.cigar?.cigarId).toBe(cigarId);
      expect(row!.cigar?.canonicalName).toBe("Curation Match Toro");

      const res = payloadOf(
        await call(client, "set_listing_match_status", {
          clientRequestId: randomUUID(),
          matchId,
          status: "confirmed",
          runId,
          confidence: 0.91,
        }),
      ) as { status: string; cigarId: string | null };
      expect(res.status).toBe("confirmed");
      expect(res.cigarId).toBe(cigarId);
    });
    const audit = await auditFor("listing_match.set_status", runId);
    expect(audit?.actor).toBe("agent");
    expect(audit?.runId).toBe(runId);
    expect(audit?.confidence).toBeCloseTo(0.91, 5);
  });

  // run_id is TEXT (migration 0016): the run's identity is the dev-env-ops
  // work-order key, not a uuid — the first live curation run failed every write
  // on the uuid cast, sanitized to `unavailable` (issue #126, 2026-08-29).
  it("accepts a work-order-key runId — a non-uuid run identity lands on the audit row", async () => {
    const { matchId } = await seedAutoMatch("Curation Order Key Toro");
    const runId = "wo-cigar-curate-20260829";
    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "set_listing_match_status", {
          clientRequestId: randomUUID(),
          matchId,
          status: "unmatched",
          runId,
          confidence: 0.95,
        }),
      ) as { status: string };
      expect(res.status).toBe("unmatched");
    });
    const audit = await auditFor("listing_match.set_status", runId);
    expect(audit?.actor).toBe("agent");
    expect(audit?.runId).toBe(runId);
  });

  // Migration 0023 / ADR-011: the whole chain, over the wire. A second curation
  // credential for the SAME admin subject stands in for a leaked elevated
  // service token; it runs the exact scenario the threat row has to survive —
  // read match_triage, then walk `unmatched` across it — under the same actor
  // and the same run id as the lane. The only thing that separates the two
  // afterwards is the client id the token row carried into the audit write.
  it("carries the token's client id onto a curation audit row, so a second credential of one subject is separable", async () => {
    const rogue = await mintToken(["curation:read", "curation:write"], adminUser.userId);
    expect(rogue.clientId).not.toBe(adminCurationClientId);

    const lane = await seedAutoMatch("Attribution Lane Toro");
    const stolen = await seedAutoMatch("Attribution Stolen Toro");
    const laneRun = randomUUID();
    const rogueRun = randomUUID();

    await withClient(adminCuration, async (client) => {
      await call(client, "set_listing_match_status", {
        clientRequestId: randomUUID(),
        matchId: lane.matchId,
        status: "unmatched",
        runId: laneRun,
        confidence: 0.9,
      });
    });

    await withClient(rogue.token, async (client) => {
      const queue = payloadOf(
        await call(client, "get_curation_queue", { kind: "match_triage", limit: 200 }),
      ) as { matches: { matchId: string }[] };
      expect(queue.matches.some((m) => m.matchId === stolen.matchId)).toBe(true);
      await call(client, "set_listing_match_status", {
        clientRequestId: randomUUID(),
        matchId: stolen.matchId,
        status: "unmatched",
        runId: rogueRun,
        confidence: 0.9,
      });
    });

    const laneAudit = await auditFor("listing_match.set_status", laneRun);
    const rogueAudit = await auditFor("listing_match.set_status", rogueRun);
    expect(laneAudit?.clientId).toBe(adminCurationClientId);
    expect(rogueAudit?.clientId).toBe(rogue.clientId);
    // Everything else about the two writes is identical — which is the point.
    expect(laneAudit?.actor).toBe(rogueAudit?.actor);
  });

  it("set_cigar_facts overwrites a wrong value on a verified cigar (unlike update_cigar) and audits actor agent", async () => {
    const cigarId = await h.seedCigar({
      canonicalName: "Wrongly Branded Corona",
      brand: "WrongBrand",
      type: "NC",
      verification: "verified",
    });
    const runId = randomUUID();
    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "set_cigar_facts", {
          clientRequestId: randomUUID(),
          cigarId,
          fields: { brand: "Padron", type: "CC" },
          runId,
          confidence: 0.8,
        }),
      ) as { changedFields: string[]; unchanged: string[]; verification: string };
      expect([...res.changedFields].sort()).toEqual(["brand", "type"]);
      expect(res.verification).toBe("verified");
    });
    const row = await cigarById(cigarId);
    expect(row!.brand).toBe("Padron");
    expect(row!.type).toBe("CC");
    const audit = await auditFor("cigar.set_facts", runId);
    expect(audit?.actor).toBe("agent");
    expect((audit?.after as Record<string, unknown>).brand).toBe("Padron");
  });

  it("verify_cigar flips an unverified cigar to verified (agent surface)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Needs Verify Robusto", verification: "unverified" });
    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "verify_cigar", { clientRequestId: randomUUID(), cigarId, runId: randomUUID(), confidence: 1 }),
      ) as { verification: string };
      expect(res.verification).toBe("verified");
    });
    expect((await cigarById(cigarId))!.verification).toBe("verified");
  });

  it("exclude_cigar then restore_cigar round-trips the catalog status (agent surface)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Pollution Panetela" });
    await withClient(adminCuration, async (client) => {
      const ex = payloadOf(
        await call(client, "exclude_cigar", { clientRequestId: randomUUID(), cigarId, runId: randomUUID() }),
      ) as { catalogStatus: string };
      expect(ex.catalogStatus).toBe("excluded");
      const re = payloadOf(
        await call(client, "restore_cigar", { clientRequestId: randomUUID(), cigarId, runId: randomUUID() }),
      ) as { catalogStatus: string };
      expect(re.catalogStatus).toBe("active");
    });
    expect((await cigarById(cigarId))!.catalogStatus).toBe("active");
  });

  it("set_product_photo_rights suppresses a product photo (agent surface)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Photo Rights Lonsdale" });
    await h.pg.db.insert(productPhotos).values({
      cigarId,
      objectKey: `obj/${randomUUID()}`,
      thumbKey: `thumb/${randomUUID()}`,
      contentType: "image/webp",
      width: 800,
      height: 600,
      bytes: 100,
      rights: "pending",
    });
    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "set_product_photo_rights", {
          clientRequestId: randomUUID(),
          cigarId,
          rights: "suppressed",
          runId: randomUUID(),
        }),
      ) as { rights: string };
      expect(res.rights).toBe("suppressed");
    });
    const all = await h.pg.db.select().from(productPhotos);
    expect(all.find((p) => p.cigarId === cigarId)!.rights).toBe("suppressed");
  });

  it("get_cigar is callable under a curation:read token (no catalog:read) — catalog detail only, no personal overlay", async () => {
    // The curate agent reads a cigar's full detail while triaging under a
    // curation-only token (#126). catalog:read OR curation:read authorizes get_cigar.
    await withClient(adminCuration, async (client) => {
      const result = await call(client, "get_cigar", { cigarId: primaryCigarId });
      const data = payloadOf(result) as Record<string, unknown>;
      expect((data.cigar as { cigarId: string }).cigarId).toBe(primaryCigarId);
      expect(data.enrichment).toBeDefined();
      // No journal:read on this token → the personal overlay is omitted entirely.
      expect(data.personalProfile).toBeUndefined();
      expect(data.wanted).toBeUndefined();
    });
  });

  it("rename_cigar sets a cigar's canonical name (agent surface)", async () => {
    const cigarId = await h.seedCigar({ canonicalName: "Padron 1926 No 9 Maldura" });
    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "rename_cigar", {
          clientRequestId: randomUUID(),
          cigarId,
          canonicalName: "Padrón 1926 No. 9 Maduro",
          runId: randomUUID(),
          confidence: 0.95,
        }),
      ) as { canonicalName: string; changed: boolean };
      expect(res.changed).toBe(true);
      expect(res.canonicalName).toBe("Padrón 1926 No. 9 Maduro");
    });
    expect((await cigarById(cigarId))!.canonicalName).toBe("Padrón 1926 No. 9 Maduro");
  });

  // ---- taxonomy curation tools (ADR-012 Wave 3, issue #196) -----------------
  //
  // The four registry verbs over the real wire: find-or-mint a brand → line →
  // blend path, edit the spellings a registry row answers to, place a leaf in
  // that structure, and split an entry that has been standing for several
  // products. Same admin gate, same `actor: agent` stamp and same idempotency
  // envelope as the rest of the curation surface, so the tests below are shaped
  // like the ones above them.

  describe("taxonomy curation tools", () => {
    interface RegisteredEntity {
      id: string;
      name: string;
      slug: string;
      aliases: string[];
      created: boolean;
    }
    interface RegisterPayload {
      brand: RegisteredEntity;
      line: RegisteredEntity | null;
      blend: RegisteredEntity | null;
      blenders: { id: string; name: string; created: boolean; credited: boolean }[];
      replayed: boolean;
    }
    interface AliasesPayload {
      level: string;
      id: string;
      name: string;
      aliases: string[];
      added: string[];
      removed: string[];
      replayed: boolean;
    }
    interface AssignPayload {
      cigarId: string;
      canonicalName: string;
      composedName: string;
      nameSource: string;
      changedFields: string[];
      preview: boolean;
      replayed: boolean;
    }
    interface SplitPayload {
      cigarId: string;
      splits: { cigarId: string; canonicalName: string; created: boolean; listingIds: string[] }[];
      remainingListings: number;
      replayed: boolean;
    }
    interface WorklistPayload {
      kind: string;
      cigars: { cigarId: string; brandId: string | null; lineId: string | null; blendId: string | null }[];
      nextCursor: string | null;
    }

    // Brand slugs and alias keys are globally unique, so every test names its own
    // marca — a fixed name would make the second test to reach for it a find
    // rather than a mint, and the `created` flags are what these tests read.
    function tag(): string {
      return randomUUID().slice(0, 8);
    }

    // Registry rows read with a plain select + find in JS, per the same rule
    // auditFor and cigarById follow (this package has no drizzle-orm dependency).
    async function brandRow(id: string): Promise<(typeof brands.$inferSelect) | undefined> {
      return (await h.pg.db.select().from(brands)).find((r) => r.id === id);
    }
    async function lineRow(id: string): Promise<(typeof lines.$inferSelect) | undefined> {
      return (await h.pg.db.select().from(lines)).find((r) => r.id === id);
    }
    async function blendRow(id: string): Promise<(typeof blends.$inferSelect) | undefined> {
      return (await h.pg.db.select().from(blends)).find((r) => r.id === id);
    }
    async function listingRow(id: string): Promise<(typeof listingMatches.$inferSelect) | undefined> {
      return (await h.pg.db.select().from(listingMatches)).find((r) => r.id === id);
    }

    // A crawler-guessed listing on an EXISTING cigar — the only state split_cigar
    // will re-point (`decided_by` defaults to crawler; a curator/agent verdict is
    // refused). Unlike seedAutoMatch above, the cigar is supplied.
    async function seedCrawlerListing(cigarId: string, vendorId: string): Promise<string> {
      const [match] = await h.pg.db
        .insert(listingMatches)
        .values({ vendorId, listingKey: `sku-${randomUUID().slice(0, 8)}`, cigarId, status: "auto" })
        .returning({ id: listingMatches.id });
      return match!.id;
    }

    async function register(args: Record<string, unknown>): Promise<RegisterPayload> {
      return withClient(
        adminCuration,
        async (client) =>
          payloadOf(
            await call(client, "register_taxonomy", { clientRequestId: randomUUID(), runId: randomUUID(), ...args }),
          ) as RegisterPayload,
      );
    }

    it("register_taxonomy mints a brand → line → blend path in one call, then FINDS the same path on the next", async () => {
      const t = tag();
      const brandName = `Dunbarton Trading ${t}`;
      const runId = randomUUID();

      const ids = await withClient(adminCuration, async (client) => {
        const res = payloadOf(
          await call(client, "register_taxonomy", {
            clientRequestId: randomUUID(),
            brand: { name: brandName, country: "Nicaragua" },
            line: { name: "Sobremesa" },
            blend: { name: "Brulee", wrapper: "Ecuadorian Habano" },
            runId,
            confidence: 0.92,
          }),
        ) as RegisterPayload;

        expect(res.replayed).toBe(false);
        expect(res.brand.created).toBe(true);
        expect(res.line!.created).toBe(true);
        expect(res.blend!.created).toBe(true);
        expect(res.brand.name).toBe(brandName);
        expect(res.line!.name).toBe("Sobremesa");
        expect(res.blend!.name).toBe("Brulee");
        // The brand's own name is a matching key from the moment it is minted.
        expect(res.brand.aliases).toContain(`dunbarton-trading-${t}`);
        return { brandId: res.brand.id, lineId: res.line!.id, blendId: res.blend!.id };
      });

      // The rows are really there, and each hangs off the level above it.
      const brand = await brandRow(ids.brandId);
      expect(brand?.name).toBe(brandName);
      expect(brand?.country).toBe("Nicaragua");
      const line = await lineRow(ids.lineId);
      expect(line?.name).toBe("Sobremesa");
      expect(line?.brandId).toBe(ids.brandId);
      const blend = await blendRow(ids.blendId);
      expect(blend?.name).toBe("Brulee");
      expect(blend?.lineId).toBe(ids.lineId);
      expect(blend?.wrapper).toBe("Ecuadorian Habano");

      const audit = await auditFor("line.create", runId);
      expect(audit?.actor).toBe("agent");
      expect(audit?.runId).toBe(runId);
      expect((audit?.after as Record<string, unknown>).brandId).toBe(ids.brandId);

      // GET-or-create: a fresh intent over the same path mints nothing. This is
      // the property the lane depends on — structuring a brand's fiftieth row
      // costs no more than its first, and reports `created: false` rather than
      // an "already exists" error the lane would have to learn to ignore.
      await withClient(adminCuration, async (client) => {
        const again = payloadOf(
          await call(client, "register_taxonomy", {
            clientRequestId: randomUUID(),
            brand: { name: brandName },
            line: { name: "Sobremesa" },
            blend: { name: "Brulee" },
            runId,
          }),
        ) as RegisterPayload;
        expect(again.brand.created).toBe(false);
        expect(again.line!.created).toBe(false);
        expect(again.blend!.created).toBe(false);
        expect(again.brand.id).toBe(ids.brandId);
        expect(again.line!.id).toBe(ids.lineId);
        expect(again.blend!.id).toBe(ids.blendId);
      });
    });

    it("register_taxonomy replays the same clientRequestId instead of minting a second time", async () => {
      const t = tag();
      const lineName = `Replay Line ${t}`;
      const args = {
        clientRequestId: randomUUID(),
        brand: { name: `Replay Marca ${t}` },
        line: { name: lineName },
        runId: randomUUID(),
        confidence: 0.5,
      };

      await withClient(adminCuration, async (client) => {
        const first = payloadOf(await call(client, "register_taxonomy", args)) as RegisterPayload;
        expect(first.replayed).toBe(false);
        expect(first.line!.created).toBe(true);

        const second = payloadOf(await call(client, "register_taxonomy", args)) as RegisterPayload;
        expect(second.replayed).toBe(true);
        expect(second.brand.id).toBe(first.brand.id);
        expect(second.line!.id).toBe(first.line!.id);
        // A replay reports the ORIGINAL verdict verbatim, not a fresh "found".
        expect(second.line!.created).toBe(true);
      });

      expect((await h.pg.db.select().from(lines)).filter((r) => r.name === lineName)).toHaveLength(1);
    });

    it("register_taxonomy mints a named blender and credits it on the blend", async () => {
      const t = tag();
      const res = await register({
        brand: { name: `Saka Trading ${t}` },
        line: { name: "Sobremesa" },
        blend: { name: "Brulee", blenders: ["Steve Saka"] },
      });

      expect(res.blenders).toHaveLength(1);
      expect(res.blenders[0]!.name).toBe("Steve Saka");
      expect(res.blenders[0]!.created).toBe(true);
      expect(res.blenders[0]!.credited).toBe(true);

      const person = (await h.pg.db.select().from(blenders)).find((r) => r.id === res.blenders[0]!.id);
      expect(person?.name).toBe("Steve Saka");
      expect(person?.slug).toBe("steve-saka");
    });

    it("update_registry_aliases folds an added spelling into the brand's matching keys, and drops it again", async () => {
      const t = tag();
      const spelling = `RYJ${t}`;
      const key = spelling.toLowerCase();
      const registered = await register({ brand: { name: `Romeo y Julieta ${t}` } });
      expect(registered.line).toBeNull();
      expect(registered.blend).toBeNull();
      const brandId = registered.brand.id;

      await withClient(adminCuration, async (client) => {
        const added = payloadOf(
          await call(client, "update_registry_aliases", {
            clientRequestId: randomUUID(),
            level: "brand",
            id: brandId,
            add: [spelling],
            runId: randomUUID(),
            confidence: 0.99,
          }),
        ) as AliasesPayload;

        // A display SPELLING went in; the folded matching KEY came back. That
        // asymmetry is the contract — a caller passing a pre-folded slug would
        // be guessing at a normalization the server owns.
        expect(added.added).toEqual([key]);
        expect(added.removed).toEqual([]);
        expect(added.aliases).toContain(key);
        expect(added.level).toBe("brand");
        expect(added.id).toBe(brandId);
      });
      expect((await brandRow(brandId))?.aliases).toContain(key);

      await withClient(adminCuration, async (client) => {
        const removed = payloadOf(
          await call(client, "update_registry_aliases", {
            clientRequestId: randomUUID(),
            level: "brand",
            id: brandId,
            remove: [spelling],
            runId: randomUUID(),
          }),
        ) as AliasesPayload;
        expect(removed.removed).toEqual([key]);
        expect(removed.added).toEqual([]);
        expect(removed.aliases).not.toContain(key);
      });
      expect((await brandRow(brandId))?.aliases).not.toContain(key);
    });

    it("update_registry_aliases refuses to remove the key derived from the entity's own name", async () => {
      const t = tag();
      const brandName = `Protected Marca ${t}`;
      const ownKey = `protected-marca-${t}`;
      const brandId = (await register({ brand: { name: brandName } })).brand.id;

      await withClient(adminCuration, async (client) => {
        const refused = await call(client, "update_registry_aliases", {
          clientRequestId: randomUUID(),
          level: "brand",
          id: brandId,
          remove: [brandName],
          runId: randomUUID(),
        });
        expect(errorOf(refused).code).toBe("validation_error");
      });

      // Still reachable by its own name — the refusal is what keeps it findable.
      expect((await brandRow(brandId))?.aliases).toContain(ownKey);
    });

    it("assign_cigar_taxonomy attaches a line and recomposes the canonical name from the parts", async () => {
      const t = tag();
      const brandName = `Tatuaje ${t}`;
      const lineName = "Havana Cazadores";
      const path = await register({ brand: { name: brandName }, line: { name: lineName } });
      const cigarId = await h.seedCigar({
        canonicalName: `Freeform Leftover ${t}`,
        brand: brandName,
        brandId: path.brand.id,
        verification: "unverified",
      });
      const runId = randomUUID();
      const composed = `${brandName} ${lineName} Robusto`;

      await withClient(adminCuration, async (client) => {
        const res = payloadOf(
          await call(client, "assign_cigar_taxonomy", {
            clientRequestId: randomUUID(),
            cigarId,
            lineId: path.line!.id,
            vitolaName: "Robusto",
            nameSource: "composed",
            runId,
            confidence: 0.88,
          }),
        ) as AssignPayload;

        expect(res.preview).toBe(false);
        expect(res.nameSource).toBe("composed");
        expect(res.canonicalName).toBe(composed);
        expect(res.composedName).toBe(composed);
        expect([...res.changedFields].sort()).toEqual(["lineId", "nameSource", "vitolaName"]);
      });

      const row = await cigarById(cigarId);
      expect(row!.canonicalName).toBe(composed);
      expect(row!.lineId).toBe(path.line!.id);
      expect(row!.vitolaName).toBe("Robusto");
      expect(row!.nameSource).toBe("composed");

      const audit = await auditFor("cigar.assign_parts", runId);
      expect(audit?.actor).toBe("agent");
      expect(audit?.runId).toBe(runId);
      expect((audit?.after as Record<string, unknown>).canonicalName).toBe(composed);
    });

    it("assign_cigar_taxonomy preview reports the composed name and writes nothing", async () => {
      const t = tag();
      const brandName = `Illusione ${t}`;
      const lineName = "Epernay";
      const path = await register({ brand: { name: brandName }, line: { name: lineName } });
      const original = `Preview Untouched ${t}`;
      const cigarId = await h.seedCigar({
        canonicalName: original,
        brand: brandName,
        brandId: path.brand.id,
        verification: "unverified",
      });
      const runId = randomUUID();

      await withClient(adminCuration, async (client) => {
        const res = payloadOf(
          await call(client, "assign_cigar_taxonomy", {
            clientRequestId: randomUUID(),
            cigarId,
            lineId: path.line!.id,
            vitolaName: "Le Ferme",
            nameSource: "composed",
            preview: true,
            runId,
            confidence: 0.4,
          }),
        ) as AssignPayload;

        expect(res.preview).toBe(true);
        expect(res.composedName).toBe(`${brandName} ${lineName} Le Ferme`);
        expect([...res.changedFields].sort()).toEqual(["lineId", "nameSource", "vitolaName"]);
      });

      // The whole point: the same validation ran and nothing moved.
      const row = await cigarById(cigarId);
      expect(row!.canonicalName).toBe(original);
      expect(row!.lineId).toBeNull();
      expect(row!.vitolaName).toBeNull();
      expect(row!.nameSource).toBe("freeform");
      expect(await auditFor("cigar.assign_parts", runId)).toBeUndefined();
    });

    it("assign_cigar_taxonomy refuses a line belonging to a different brand", async () => {
      const t = tag();
      const mine = await register({ brand: { name: `Ancestry Mine ${t}` } });
      const theirs = await register({ brand: { name: `Ancestry Theirs ${t}` }, line: { name: "Foreign Line" } });
      const cigarId = await h.seedCigar({
        canonicalName: `Ancestry Probe ${t}`,
        brandId: mine.brand.id,
        verification: "unverified",
      });

      await withClient(adminCuration, async (client) => {
        const refused = await call(client, "assign_cigar_taxonomy", {
          clientRequestId: randomUUID(),
          cigarId,
          lineId: theirs.line!.id,
          runId: randomUUID(),
        });
        expect(errorOf(refused).code).toBe("validation_error");
      });

      expect((await cigarById(cigarId))!.lineId).toBeNull();
    });

    it("split_cigar mints a leaf, moves one listing onto it as confirmed, and leaves the rest on the bucket", async () => {
      const t = tag();
      const brandName = `Warped ${t}`;
      const path = await register({ brand: { name: brandName } });
      const bucketId = await h.seedCigar({
        canonicalName: `${brandName} Assorted`,
        brand: brandName,
        brandId: path.brand.id,
        type: "NC",
        verification: "unverified",
      });
      const [vendor] = await h.pg.db
        .insert(vendors)
        .values({ name: `Split Vendor ${t}` })
        .returning({ id: vendors.id });
      const moving = await seedCrawlerListing(bucketId, vendor!.id);
      const staying = await seedCrawlerListing(bucketId, vendor!.id);
      const runId = randomUUID();

      const outcome = await withClient(adminCuration, async (client) =>
        payloadOf(
          await call(client, "split_cigar", {
            clientRequestId: randomUUID(),
            cigarId: bucketId,
            splits: [{ listingIds: [moving], vitolaName: "Robusto" }],
            runId,
            confidence: 0.93,
          }),
        ) as SplitPayload,
      );

      expect(outcome.cigarId).toBe(bucketId);
      expect(outcome.splits).toHaveLength(1);
      expect(outcome.splits[0]!.created).toBe(true);
      expect(outcome.splits[0]!.canonicalName).toBe(`${brandName} Robusto`);
      expect(outcome.splits[0]!.listingIds).toEqual([moving]);
      // A partial split is the expected outcome: listings nobody named stay put.
      expect(outcome.remainingListings).toBe(1);

      const leafId = outcome.splits[0]!.cigarId;
      const moved = await listingRow(moving);
      expect(moved?.cigarId).toBe(leafId);
      expect(moved?.status).toBe("confirmed");
      expect(moved?.decidedBy).toBe("agent");
      const kept = await listingRow(staying);
      expect(kept?.cigarId).toBe(bucketId);
      expect(kept?.status).toBe("auto");

      // The minted leaf inherits the bucket's identity facts and takes the parts
      // the split established; it is unverified because only STRUCTURE was asserted.
      const leaf = await cigarById(leafId);
      expect(leaf!.brandId).toBe(path.brand.id);
      expect(leaf!.type).toBe("NC");
      expect(leaf!.vitolaName).toBe("Robusto");
      expect(leaf!.nameSource).toBe("composed");
      expect(leaf!.verification).toBe("unverified");

      const audit = await auditFor("cigar.split", runId);
      expect(audit?.actor).toBe("agent");
      expect(audit?.runId).toBe(runId);
      expect((audit?.after as Record<string, unknown>).remainingListings).toBe(1);
    });

    // BOTH-OR-NEITHER, on the schema rather than in the handler, because the
    // handler cannot see the mistake: it drops the mint parts whenever a target
    // is present, so a model that hedged its mint with a half-remembered sibling
    // id gets its listings on the wrong cigar and a success payload. Asserted
    // against the schema directly — the point is that these args never reach the
    // wire, so there is no tool call to make.
    it("splitCigarSchema refuses a split arm carrying BOTH targetCigarId and mint parts", () => {
      const arm = (half: Record<string, unknown>) =>
        splitCigarSchema.safeParse({
          clientRequestId: randomUUID(),
          cigarId: randomUUID(),
          splits: [{ listingIds: [randomUUID()], ...half }],
        });

      const both = arm({ targetCigarId: randomUUID(), vitolaName: "Robusto" });
      expect(both.success).toBe(false);
      // The issue lands on `targetCigarId` and names the part that would have been
      // dropped: the model has to be told which half of its own call it lost.
      expect(both.error?.issues[0]?.path.at(-1)).toBe("targetCigarId");
      expect(both.error?.issues[0]?.message).toContain("vitolaName");

      // Either half ALONE is a complete instruction — the rule refuses the
      // contradiction, it does not make parts mandatory or targets suspect.
      expect(arm({ targetCigarId: randomUUID() }).success).toBe(true);
      expect(arm({ lineId: randomUUID(), vitolaName: "Robusto" }).success).toBe(true);

      // An EXPLICIT null is a supplied part, not an omission. `lineId: null` is a
      // model asserting "this leaf has no line" — meaningful only while minting
      // one, so alongside a target it is the same contradiction as any other part.
      const nulled = arm({ targetCigarId: randomUUID(), lineId: null });
      expect(nulled.success).toBe(false);
      expect(nulled.error?.issues[0]?.path.at(-1)).toBe("targetCigarId");
      expect(nulled.error?.issues[0]?.message).toContain("lineId");
    });

    it("refuses all four taxonomy tools for a journal token without curation:write: 403", async () => {
      const names = ["register_taxonomy", "update_registry_aliases", "assign_cigar_taxonomy", "split_cigar"] as const;

      for (const name of names) {
        // ownerFull holds every journal/catalog scope and no curation scope: the
        // curate agent's token reaches these verbs and no journal token ever can.
        expect(TOOL_SCOPES[name]).toEqual(["curation:write"]);
        const res = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${ownerFull}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: { clientRequestId: randomUUID() } },
          }),
        });
        expect(res.status, name).toBe(403);
        expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
      }
    });

    it("rejects all four taxonomy tools for a curation-scoped NON-admin principal: unauthorized", async () => {
      const t = tag();
      const brandName = `Gate Marca ${t}`;
      const cigarId = await h.seedCigar({ canonicalName: `Taxonomy Gate ${t}`, verification: "unverified" });

      await withClient(ownerCuration, async (client) => {
        const registered = await call(client, "register_taxonomy", {
          clientRequestId: randomUUID(),
          brand: { name: brandName },
        });
        expect(errorOf(registered).code).toBe("unauthorized");

        const aliased = await call(client, "update_registry_aliases", {
          clientRequestId: randomUUID(),
          level: "brand",
          id: randomUUID(),
          add: ["Anything"],
        });
        expect(errorOf(aliased).code).toBe("unauthorized");

        const assigned = await call(client, "assign_cigar_taxonomy", {
          clientRequestId: randomUUID(),
          cigarId,
          vitolaName: "Robusto",
        });
        expect(errorOf(assigned).code).toBe("unauthorized");

        const split = await call(client, "split_cigar", {
          clientRequestId: randomUUID(),
          cigarId,
          splits: [{ listingIds: [randomUUID()], vitolaName: "Robusto" }],
        });
        expect(errorOf(split).code).toBe("unauthorized");
      });

      // Scope without the role writes nothing at all.
      expect((await h.pg.db.select().from(brands)).filter((r) => r.name === brandName)).toHaveLength(0);
      expect((await cigarById(cigarId))!.vitolaName).toBeNull();
    });

    it("get_curation_queue serves the unlined and unblended rungs, each row carrying brandId/lineId/blendId", async () => {
      const t = tag();
      const path = await register({
        brand: { name: `Ladder ${t}` },
        line: { name: "Rung" },
        blend: { name: "Deep" },
      });
      const unlinedId = await h.seedCigar({
        canonicalName: `Ladder Unlined ${t}`,
        brandId: path.brand.id,
        verification: "unverified",
      });
      const unblendedId = await h.seedCigar({
        canonicalName: `Ladder Unblended ${t}`,
        brandId: path.brand.id,
        lineId: path.line!.id,
        verification: "unverified",
      });

      await withClient(adminCuration, async (client) => {
        const unlined = payloadOf(
          await call(client, "get_curation_queue", { kind: "unlined", limit: 200 }),
        ) as WorklistPayload;
        expect(Array.isArray(unlined.cigars)).toBe(true);
        const onBrand = unlined.cigars.find((c) => c.cigarId === unlinedId);
        expect(onBrand).toBeTruthy();
        expect(onBrand!.brandId).toBe(path.brand.id);
        expect(onBrand!.lineId).toBeNull();
        // The ladder is worked in order: a row that HAS a line has left this rung.
        expect(unlined.cigars.some((c) => c.cigarId === unblendedId)).toBe(false);

        const unblended = payloadOf(
          await call(client, "get_curation_queue", { kind: "unblended", limit: 200 }),
        ) as WorklistPayload;
        expect(Array.isArray(unblended.cigars)).toBe(true);
        const onLine = unblended.cigars.find((c) => c.cigarId === unblendedId);
        expect(onLine).toBeTruthy();
        expect(onLine!.brandId).toBe(path.brand.id);
        expect(onLine!.lineId).toBe(path.line!.id);
        expect(onLine!.blendId).toBeNull();
        expect(unblended.cigars.some((c) => c.cigarId === unlinedId)).toBe(false);

        // `unbranded` keys on brand_id, so a row carrying the FK is out of it.
        const unbranded = payloadOf(
          await call(client, "get_curation_queue", { kind: "unbranded", limit: 200 }),
        ) as WorklistPayload;
        expect(unbranded.cigars.some((c) => c.cigarId === unlinedId)).toBe(false);
      });
    });
  });

  // ---- queue_enrichment_backlog (#154) --------------------------------------

  it("queue_enrichment_backlog rides curation:write and refuses a journal:write token: 403", async () => {
    expect(TOOL_SCOPES.queue_enrichment_backlog).toEqual(["curation:write"]);

    // ownerFull carries every journal/catalog scope but no curation scope. This is
    // the whole point of the scope choice: the curate agent's existing curation
    // token reaches the tool, and no journal token ever can.
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerFull}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "queue_enrichment_backlog", arguments: { clientRequestId: randomUUID() } },
      }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("queue_enrichment_backlog refuses a curation-scoped NON-admin and writes nothing", async () => {
    const cigarId = await h.seedCigar({ canonicalName: `Backlog Gate ${randomUUID().slice(0, 8)}`, type: "NC" });
    await h.pg.db.insert(purchases).values({ userId: owner.userId, cigarId, quantity: 1 });

    await withClient(ownerCuration, async (client) => {
      const res = await call(client, "queue_enrichment_backlog", { clientRequestId: randomUUID() });
      expect(errorOf(res).code).toBe("unauthorized");
    });

    const rows = await h.pg.db.select().from(enrichmentRequests);
    expect(rows.filter((r) => r.cigarId === cigarId)).toHaveLength(0);
  });

  it("queue_enrichment_backlog writes nothing until an enrich lane covers the market, then queues under the run id", async () => {
    const deep = await h.seedCigar({ canonicalName: `Backlog Deep ${randomUUID().slice(0, 8)}`, type: "NC" });
    const shallow = await h.seedCigar({ canonicalName: `Backlog Shallow ${randomUUID().slice(0, 8)}`, type: "NC" });
    await h.pg.db.insert(purchases).values([
      { userId: adminUser.userId, cigarId: deep, quantity: 5 },
      { userId: adminUser.userId, cigarId: shallow, quantity: 1 },
    ]);
    const runId = `wo-cigar-curate-${randomUUID().slice(0, 8)}`;

    // The state this ships in: no vendor has completed an enrich run, so the agent
    // surface reports the whole worklist and writes NOTHING. This is the shipped
    // default, not a documented caution — a queued request the crawler cannot serve
    // is retired permanently after two passes.
    await withClient(adminCuration, async (client) => {
      const blocked = payloadOf(
        await call(client, "queue_enrichment_backlog", { clientRequestId: randomUUID(), runId, confidence: 0.9 }),
      ) as {
        queued: number;
        skipped: number;
        entries: { status: string }[];
        enrichedMarkets: string[];
        eligibleVendors: string[];
      };

      expect(blocked.queued).toBe(0);
      expect(blocked.skipped).toBe(2);
      expect(blocked.enrichedMarkets).toEqual([]);
      // No vendor has run an enrich pass, so no market is LIVE — and with no vendor
      // eligible either, nothing could look. The two predicates are reported
      // separately on purpose: they answer different questions.
      expect(blocked.eligibleVendors).toEqual([]);
      expect(blocked.entries.every((e) => e.status === "no_vendor_coverage")).toBe(true);
    });
    expect((await h.pg.db.select().from(enrichmentRequests)).filter((r) => r.cigarId === deep)).toHaveLength(0);

    // The ops prerequisite lands: a crawl-enabled vendor completes an enrich run.
    const enricherName = `Enricher ${randomUUID().slice(0, 8)}`;
    const [enricher] = await h.pg.db
      .insert(vendors)
      .values({ name: enricherName, focus: "both", crawlEnabled: true })
      .returning({ id: vendors.id });
    await h.pg.db.insert(crawlRuns).values({ vendorId: enricher!.id, kind: "enrich", status: "succeeded" });

    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "queue_enrichment_backlog", {
          clientRequestId: randomUUID(),
          runId,
          confidence: 0.9,
        }),
      ) as {
        queued: number;
        skipped: number;
        eligibleVendors: string[];
        entries: { cigarId: string; status: string; triedVendors?: string[] }[];
      };

      expect(res.queued).toBe(2);
      expect(res.skipped).toBe(0);
      // Worklist order: deepest hole in the humidor first.
      expect(res.entries.map((e) => e.cigarId)).toEqual([deep, shallow]);
      expect(res.entries.every((e) => e.status === "queued")).toBe(true);
      // #158: the payload names who COULD look, which enrichedMarkets cannot
      // express. It is not the exhaustion denominator — a vendor here whose market
      // is absent from enrichedMarkets is a lane that has never run, and counts
      // against nothing.
      expect(res.eligibleVendors).toContain(enricherName);
      // triedVendors rides only on the retirement verdicts; nothing was tried here.
      expect(res.entries.every((e) => e.triedVendors === undefined)).toBe(true);
    });

    const requests = await h.pg.db.select().from(enrichmentRequests);
    expect(requests.filter((r) => r.cigarId === deep)).toHaveLength(1);
    expect(requests.filter((r) => r.cigarId === shallow)).toHaveLength(1);

    // The adapter stamps actor `agent` server-side and carries the run id, so the
    // press shows in "Recent agent runs" as one grouped run.
    const audits = (await h.pg.db.select().from(auditLog)).filter((r) => r.runId === runId);
    expect(audits).toHaveLength(2);
    expect(audits.every((r) => r.actor === "agent" && r.action === "cigar.enrichment_request")).toBe(true);
  });

  it("queue_enrichment_backlog honours limit and reports the uncapped eligible count", async () => {
    // The admin already holds the two rows above; add a third and cap at one.
    const extra = await h.seedCigar({ canonicalName: `Backlog Capped ${randomUUID().slice(0, 8)}`, type: "NC" });
    await h.pg.db.insert(purchases).values({ userId: adminUser.userId, cigarId: extra, quantity: 9 });

    await withClient(adminCuration, async (client) => {
      const res = payloadOf(
        await call(client, "queue_enrichment_backlog", { clientRequestId: randomUUID(), limit: 1 }),
      ) as { eligible: number; considered: number; queued: number; entries: { cigarId: string }[] };

      expect(res.eligible).toBe(3);
      expect(res.considered).toBe(1);
      expect(res.queued).toBe(1);
      expect(res.entries.map((e) => e.cigarId)).toEqual([extra]); // quantity 9 leads
    });
  });
});
