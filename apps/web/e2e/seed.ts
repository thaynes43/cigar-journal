import { randomUUID } from "node:crypto";
import { createDatabase, cigars, crawlRuns, purchases, users, vendors, type NewCigarRow } from "@cj/db";
import {
  claimInvite,
  createInvite,
  reserveInvite,
  revokeInvite,
  saveSmoke,
  setWant,
  type Deps,
  type Principal,
} from "@cj/domain";
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
  };
  // A deterministic near-duplicate pair for the admin console's merge/unmerge
  // round trip. Distinct from every other seeded name so the pair is the only one
  // the Duplicates section surfaces for these two rows.
  duplicatePair: { survivor: { id: string; name: string }; duplicate: { id: string; name: string } };
  brand: string;
  publicSmoke: { id: string; cigarName: string; narrativeSnippet: string };
  privateSmokeId: string;
  // Journal entries with no title, so the smoke-detail h1 falls back to the
  // cigar name (issue #49). Prod has none, so only the fixture exercises it.
  untitledSmoke: { id: string; cigarId: string; cigarName: string };
  untitledPublicSmoke: { id: string; cigarName: string };
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
  const { db, pool } = createDatabase(opts.databaseUrl);
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
      .values({ name: "E2E Cigars", focus: "NC", crawlEnabled: true, approvalStatus: "owner-added" })
      .returning({ id: vendors.id });
    await deps.db.insert(crawlRuns).values({
      vendorId: vendorRows[0]!.id,
      kind: "enrich",
      status: "succeeded",
      finishedAt: new Date(),
    });

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
      },
      duplicatePair: {
        survivor: { id: dupePlain, name: "Ramon Allones Especialmente Seleccionados" },
        duplicate: { id: dupeAccented, name: "Ramón Allones Especialmente Seleccionados" },
      },
      brand: "Padrón",
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
    };

    return { handoff, adminState, nonAdminState };
  } finally {
    await pool.end();
  }
}
