import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OriginalMarkdown, parseOriginalMarkdown } from "./original-markdown";

describe("parseOriginalMarkdown", () => {
  it("turns a `## ` line into a heading, stripping the marker", () => {
    const blocks = parseOriginalMarkdown("## Review 1 - Toro - 10/14");
    expect(blocks).toEqual([{ type: "heading", text: "Review 1 - Toro - 10/14" }]);
  });

  it("splits blank-line-separated prose into paragraphs and keeps single newlines", () => {
    const blocks = parseOriginalMarkdown("First para.\nsecond line.\n\nSecond para.");
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["First para.", "second line."] },
      { type: "paragraph", lines: ["Second para."] },
    ]);
  });

  it("treats anything that is not a `## ` heading as plain paragraph text", () => {
    const blocks = parseOriginalMarkdown("### Deeper\n\n**bold** and - a dash");
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["### Deeper"] },
      { type: "paragraph", lines: ["**bold** and - a dash"] },
    ]);
  });
});

describe("OriginalMarkdown", () => {
  it("renders a `## ` heading as a styled h3 without the marker", () => {
    const html = renderToStaticMarkup(<OriginalMarkdown markdown="## Review 1 - Toro - 10/14" />);
    expect(html).toContain("<h3");
    expect(html).toContain("font-display");
    expect(html).toContain("Review 1 - Toro - 10/14");
    expect(html).not.toContain("## Review");
  });

  it("renders blank-line-separated prose as separate paragraphs", () => {
    const html = renderToStaticMarkup(
      <OriginalMarkdown markdown={"Peppery start.\n\nCreamier middle."} />,
    );
    expect(html.match(/<p/g)).toHaveLength(2);
    expect(html).toContain("Peppery start.");
    expect(html).toContain("Creamier middle.");
  });

  it("renders single newlines inside a paragraph as line breaks", () => {
    const html = renderToStaticMarkup(<OriginalMarkdown markdown={"Line one.\nLine two."} />);
    expect(html.match(/<p/g)).toHaveLength(1);
    expect(html).toContain("<br");
  });

  it("renders unknown markdown as a plain paragraph, not a heading", () => {
    const html = renderToStaticMarkup(<OriginalMarkdown markdown={"### Deep\n\n**bold**"} />);
    expect(html).not.toContain("<h3");
    expect(html).toContain("### Deep");
    expect(html).toContain("**bold**");
  });

  it("escapes HTML — no raw tag passthrough", () => {
    const html = renderToStaticMarkup(
      <OriginalMarkdown markdown={"Danger <script>alert(1)</script> here."} />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
