import Link from "next/link";

// The record action as an icon-only accent chip (DESIGN-002 nav): a compact ~36px
// square that shows no text at any width, so the authenticated header fits a
// 360–390pt phone in a single non-wrapping row. The glyph is Feather's "edit-3"
// pencil (MIT). The name rides aria-label + title for assistive tech and hover —
// the accent fill is the affordance. Hover opacity matches ui.primary.
export function RecordSmokeButton() {
  return (
    <Link
      href="/smokes/new"
      aria-label="Record a smoke"
      title="Record a smoke"
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-field bg-accent text-accent-ink transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="size-[18px]"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </Link>
  );
}
