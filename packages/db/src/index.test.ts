import { describe, it, expect } from "vitest";
import { db } from "./index.js";

// Guards the lazy-client contract: importing @cj/db must not connect, so the
// client is usable without DATABASE_URL until a query touches it.
describe("@cj/db lazy client", () => {
  it("imports without connecting", () => {
    expect(db).toBeDefined();
  });
});
