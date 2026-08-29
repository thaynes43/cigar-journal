import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OriginalMarkdown } from "./original-markdown";

const render = (markdown: string) => renderToStaticMarkup(<OriginalMarkdown markdown={markdown} />);

// Archive fidelity: the 34 legacy review bodies use ATX headings (`#`/`##`) and
// blank-line-separated prose; emphasis/links/lists/quotes/code are supported for
// future agent-authored originals. Every construct below must render, and every
// XSS vector below must be neutralized (issues #46, #96, #97).
describe("OriginalMarkdown — archive constructs", () => {
  it("renders a `## Review …` line as a styled heading, marker stripped", () => {
    const html = render("## Review 1 - Toro - 10/14/2025");
    expect(html).toContain("<h3");
    expect(html).toContain("font-display");
    expect(html).toContain("Review 1 - Toro - 10/14/2025");
    expect(html).not.toContain("## Review");
  });

  it("does not leak raw h1/h2 tags for `#`/`##` headings (outline stays under the section)", () => {
    const html = render("# 1926 Maduro\n\n## Review 1 - ?? - 9/18");
    expect(html).not.toMatch(/<h1[ >]/);
    expect(html).not.toMatch(/<h2[ >]/);
    expect(html).toContain("1926 Maduro");
  });

  it("splits blank-line-separated prose into paragraphs", () => {
    const html = render("Peppery start.\n\nCreamier middle.");
    expect(html.match(/<p[ >]/g)).toHaveLength(2);
    expect(html).toContain("Peppery start.");
    expect(html).toContain("Creamier middle.");
  });

  it("renders emphasis", () => {
    const html = render("Some **bold** and _italic_ notes.");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });

  it("renders unordered and ordered lists", () => {
    const html = render("- one\n- two\n\n1. first\n2. second");
    expect(html).toContain("list-disc");
    expect(html).toContain("list-decimal");
    expect(html.match(/<li>/g)).toHaveLength(4);
  });

  it("renders a blockquote and inline code", () => {
    const html = render("> a quoted aside\n\nuse `62% bovedas` here");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<code");
    expect(html).toContain("62% bovedas");
  });

  it("renders a safe link with noopener + new tab", () => {
    const html = render("See [the notes](https://example.test/notes).");
    expect(html).toContain('href="https://example.test/notes"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});

describe("OriginalMarkdown — XSS vectors neutralized", () => {
  it("escapes raw <script> — no executable tag passthrough", () => {
    const html = render("Danger <script>alert(1)</script> here.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops raw HTML with event handlers (no onerror/img element)", () => {
    const html = render('X <img src=x onerror="alert(1)"> Y');
    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/<[^>]+onerror=/); // no element carries the handler
  });

  it("neutralizes a javascript: link (rendered inert, no anchor)", () => {
    const html = render("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a");
    expect(html).toContain("click me"); // text preserved
  });

  it("neutralizes a data: link", () => {
    const html = render("[x](data:text/html,<script>alert(1)</script>)");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("data:text/html");
  });

  it("drops images entirely — no img element, not even same-origin markdown images", () => {
    const html = render("![alt](https://evil.example/x.png)\n\n![local](/photos/a.jpg)");
    expect(html).not.toMatch(/<img/);
    expect(html).not.toContain("evil.example");
  });

  it("drops a data: URI image (whitelist removes the img node and its url)", () => {
    const html = render("![x](data:image/png;base64,AAAAAA)");
    expect(html).not.toMatch(/<img/);
    expect(html).not.toContain("data:image");
  });
});
