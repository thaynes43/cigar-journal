import type { ComponentProps, ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";

// Renders a smoke's imported `originalMarkdown` (flow 006) — the archive's
// free-form review prose — as sanitized rich text. This surface is served to
// ANONYMOUS readers (public journal, issue #96/#97) and must be stored-XSS-safe
// (issue #46), because agents are the primary journal writers and future
// originals are untrusted input.
//
// Dependency: react-markdown@10 (pinned), CommonMark only, no plugins. Chosen as
// the smallest footprint that is XSS-safe *by construction*: it renders to React
// elements — never an HTML string — so there is no `dangerouslySetInnerHTML`
// vector at all. Raw HTML in the source is passed through as escaped text (a
// `<script>` renders as literal `&lt;script&gt;`, never executes) since we add
// no `rehype-raw`; URLs run through `urlTransform` (below), stripping
// `javascript:`/`data:`/etc.; and `allowedElements` is a hard whitelist. A
// parser + separate string sanitizer (marked + sanitize-html/DOMPurify) was
// rejected: it reintroduces the innerHTML surface and a second, mis-configurable
// dependency for a weaker posture.
//
// Scope decisions:
// - No raw HTML passthrough (no rehype-raw). The archive is authored markdown.
// - No images. The 34 archived review bodies carry none, and same-origin photos
//   already render via SmokePhotoStrip; `img` is omitted from `allowedElements`
//   so any stray `![]()` is dropped rather than opening an `img src` surface.
// - CommonMark only, no remark-gfm. The archived review corpus uses ATX headings
//   (`#`/`##`) and prose exclusively — no GFM tables/strikethrough/task-lists —
//   so GFM would be footprint for content that does not exist. Emphasis, links,
//   lists, blockquotes, and code (all CommonMark) are supported for future
//   agent-authored originals; sanitization posture is unaffected by the choice.
// Styling reuses the `prose-ledger` reading treatment (globals.css) and semantic
// color tokens only (DESIGN-001 token contract).

// Protocol allowlist for link hrefs. Relative URLs (no scheme) pass; only
// http/https/mailto/tel schemes are kept — everything else (javascript:, data:,
// vbscript:, file:, …) is neutralized to an empty href. Defense-in-depth over
// react-markdown's own default url transform.
function safeHref(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return url; // relative → safe
  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();
  return ["http", "https", "mailto", "tel"].includes(scheme) ? url : "";
}

// The rendered element whitelist. `img`, `table`, `input`, and any raw-HTML tag
// are intentionally absent.
const ALLOWED_ELEMENTS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "strong",
  "em",
  "del",
  "a",
  "code",
  "pre",
  "hr",
  "br",
] as const;

// Per-element styling. Headings collapse to h3/h4 so the block keeps a sane
// outline beneath the section's "Original" h2 label; the h3 style matches the
// prior renderer's review-heading treatment. Colors are semantic tokens only.
const heading = (children: ReactNode) => (
  <h3 className="font-display text-sm font-semibold text-ink">{children}</h3>
);
const subheading = (children: ReactNode) => (
  <h4 className="font-display text-xs font-semibold tracking-wide text-muted uppercase">
    {children}
  </h4>
);

const components: Components = {
  h1: ({ children }) => heading(children),
  h2: ({ children }) => heading(children),
  h3: ({ children }) => heading(children),
  h4: ({ children }) => subheading(children),
  h5: ({ children }) => subheading(children),
  h6: ({ children }) => subheading(children),
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/50 pl-4 text-ink italic">{children}</blockquote>
  ),
  a: ({ href, children }) =>
    // A stripped/dangerous href resolves to "" here → render inert text, never a
    // dead anchor. Safe links open in a new tab with noopener.
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline underline-offset-4"
      >
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  code: ({ children, className }: ComponentProps<"code">) => (
    <code className={`font-mono text-[0.9em] ${className ?? ""}`}>{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-field border border-line bg-surface p-3 font-mono text-[0.85em]">
      {children}
    </pre>
  ),
};

export function OriginalMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="prose-ledger flex flex-col gap-3 text-ink">
      <Markdown
        allowedElements={[...ALLOWED_ELEMENTS]}
        unwrapDisallowed
        skipHtml={false}
        urlTransform={safeHref}
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
