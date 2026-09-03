import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicSmokeView } from "@cj/domain";
import { PublicSmokeDetail } from "./public-smoke-detail";

// Stored-XSS safety for the public reader (issue #96, security-and-observability
// §"Stored XSS in journal prose"): a public journal's prose and its imported
// original markdown are attacker-influenced text (the archive backfill carries raw
// markdown). Everything must render as escaped text — no raw HTML from any field.
// A hostile fixture drives every prose surface the public detail exposes.
const hostile: PublicSmokeView = {
  smokeId: "00000000-0000-0000-0000-000000000001",
  cigar: { canonicalName: "<script>alert('cigar')</script>" },
  smokedAt: { value: "2026-06-01T12:00:00.000Z", source: "user", precision: "minute" },
  startedAt: null,
  endedAt: null,
  durationMinutes: null,
  journal: {
    title: "<script>alert('title')</script>",
    narrative: "Lovely <script>alert('narrative')</script> draw.",
  },
  overallDescriptors: ["<img src=x onerror=alert('descriptor')>"],
  progression: [],
  construction: {
    draw: null,
    burn: null,
    smokeOutput: null,
    notes: "<script>alert('notes')</script>",
  },
  assessment: {
    strength: "<script>alert('strength')</script>",
    body: "<script>alert('body')</script>",
    liked: true,
    rating: 92,
    impression: "Verdict: <script>alert('impression')</script>.",
  },
  pairing: ["<script>alert('pairing')</script>"],
  originalMarkdown:
    "## Heading\n\nDanger <script>alert('markdown')</script> here.\n\n" +
    "[clickme](javascript:alert('href')) and ![x](https://blocked.example/x.png)",
  photos: [],
};

describe("PublicSmokeDetail", () => {
  it("escapes every prose and markdown field — no raw tag passthrough", () => {
    const html = renderToStaticMarkup(<PublicSmokeDetail smoke={hostile} />);
    // No raw markup from any field reaches the document — the descriptor's <img>
    // and every <script> survive only as escaped text, so they cannot execute.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    // The imported markdown's hostile payload is escaped (covered above), while its
    // `## ` heading still renders as a heading and its prose survives as text — the
    // renderer interprets structure, not HTML.
    expect(html).toContain("<h3");
    expect(html).toContain("Danger");
    // The imported markdown's link is sanitized (javascript: href stripped → inert
    // text) and its image dropped, so neither reaches the anonymous reader.
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("blocked.example");
    expect(html).toContain("clickme");
  });
});
