import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The journal root had no <h1> at all (#219, filed from the #218 sweep): the
// wordmark that links here is chrome on every page, so the document that IS the
// journal carried no top-level heading. Every other route names itself.

vi.mock("@/lib/require-auth", () => ({
  requireAuth: async () => ({ userId: "u-1", role: "user" }),
}));

// The list is a client component reading through the tRPC provider; the heading
// is the page's own, so the list stands in as a marker.
vi.mock("./_components/journal-list", () => ({
  JournalList: () => <div data-testid="journal-list" />,
}));

const { default: JournalPage } = await import("./page");

describe("the signed-in journal root", () => {
  it("names itself in an h1, above the list", async () => {
    const html = renderToStaticMarkup(await JournalPage());
    expect(html).toMatch(/<h1[^>]*>Journal<\/h1>/);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("journal-list"));
  });
});
