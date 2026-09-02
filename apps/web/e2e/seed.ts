import { randomUUID } from "node:crypto";
import {
  createDatabase,
  swallowShutdownErrors,
  blendBlenders,
  blenders,
  blends,
  brands,
  cigars,
  crawlRuns,
  lines,
  offers,
  purchases,
  users,
  vendors,
  type NewCigarRow,
} from "@cj/db";
import {
  claimInvite,
  createInvite,
  openPhotoDrop,
  reserveInvite,
  revokeInvite,
  saveSmoke,
  setFavorite,
  setWant,
  type Deps,
  type Principal,
} from "@cj/domain";
import { createMemoryPhotoStorage } from "@cj/photos";
import { createAuth } from "@cj/auth";

// The e2e fixture: seed a real Postgres with catalog cigars, a signed-in admin
// (the first-run bootstrap), a genuine non-admin created by MINTING AND REDEEMING
// a real invite, spare invites in each terminal state for the redemption specs,
// and two extra journals (one public, one private) so the public-page and
// admin-guard specs have deterministic data. Accounts and their session cookies
// are minted server-side through the SAME Better Auth instance the app runs, so
// the captured cookies verify against the live server (shared secret + shared DB).
// Everything here is data setup — no app source is touched.

// Fixed accounts. Only `admin` is allowlisted, and BOOTSTRAP_ADMIN_EMAILS now
// opens registration ONLY while the users table is empty (ADR-010) — so the admin
// must be created first, and every other account arrives by invite. `stranger` is
// never invited, so the sign-in specs have an address with no account.
export const ACCOUNTS = {
  admin: { email: "e2e-admin@example.com", password: "e2e-Passw0rd!" },
  nonAdmin: { email: "e2e-user@example.com", password: "e2e-Passw0rd!" },
  stranger: { email: "e2e-stranger@example.com", password: "e2e-Passw0rd!" },
} as const;

// The password the redemption spec sets on the account it creates.
export const INVITE_PASSWORD = "e2e-Passw0rd!";

export const ALLOWLIST = [ACCOUNTS.admin.email];

// A Playwright cookie, the shape a storageState file carries.
interface StateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: StateCookie[];
  origins: never[];
}

export interface Handoff {
  baseURL: string;
  accounts: typeof ACCOUNTS;
  // Raw invite tokens. An invite is single use, so `open` carries one per
  // possible attempt (Playwright retries once in CI) and the spec picks by retry
  // index; `expired` and `revoked` must render the invalid state.
  invites: {
    open: { token: string; email: string }[];
    expired: string;
    revoked: string;
  };
  cigars: {
    searchable: { id: string; name: string; query: string };
    detailWant: { id: string; name: string };
    smoked: { id: string; name: string };
    wanted: { id: string; name: string };
    sampleNC: { id: string; name: string };
    // A held cigar with no product photo — the "Missing photos" worklist row the
    // admin console's Queue enrichment button acts on (#154).
    heldPhotoless: { id: string; name: string };
    // Priced at every packaging tier (DESIGN-005): a single, a 5-pack and a box
    // from one shop, an out-of-stock box from a second, and one listing whose
    // packaging nobody recorded. The figures the Price section has to render.
    packaged: { id: string; name: string };
    // Smoked, favorited AND priced in stock — the one row that survives every
    // leaf toggle at once, so a grouped screen carrying all three still has a
    // card to drill through. `brandSlug` is the param that drill lands on.
    everyToggle: { id: string; name: string; brandSlug: string; brandName: string };
  };
  // A deterministic near-duplicate pair for the admin console's merge/unmerge
  // round trip. Distinct from every other seeded name so the pair is the only one
  // the Duplicates section surfaces for these two rows.
  duplicatePair: { survivor: { id: string; name: string }; duplicate: { id: string; name: string } };
  brand: string;
  // The structured Brand → Line → Blend → Vitola tree (ADR-012), so the DESIGN-004
  // drill paths are exercised against real registry rows rather than the free-text
  // columns. Production is mostly unfiled until the Wave 3 backfill runs, and the
  // fixture deliberately carries BOTH shapes: a fully structured branch and a
  // brand-only row that lands in the Unfiled bucket at the line level.
  taxonomy: {
    brand: { slug: string; name: string };
    line: { slug: string; name: string };
    blend: { slug: string; name: string };
    // A second blend under the same line, so a line drill has more than one card
    // to group and the Blend chip has something to choose between.
    siblingBlend: { slug: string; name: string };
    vitola: { slug: string; name: string };
    blender: string;
    // A composed row: inside a line drill its caption elides to `No. 9 · Toro`
    // (D-07) while its canonical name stays the full string.
    composed: { id: string; canonicalName: string; elidedInLine: string };
    // The same blend, `type` unknown — production's dominant shape, and the row
    // that shows an unestablished type credits no blender.
    untyped: { id: string; canonicalName: string };
    // Structured down to the brand only — the row the `line=unfiled` card drills to.
    unfiled: { id: string; canonicalName: string };
  };
  // An OPEN photo drop belonging to the admin (ADR-014), and the raw token of the
  // link it minted. The drop page is reached with the token alone, so the spec
  // that drives it never signs in.
  photoDrop: { token: string };
  publicSmoke: { id: string; cigarName: string; narrativeSnippet: string };
  privateSmokeId: string;
  // Journal entries with no title, so the smoke-detail h1 falls back to the
  // cigar name (issue #49). Prod has none, so only the fixture exercises it.
  untitledSmoke: { id: string; cigarId: string; cigarName: string };
  untitledPublicSmoke: { id: string; cigarName: string };
  // An agent run whose rows overflow the console's 100-row page, so the "Load
  // more" control has something to reveal (#173). `oldestRowLabel` is the row
  // that is only reachable on the second page.
  overflowRun: { runId: string; rows: number; newestRowLabel: string; oldestRowLabel: string };
}

