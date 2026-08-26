# Documentation

Docs-first, as in the sibling repos (haynesnetwork, todos-for-dues): PRD →
ADR → DDD flow → code. Documents get stable 3-digit IDs (`001-slug.md`),
starting from the `000-template.md` in each directory.

- [`prd/`](prd/) — product requirements documents.
- [`adr/`](adr/) — architecture decision records (MADR-style). Immutable once
  accepted; supersede rather than edit.
- [`ddd/`](ddd/) — ubiquitous language, bounded contexts, aggregates.
- [`flows/`](flows/) — cross-boundary workflows with sequence diagrams.
- [`mcp/`](mcp/) — the MCP tool contract (schemas, errors, examples).
- [`security-and-observability.md`](security-and-observability.md) — threat
  model and diagnosability requirements.

Start with [PRD-001](prd/001-conversational-cigar-journal.md); ADRs 001–006
record the load-bearing decisions.

Keep documents short: state the requirement or decision and its rationale, not
a narrative.
