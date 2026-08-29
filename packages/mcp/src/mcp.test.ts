import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
import { purchases, vendors, enrichmentRequests, offers, listingMatches, productPhotos, auditLog, cigars } from "@cj/db";
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
    adminCuration = (await mintToken(["curation:read", "curation:write"], adminUser.userId)).token;
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

  it("lists exactly the twenty-five tools with readOnlyHint on the eight reads, and sends the contract instructions", async () => {
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
  ): Promise<{ actor: string; runId: string | null; confidence: number | null; after: unknown } | undefined> {
    const all = await h.pg.db.select().from(auditLog);
    const row = all.find((r) => r.runId === runId && r.action === action);
    return row ? { actor: row.actor, runId: row.runId, confidence: row.confidence, after: row.after } : undefined;
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
});
