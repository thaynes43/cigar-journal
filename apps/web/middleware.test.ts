import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { config, middleware } from "./middleware";

// The edge gate's matcher decides which paths the optimistic redirect can touch
// at all. Getting it wrong is silent: an excluded prefix that is not excluded
// simply bounces to /signin, and nothing else fails. Two of the exclusions carry
// the whole feature behind them — /u/<token> (photo uploads) and /invite/<token>
// (invite redemption), whose audiences have no session cookie by definition.

const matcher = new RegExp(`^${config.matcher[0]!}$`);

describe("middleware matcher", () => {
  it("lets the token surfaces through without a session", () => {
    expect(matcher.test("/invite/abc123")).toBe(false);
    expect(matcher.test("/u/abc123")).toBe(false);
    expect(matcher.test("/api/auth/callback/authentik")).toBe(false);
    expect(matcher.test("/api/trpc/invites.create")).toBe(false);
  });

  // Every image route authorizes itself on a server-derived Principal and
  // answers 401 when there is none. An edge redirect in front of them turns that
  // 401 into a 307 to an HTML page: a bearer-token client (no session cookie)
  // never reaches the route at all, and any surface rendering catalog art gets
  // blank <img>s instead of a real status.
  it("lets every image route reach its own principal check", () => {
    expect(matcher.test("/api/photos/abc123")).toBe(false);
    expect(matcher.test("/api/photos/abc123/thumb")).toBe(false);
    expect(matcher.test("/api/product-photos/abc123")).toBe(false);
    expect(matcher.test("/api/product-photos/abc123/thumb")).toBe(false);
    expect(matcher.test("/api/brand-images/padron")).toBe(false);
    expect(matcher.test("/api/brand-images/padron/thumb")).toBe(false);
  });

  it("still gates the authed app surfaces", () => {
    expect(matcher.test("/cigars")).toBe(true);
    expect(matcher.test("/settings")).toBe(true);
    expect(matcher.test("/signin")).toBe(true); // matched, then let through by the handler
  });
});

// Where the handler — not the matcher — decides. These paths ARE matched, and
// the gate has to recognize them or they bounce to /signin.
const anonymous = (path: string) => middleware(new NextRequest(new URL(`http://localhost${path}`)));
const passes = (path: string) => anonymous(path).headers.get("location") === null;

describe("middleware gate, anonymous", () => {
  it("serves the brand marks a browser fetches before sign-in", () => {
    // Both answered 307 /signin on prod until 2026-09-21, so the tab carried no
    // mark for anyone who was not signed in.
    expect(passes("/icon.svg")).toBe(true);
    expect(passes("/apple-icon.png")).toBe(true);
  });

  it("serves every share card to an unfurler that has no cookie", () => {
    expect(passes("/opengraph-image")).toBe(true);
    expect(passes("/smokes/abc/opengraph-image-1qnk2j")).toBe(true);
    // Under a gated surface: the route itself falls back to the default card
    // when its authed read is refused, so it must be reached to answer at all.
    expect(passes("/cigars/abc/opengraph-image-1bboer")).toBe(true);
  });

  it("still bounces the surfaces those cards belong to", () => {
    expect(passes("/cigars/abc")).toBe(false);
    expect(passes("/opengraph-image/../cigars")).toBe(false);
  });
});
