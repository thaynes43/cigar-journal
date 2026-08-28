import { describe, it, expect } from "vitest";
import { parseRobots } from "./robots.js";
import { CRAWLER_UA_TOKEN } from "./fetcher.js";
import { loadFixture } from "../testing/fixtures.js";

const ROBOTS = loadFixture("robots.txt");

describe("parseRobots", () => {
  it("puts our UA under the `*` group: shop allowed, wp-admin denied, admin-ajax re-allowed", () => {
    const robots = parseRobots(ROBOTS, CRAWLER_UA_TOKEN);
    expect(robots.matchedAgent).toBe("*");
    expect(robots.isAllowed("/shop/padron-1964-anniversary-maduro-torpedo/")).toBe(true);
    expect(robots.isAllowed("/wp-admin/")).toBe(false);
    // Longest-match precedence: the specific Allow beats the shorter Disallow.
    expect(robots.isAllowed("/wp-admin/admin-ajax.php")).toBe(true);
  });

  it("honors a named AI-training bot ban (ClaudeBot → Disallow: /)", () => {
    const robots = parseRobots(ROBOTS, "ClaudeBot");
    expect(robots.matchedAgent).toBe("claudebot");
    expect(robots.isAllowed("/shop/padron-1964-anniversary-maduro-torpedo/")).toBe(false);
    expect(robots.isAllowed("/")).toBe(false);
  });

  it("bans GPTBot and CCBot the same way, matched case-insensitively", () => {
    expect(parseRobots(ROBOTS, "gptbot").isAllowed("/shop/x/")).toBe(false);
    expect(parseRobots(ROBOTS, "CCBot").isAllowed("/shop/x/")).toBe(false);
  });

  it("defaults to allowed when no rule matches (empty robots)", () => {
    const robots = parseRobots("", CRAWLER_UA_TOKEN);
    expect(robots.isAllowed("/shop/anything/")).toBe(true);
  });

  it("an empty Disallow value forbids nothing", () => {
    const robots = parseRobots("User-agent: *\nDisallow:\n", CRAWLER_UA_TOKEN);
    expect(robots.isAllowed("/wp-admin/")).toBe(true);
  });
});