// Parse a session cookie out of a Better Auth response and shape it for a
// Playwright storageState. Only `session_token` is kept — the `session_data`
// cache cookie is dropped on purpose so every request re-derives the principal
// (and thus the role) from the database, which is what lets the downgraded
// non-admin read back as a `user` rather than the cached admin it was minted as.
function sessionCookies(response: Response, host: string): StateCookie[] {
  const out: StateCookie[] = [];
  for (const raw of response.headers.getSetCookie()) {
    const [pair, ...attrs] = raw.split(";");
    const eq_ = pair!.indexOf("=");
    const name = pair!.slice(0, eq_).trim();
    const value = pair!.slice(eq_ + 1).trim();
    if (!name.includes("session_token") || value.length === 0) continue;

    const attrMap = new Map<string, string>();
    for (const attr of attrs) {
      const idx = attr.indexOf("=");
      const key = (idx === -1 ? attr : attr.slice(0, idx)).trim().toLowerCase();
      attrMap.set(key, idx === -1 ? "" : attr.slice(idx + 1).trim());
    }
    const maxAge = Number(attrMap.get("max-age"));
    const expires = Number.isFinite(maxAge) && maxAge > 0 ? Math.floor(Date.now() / 1000) + maxAge : -1;

    out.push({
      name,
      value,
      domain: host,
      path: attrMap.get("path") || "/",
      expires,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    });
  }
  return out;
}

async function insertCigar(deps: Deps, values: { canonicalName: string } & Partial<NewCigarRow>): Promise<string> {
  const rows = await deps.db
    .insert(cigars)
    .values({ verification: "verified", ...values })
    .returning({ id: cigars.id });
  return rows[0]!.id;
}

async function insertUser(
  deps: Deps,
  email: string,
  visibility: "public" | "private",
  displayName: string,
): Promise<Principal> {
  const rows = await deps.db
    .insert(users)
    .values({ email, role: "user", journalVisibility: visibility, displayName, emailVerified: true })
    .returning({ id: users.id });
  return { userId: rows[0]!.id, role: "user" };
}

