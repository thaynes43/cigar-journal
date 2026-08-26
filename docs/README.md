# Documentation

Docs-first, as in the sibling repos (haynesnetwork, todos-for-dues): PRD →
ADR → DDD flow → code. Documents get stable 3-digit IDs (`001-slug.md`),
starting from the `000-template.md` in each directory.

- [`prd/`](prd/) — product requirements documents.
- [`adr/`](adr/) — architecture decision records (MADR-style). Immutable once
  accepted; supersede rather than edit.
- [`flows/`](flows/) — domain-driven design flows: commands, domain events,
  aggregates, and policies per workflow.

Keep documents short: state the requirement or decision and its rationale, not
a narrative.
