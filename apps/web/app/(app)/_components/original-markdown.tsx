import { Fragment } from "react";

// A deliberately minimal renderer for the archive's constrained review format
// (flow 006 originalMarkdown): `## ` headings and blank-line-separated
// paragraphs, with single newlines inside a paragraph as line breaks. Nothing
// else is interpreted — bold, lists, links, and raw HTML all fall through as
// literal paragraph text, and every value is a React text child (auto-escaped),
// so there is no HTML passthrough and no new dependency.

interface HeadingBlock {
  type: "heading";
  text: string;
}
interface ParagraphBlock {
  type: "paragraph";
  lines: string[];
}
export type MarkdownBlock = HeadingBlock | ParagraphBlock;

const HEADING = /^##\s+(.*)$/;

export function parseOriginalMarkdown(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[1]!.trim() });
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();

  return blocks;
}

export function OriginalMarkdown({ markdown }: { markdown: string }) {
  const blocks = parseOriginalMarkdown(markdown);
  return (
    <>
      {blocks.map((block, i) =>
        block.type === "heading" ? (
          <h3 key={i} className="font-display text-sm font-semibold text-ink">
            {block.text}
          </h3>
        ) : (
          <p key={i} className="font-serif text-[0.9375rem] leading-relaxed text-ink">
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {line}
              </Fragment>
            ))}
          </p>
        ),
      )}
    </>
  );
}