export async function seed(opts: {
  databaseUrl: string;
  baseURL: string;
  secret: string;
}): Promise<{ handoff: Handoff; adminState: StorageState; nonAdminState: StorageState }> {
  const host = new URL(opts.baseURL).hostname;
  // The e2e Postgres is torn down as soon as the run ends, and a pool that is
  // still holding connections when it goes raises node-postgres' 'error' EVENT —
  // unlistened, that takes the Playwright global setup down with it and reports a
  // green suite as a harness crash (@cj/db pool-errors.ts).
  const { db, pool } = createDatabase(opts.databaseUrl);
  swallowShutdownErrors(pool, { label: "e2e-seed" });
  const deps: Deps = { db, now: () => new Date() };
  const auth = createAuth({
    db,
    secret: opts.secret,
    baseURL: opts.baseURL,
    bootstrapAdminEmails: ALLOWLIST,
  });

  try {
    // --- Catalog -----------------------------------------------------------
    const padron64 = await insertCigar(deps, {
      canonicalName: "Padrón 1964 Anniversary Maduro",
      brand: "Padrón",
      line: "1964 Anniversary",
      vitolaName: "Exclusivo",
      type: "NC",
      lengthInches: "5.5",
      ringGauge: 50,
    });
    await insertCigar(deps, {
      canonicalName: "Padrón 1926 Serie No. 9",
      brand: "Padrón",
      line: "1926 Serie",
      vitolaName: "No. 9",
      type: "NC",
      lengthInches: "5.25",
      ringGauge: 56,
    });
    const behike = await insertCigar(deps, {
      canonicalName: "Cohiba Behike 52",
      brand: "Cohiba",
      vitolaName: "BHK 52",
      type: "CC",
      lengthInches: "4.7",
      ringGauge: 52,
    });
    const sigloVi = await insertCigar(deps, {
      canonicalName: "Cohiba Siglo VI",
      brand: "Cohiba",
      vitolaName: "Cañonazo",
      type: "CC",
      lengthInches: "5.9",
      ringGauge: 52,
    });
    const monte2 = await insertCigar(deps, {
      canonicalName: "Montecristo No. 2",
      brand: "Montecristo",
      vitolaName: "Pirámide",
      type: "CC",
      lengthInches: "6.1",
      ringGauge: 52,
    });
    const hemingway = await insertCigar(deps, {
      canonicalName: "Arturo Fuente Hemingway Short Story",
      brand: "Arturo Fuente",
      vitolaName: "Short Story",
      type: "NC",
      lengthInches: "4",
      ringGauge: 49,
    });
    const oliva = await insertCigar(deps, {
      canonicalName: "Oliva Serie V Melanio Robusto",
      brand: "Oliva",
      vitolaName: "Robusto",
      type: "NC",
      lengthInches: "5",
      ringGauge: 52,
    });
    // The one cigar priced at every packaging tier (DESIGN-005), so the Price
    // section's blocks, its two-fact headline and the tile's `from` are all
    // exercised against real offers rather than a mock. Its own row, because no
    // other seeded cigar may carry a box price without breaking the specs that
    // read their prices.
    const packaged = await insertCigar(deps, {
      canonicalName: "Warped Flor del Valle Sky Flower",
      brand: "Warped",
      vitolaName: "Corona Gorda",
      type: "NC",
      lengthInches: "5.5",
      ringGauge: 46,
    });
    // A deliberately long canonical name — the untitled-entry h1 has to wrap it
    // rather than overflow, and prod's longest is 93 characters.
    const opusx = await insertCigar(deps, {
      canonicalName:
        "Fuente Fuente OpusX 20 Years Double Corona Cigar Family Charitable Foundation Event Exclusive",
      brand: "Arturo Fuente",
      line: "OpusX",
      vitolaName: "Double Corona",
      type: "NC",
      lengthInches: "7.6",
      ringGauge: 49,
    });

    // --- The structured taxonomy branch (ADR-012 / DESIGN-004) -------------
    // Registry rows, then leaves that actually point at them. Migration 0026's
    // mechanical backfill only ever mints BRANDS from the free-text column, so a
    // line/blend/vitola drill has nothing to walk unless the fixture builds one.
    //
    // `aliases` holds matching keys, not display text (the 0026 convention), and
    // the slugs are what the URL drills on.
    const [drewEstate] = await deps.db
      .insert(brands)
      .values({ name: "Drew Estate", slug: "drew-estate", aliases: ["drew-estate"] })
      .returning({ id: brands.id });
    const [ligaPrivada] = await deps.db
      .insert(lines)
      .values({
        brandId: drewEstate!.id,
        name: "Liga Privada",
        slug: "liga-privada",
        aliases: ["liga-privada"],
      })
      .returning({ id: lines.id });
    // The blend carries the level facts DESIGN-004 D-08 renders as facts rows —
    // filler/binder/wrapper and strength live here, not on each vitola.
    const [noNine] = await deps.db
      .insert(blends)
      .values({
        lineId: ligaPrivada!.id,
        name: "No. 9",
        slug: "no-9",
        aliases: ["no-9"],
        wrapper: "Connecticut Broadleaf",
        binder: "Brazilian Mata Fina",
        filler: "Nicaraguan and Honduran",
        strength: "full",
      })
      .returning({ id: blends.id });
    // A sibling blend so a line drill groups more than one card.
    const [t52] = await deps.db
      .insert(blends)
      .values({ lineId: ligaPrivada!.id, name: "T52", slug: "t52", aliases: ["t52"] })
      .returning({ id: blends.id });
    // A credited blender, so the Blender facts row has something to render. The
    // cigars below are NC — a Cuban blend would credit the marca and render no
    // blender row at all (ADR-013).
    const [herrera] = await deps.db
      .insert(blenders)
      .values({ name: "Willy Herrera", slug: "willy-herrera", aliases: ["willy-herrera"] })
      .returning({ id: blenders.id });
    await deps.db.insert(blendBlenders).values({ blendId: noNine!.id, blenderId: herrera!.id });

    const structured = {
      brandId: drewEstate!.id,
      lineId: ligaPrivada!.id,
      type: "NC" as const,
      // `composed` is what licenses the caption elision (D-07); a freeform row
      // always renders its canonical name raw.
      nameSource: "composed" as const,
    };
    const ligaNo9Toro = await insertCigar(deps, {
      ...structured,
      blendId: noNine!.id,
      canonicalName: "Drew Estate Liga Privada No. 9 Toro",
      brand: "Drew Estate",
      line: "Liga Privada",
      vitolaName: "Toro",
      lengthInches: "6",
      ringGauge: 52,
    });
    await insertCigar(deps, {
      ...structured,
      blendId: noNine!.id,
      canonicalName: "Drew Estate Liga Privada No. 9 Robusto",
      brand: "Drew Estate",
      line: "Liga Privada",
      vitolaName: "Robusto",
      lengthInches: "5",
      ringGauge: 54,
    });
    await insertCigar(deps, {
      ...structured,
      blendId: t52!.id,
      canonicalName: "Drew Estate Liga Privada T52 Toro",
      brand: "Drew Estate",
      line: "Liga Privada",
      vitolaName: "Toro",
      lengthInches: "6",
      ringGauge: 52,
    });
    // The same blend with its `type` unknown — the shape the overwhelming
    // majority of production rows are in. It is what makes the blender credit
    // testable: the gate is a POSITIVE `type === "NC"`, so a row nobody has
    // established anything about credits nobody (ADR-013).
    const ligaNo9CoronaDoble = await insertCigar(deps, {
      ...structured,
      type: null,
      blendId: noNine!.id,
      canonicalName: "Drew Estate Liga Privada No. 9 Corona Doble",
      brand: "Drew Estate",
      line: "Liga Privada",
      vitolaName: "Corona Doble",
      lengthInches: "7",
      ringGauge: 54,
    });
    // Brand known, line unknown — exactly the shape 97% of production is in
    // until Wave 3 curates. This is what the trailing `Unfiled` card counts, and
    // what `?brand=drew-estate&line=unfiled` drills to.
    const undercrown = await insertCigar(deps, {
      canonicalName: "Drew Estate Undercrown Gordito",
      brand: "Drew Estate",
      brandId: drewEstate!.id,
      vitolaName: "Gordito",
      type: "NC",
    });

    // Deliberately sparse — no dimensions, no photo — so it is genuinely
    // enrichable rather than reported `not_needed`. Verified, because the enqueue
    // refuses a canonical name nobody has reviewed (#154).
    const photoless = await insertCigar(deps, {
      canonicalName: "Tatuaje Black Label Corona Gorda",
      brand: "Tatuaje",
      type: "NC",
    });

    // A near-duplicate pair (accent variant, well above the 0.6 trigram bar) so the
    // console's Duplicates → merge → Recent merges → Unmerge round trip has real
    // data. Unverified so they also sit in the verification backlog, like any
    // freshly crawled row.
    const dupePlain = await insertCigar(deps, {
      canonicalName: "Ramon Allones Especialmente Seleccionados",
      brand: "Ramon Allones",
      type: "CC",
      verification: "unverified",
    });
    const dupeAccented = await insertCigar(deps, {
      canonicalName: "Ramón Allones Especialmente Seleccionados",
      brand: "Ramón Allones",
      type: "CC",
      verification: "unverified",
    });

    // The enqueue also refuses a market no enrich lane reaches, so the fixture has
    // to include the lane: one crawl-enabled NC vendor with a completed enrich run.
    // Without this the Queue enrichment button correctly queues nothing. Seeding a
    // vendor creates no user, so it is safe ahead of the first-run admin.
    const vendorRows = await deps.db
      .insert(vendors)
      // `displayEnabled` explicitly: it defaults to false and every price read
      // requires it (ADR-015), so without it this vendor's offer below is
      // recorded and invisible — and the in-stock screens have nothing to show.
      .values({
        name: "E2E Cigars",
        focus: "NC",
        crawlEnabled: true,
        approvalStatus: "owner-added",
        displayEnabled: true,
      })
      .returning({ id: vendors.id });
    await deps.db.insert(crawlRuns).values({
      vendorId: vendorRows[0]!.id,
      kind: "enrich",
      status: "succeeded",
      finishedAt: new Date(),
    });

    // --- The packaging tiers (DESIGN-005) ----------------------------------
    // A second shop, so a tier holds more than one vendor row, and a registry
    // vendor that is NOT a purchase destination (ADR-006, the Cuban Lou's
    // posture): displayed, labeled `unapproved source`, never linked out. Its
    // listing names no packaging, which is the whole point — $452.60 is a real
    // figure and a reader must never take it for the price of one cigar.
    const [secondShop] = await deps.db
      .insert(vendors)
      .values({
        name: "E2E Second Cigars",
        focus: "NC",
        approvalStatus: "owner-added",
        displayEnabled: true,
      })
      .returning({ id: vendors.id });
    const [unapprovedShop] = await deps.db
      .insert(vendors)
      .values({
        name: "E2E Reference Shop",
        focus: "NC",
        approvalStatus: "unapproved",
        displayEnabled: true,
        purchaseLinkout: false,
      })
      .returning({ id: vendors.id });
    // The ad-hoc path (no listing match), like the Montecristo offer below — the
    // tiers are a property of the offer rows, not of how they reached the cigar.
    await deps.db.insert(offers).values([
      {
        vendorId: vendorRows[0]!.id,
        cigarId: packaged,
        inStock: true,
        price: "11.59",
        currency: "USD",
        packaging: "single",
        sticksPerPackage: 1,
        pricePerStickCents: 1159,
        listingUrl: "https://e2e-cigars.example/sky-flower/single",
      },
      {
        vendorId: vendorRows[0]!.id,
        cigarId: packaged,
        inStock: true,
        price: "55.00",
        currency: "USD",
        packaging: "5-pack",
        sticksPerPackage: 5,
        pricePerStickCents: 1100,
        listingUrl: "https://e2e-cigars.example/sky-flower/5-pack",
      },
      {
        vendorId: vendorRows[0]!.id,
        cigarId: packaged,
        inStock: true,
        price: "210.00",
        currency: "USD",
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStickCents: 1050,
        listingUrl: "https://e2e-cigars.example/sky-flower/box",
      },
      {
        vendorId: secondShop!.id,
        cigarId: packaged,
        inStock: false,
        price: "224.00",
        currency: "USD",
        packaging: "box",
        sticksPerPackage: 20,
        pricePerStickCents: 1120,
        listingUrl: "https://e2e-second.example/sky-flower/box",
      },
      {
        vendorId: unapprovedShop!.id,
        cigarId: packaged,
        inStock: true,
        price: "452.60",
        currency: "USD",
        listingUrl: "https://e2e-reference.example/sky-flower",
      },
    ]);

    // --- Mechanical brand backfill, mirroring migration 0026 ---------------
    // The migration mints one `brands` row per distinct free-text brand and links
    // the cigars carrying it — but it runs BEFORE this fixture inserts anything,
    // so without replaying it every seeded row would have `brand_id` NULL and the
    // whole brand grouping would collapse into Unfiled. Production does not look
    // like that, so neither should the fixture.
    //
    // The slug rule is 0026's verbatim character class (deliberately not `a-z`,
    // which collation can widen), so `Padrón` slugs to `padr-n` here exactly as it
    // does in production — the ugly-but-stable key that keeps existing brand URLs
    // and `brand_images` joins working. Guarded on `brand_id IS NULL`, so the
    // structured branch seeded above keeps the links it was given.
    const BRAND_SLUG = `btrim(regexp_replace(lower(btrim(c.brand)), '[^abcdefghijklmnopqrstuvwxyz0123456789]+', '-', 'g'), '-')`;
    await pool.query(`
      INSERT INTO brands (name, slug)
      SELECT DISTINCT ON (slug) name, slug FROM (
        SELECT btrim(c.brand) AS name, ${BRAND_SLUG} AS slug, count(*) AS n
        FROM cigars c WHERE nullif(btrim(c.brand), '') IS NOT NULL
        GROUP BY btrim(c.brand)
      ) s WHERE slug <> ''
      ORDER BY slug, n DESC, name ASC
      ON CONFLICT (slug) DO NOTHING
    `);
    await pool.query(`
      UPDATE cigars c SET brand_id = b.id FROM brands b
      WHERE c.brand_id IS NULL
        AND nullif(btrim(c.brand), '') IS NOT NULL
        AND b.slug = ${BRAND_SLUG}
    `);

    // --- Admin account (first-run bootstrap -> admin) ----------------------
    // Must be first: the allowlist only opens registration while `users` is empty.
    await auth.api.signUpEmail({
      body: { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password, name: "E2E Admin" },
    });
    const adminSignIn = await auth.api.signInEmail({
      body: { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password },
      asResponse: true,
    });
    const adminId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ACCOUNTS.admin.email])
    ).rows[0]!.id;
    const admin: Principal = { userId: adminId, role: "admin" };
    const adminState: StorageState = { cookies: sessionCookies(adminSignIn, host), origins: [] };

    // Admin personal state: a want (feeds the Wanted shelf + want facet) and a
    // smoke (feeds the Smoked chip and a non-empty journal).
    await setWant(deps, admin, { cigarId: hemingway, wanted: true });
    await saveSmoke(deps, admin, {
      clientRequestId: randomUUID(),
      cigar: { cigarId: monte2 },
      smokedAt: { value: "2026-08-20T20:00" },
      overallDescriptors: ["cedar", "espresso"],
      assessment: { rating: 92, liked: true, strength: "medium-full", body: "full", impression: null },
      journal: { title: "A reliable No. 2", narrative: "Classic Montecristo pyramid — cocoa and cedar." },
    });
    // No journal title: the detail page's h1 becomes the cigar name and links to
    // the catalog. Kebab-cased descriptors ride along so the chip label
    // transform is exercised on a real surface too.
    const untitledSave = await saveSmoke(deps, admin, {
      clientRequestId: randomUUID(),
      cigar: { cigarId: opusx },
      smokedAt: { value: "2026-08-21T20:00" },
      overallDescriptors: ["dark chocolate", "white pepper"],
      assessment: { rating: 100, liked: true, strength: "full", body: "full", impression: null },
      journal: { narrative: "No title on this one — the cigar name has to carry the page." },
    });

    // The Montecristo carries the other two leaf marks as well, so exactly ONE
    // row in the catalog survives `instock=1&smoked=1&favorites=1` at once.
    // Without it that combination empties every grouped screen, and the drill
    // round trip that has to hold all three on the URL has no card to descend
    // through. The offer takes the ad-hoc path (no listing match), which is all
    // `has_in_stock` reads.
    await setFavorite(deps, admin, { cigarId: monte2, favorited: true });
    await deps.db.insert(offers).values({
      vendorId: vendorRows[0]!.id,
      cigarId: monte2,
      inStock: true,
      price: "24.00",
      currency: "USD",
      packaging: "single",
      sticksPerPackage: 1,
      pricePerStickCents: 2400,
    });

    // A holding with no product photo, so /admin/catalog renders the "Missing
    // photos" worklist and its Queue enrichment button has something to queue.
    // Inserted directly rather than through recordPurchase: that path queues an
    // enrichment request of its own, which would pre-empt the very thing the
    // button is meant to do.
    await deps.db.insert(purchases).values({ userId: adminId, cigarId: photoless, quantity: 4 });

    // --- Non-admin account (minted and redeemed through a real invite) ------
    // The invite path is the only way to create a user now, so the fixture uses
    // it rather than a role downgrade — the spec's non-admin is a `user` because
    // an invite cannot produce anything else (ADR-010).
    const nonAdminInvite = await createInvite(deps, admin, { email: ACCOUNTS.nonAdmin.email });
    const nonAdminReserved = await reserveInvite(deps, { token: nonAdminInvite.token });
    const nonAdminSignUp = await auth.api.signUpEmail({
      body: { email: ACCOUNTS.nonAdmin.email, password: ACCOUNTS.nonAdmin.password, name: "E2E User" },
      asResponse: true,
    });
    const nonAdminState: StorageState = { cookies: sessionCookies(nonAdminSignUp, host), origins: [] };
    const nonAdminId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ACCOUNTS.nonAdmin.email])
    ).rows[0]!.id;
    await claimInvite(deps, { inviteId: nonAdminReserved.inviteId, userId: nonAdminId });

    // --- An open photo drop (ADR-014) --------------------------------------
    // The link the drop page is opened with. Storage is only reached from here by
    // the retention sweep, which has nothing to sweep in a database this fresh, so
    // the in-memory implementation is enough — the photos the SPEC uploads travel
    // through the app's own S3 client into the harness object store.
    const photoDrop = await openPhotoDrop(deps, createMemoryPhotoStorage(), admin);

    // --- Invites for the redemption specs -----------------------------------
    const openInvites: { token: string; email: string }[] = [];
    for (const attempt of [0, 1]) {
      const email = `e2e-invited-${attempt}@example.com`;
      const minted = await createInvite(deps, admin, { email });
      openInvites.push({ token: minted.token, email });
    }
    const expiredInvite = await createInvite(deps, admin, { email: "e2e-expired@example.com" });
    // Backdated directly: expiry is a clock fact the domain service never rewinds.
    await pool.query("UPDATE invites SET expires_at = now() - interval '1 day' WHERE id = $1", [
      expiredInvite.inviteId,
    ]);
    const revokedInvite = await createInvite(deps, admin, { email: "e2e-revoked@example.com" });
    await revokeInvite(deps, admin, { inviteId: revokedInvite.inviteId });

    // --- Public journal --------------------------------------------------
    const publicOwner = await insertUser(deps, "e2e-public@example.com", "public", "Public Owner");
    const publicSave = await saveSmoke(deps, publicOwner, {
      clientRequestId: randomUUID(),
      cigar: { cigarId: sigloVi },
      smokedAt: { value: "2026-08-25T21:00" },
      overallDescriptors: ["cream", "cedar"],
      assessment: { rating: 95, liked: true, strength: "medium", body: "medium", impression: null },
      journal: {
        title: "Evening Siglo",
        narrative: "A calm evening with a Siglo VI — cream and cedar the whole way down.",
      },
    });
    await saveSmoke(deps, publicOwner, {
      clientRequestId: randomUUID(),
      cigar: { cigarId: padron64 },
      smokedAt: { value: "2026-08-24T19:00" },
      overallDescriptors: ["cocoa", "pepper"],
      journal: { title: "Maduro night", narrative: "The 1964 Maduro — cocoa, pepper, and a long finish." },
    });
    // The public reader's view of an untitled entry: the cigar name heads the
    // page, and unlike the owner's view it must NOT link — the catalog is behind
    // auth, so a link there would be a dead end for an anonymous reader.
    const untitledPublicSave = await saveSmoke(deps, publicOwner, {
      clientRequestId: randomUUID(),
      cigar: { cigarId: hemingway },
      smokedAt: { value: "2026-08-22T17:00" },
      overallDescriptors: ["graham cracker", "toasted almond"],
      journal: { narrative: "A short story with no title of its own." },
    });

    // --- An agent run that overflows one page of rows (#173) ---------------
    // Written as raw audit rows rather than through the curation services: the
    // fixture only has to be READABLE, and 101 real curation writes would mutate
    // 101 catalog rows that every other admin spec then sees.
    //
    // Deliberately inert. `cigar.enrichment_request` is NOT in REVERSIBLE_ACTIONS,
    // so the run renders with no Undo buttons for a stray locator to hit, and no
    // enrichment_requests row is written — the "Queue enrichment" spec's counts are
    // untouched. `after` carries no cigarId, so `targetName` falls back to
    // `before.listingKey` and each row's visible label is its own index. created_at
    // is staggered a second apart so the newest→oldest order is deterministic:
    // e2e-row-1 is newest (first page), e2e-row-101 oldest (second page only).
    const overflowRunId = "wo-e2e-overflow-run";
    const OVERFLOW_ROWS = 101;
    await pool.query(
      `INSERT INTO audit_log (user_id, actor, action, before, after, run_id, confidence, created_at)
       SELECT $1, 'agent', 'cigar.enrichment_request',
              jsonb_build_object('listingKey', 'e2e-row-' || i),
              jsonb_build_object('reason', 'e2e overflow fixture'),
              $2, 1, now() - (i || ' seconds')::interval
       FROM generate_series(1, $3) AS i`,
      [adminId, overflowRunId, OVERFLOW_ROWS],
    );

    // --- Private journal (for the 404-parity spec) -------------------------
    const privateOwner = await insertUser(deps, "e2e-private@example.com", "private", "Private Owner");
    const privateSave = await saveSmoke(deps, privateOwner, {
      clientRequestId: randomUUID(),
      cigar: { cigarId: behike },
      smokedAt: { value: "2026-08-23T18:00" },
      journal: { title: "Hidden", narrative: "This entry is private and must 404 for anonymous readers." },
    });

    const handoff: Handoff = {
      baseURL: opts.baseURL,
      accounts: ACCOUNTS,
      invites: {
        open: openInvites,
        expired: expiredInvite.token,
        revoked: revokedInvite.token,
      },
      cigars: {
        searchable: { id: oliva, name: "Oliva Serie V Melanio Robusto", query: "Oliva Serie V Melanio" },
        detailWant: { id: behike, name: "Cohiba Behike 52" },
        smoked: { id: monte2, name: "Montecristo No. 2" },
        wanted: { id: hemingway, name: "Arturo Fuente Hemingway Short Story" },
        sampleNC: { id: padron64, name: "Padrón 1964 Anniversary Maduro" },
        heldPhotoless: { id: photoless, name: "Tatuaje Black Label Corona Gorda" },
        packaged: { id: packaged, name: "Warped Flor del Valle Sky Flower" },
        everyToggle: {
          id: monte2,
          name: "Montecristo No. 2",
          brandSlug: "montecristo",
          brandName: "Montecristo",
        },
      },
      duplicatePair: {
        survivor: { id: dupePlain, name: "Ramon Allones Especialmente Seleccionados" },
        duplicate: { id: dupeAccented, name: "Ramón Allones Especialmente Seleccionados" },
      },
      brand: "Padrón",
      taxonomy: {
        brand: { slug: "drew-estate", name: "Drew Estate" },
        line: { slug: "liga-privada", name: "Liga Privada" },
        blend: { slug: "no-9", name: "No. 9" },
        siblingBlend: { slug: "t52", name: "T52" },
        vitola: { slug: "toro", name: "Toro" },
        blender: "Willy Herrera",
        composed: {
          id: ligaNo9Toro,
          canonicalName: "Drew Estate Liga Privada No. 9 Toro",
          elidedInLine: "No. 9 · Toro",
        },
        untyped: {
          id: ligaNo9CoronaDoble,
          canonicalName: "Drew Estate Liga Privada No. 9 Corona Doble",
        },
        unfiled: { id: undercrown, canonicalName: "Drew Estate Undercrown Gordito" },
      },
      photoDrop: { token: photoDrop.token },
      publicSmoke: {
        id: publicSave.smoke.smokeId,
        cigarName: "Cohiba Siglo VI",
        narrativeSnippet: "calm evening with a Siglo VI",
      },
      privateSmokeId: privateSave.smoke.smokeId,
      untitledSmoke: {
        id: untitledSave.smoke.smokeId,
        cigarId: opusx,
        cigarName:
          "Fuente Fuente OpusX 20 Years Double Corona Cigar Family Charitable Foundation Event Exclusive",
      },
      untitledPublicSmoke: {
        id: untitledPublicSave.smoke.smokeId,
        cigarName: "Arturo Fuente Hemingway Short Story",
      },
      overflowRun: {
        runId: overflowRunId,
        rows: OVERFLOW_ROWS,
        newestRowLabel: "e2e-row-1",
        oldestRowLabel: `e2e-row-${OVERFLOW_ROWS}`,
      },
    };

    return { handoff, adminState, nonAdminState };
  } finally {
    await pool.end();
  }
}
