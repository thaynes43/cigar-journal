import { describe, it, expect } from "vitest";
import { config } from "./middleware";

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

  it("still gates the authed app surfaces", () => {
    expect(matcher.test("/cigars")).toBe(true);
    expect(matcher.test("/settings")).toBe(true);
    expect(matcher.test("/signin")).toBe(true); // matched, then let through by the handler
  });
});
