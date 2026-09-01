import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The public journal index rendered no <h1> at all (#219, filed from the #218
// sweep): the page delegates entirely to this list. The heading belongs to the
// populated arm only — an empty public journal still renders nothing (#96).

const useInfiniteQuery = vi.fn();
vi.mock("@/lib/trpc/react", () => ({
  api: { smokes: { listPublic: { useInfiniteQuery: () => useInfiniteQuery() } } },
}));

const { PublicJournalList } = await import("./public-journal-list");

const smoke = {
  smokeId: "s-1",
  smokedAt: "2026-01-02T03:04:05.000Z",
  rating: 91,
  liked: true,
  summary: "Cocoa and cedar.",
  descriptors: ["cocoa"],
  cigar: { canonicalName: "Padrón 1926 No. 9" },
};

const render = (smokes: unknown[]) => {
  useInfiniteQuery.mockReturnValue({
    data: { pages: [{ smokes, nextCursor: null }] },
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
  return renderToStaticMarkup(<PublicJournalList />);
};

describe("the public journal index", () => {
  it("names itself in an h1 above the entries", () => {
    const html = render([smoke]);
    expect(html).toMatch(/<h1[^>]*>Journal<\/h1>/);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("Padrón"));
  });

  it("renders nothing at all when the journal has no visible smokes", () => {
    expect(render([])).toBe("");
  });
});
