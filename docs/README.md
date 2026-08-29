# Documentation

Docs-first, as in the sibling repos (haynesnetwork, todos-for-dues): PRD →
ADR → DDD flow → code. Documents get stable 3-digit IDs (`001-slug.md`),
starting from the `000-template.md` in each directory. The shipped product —
journal, unified catalog with the humidor overlay, want and favorites, prices,
public journal pages, and the 17-tool MCP server — is the sum of these.

- [`prd/`](prd/) — product requirements documents (through the unified catalog
  and want, PRD-003).
- [`adr/`](adr/) — architecture decision records (MADR-style). Immutable once
  accepted; supersede rather than edit.
- [`design/`](design/) — cross-cutting UX/research design docs (the go-live
  experience, DESIGN-002).
- [`ddd/`](ddd/) — ubiquitous language, bounded contexts, aggregates.
- [`flows/`](flows/) — cross-boundary workflows with sequence diagrams.
- [`mcp/`](mcp/) — the MCP tool contract (schemas, errors, examples) and the
  LLM client-compatibility matrix.
- [`security-and-observability.md`](security-and-observability.md) — threat
  model and diagnosability requirements.

Start with [PRD-001](prd/001-conversational-cigar-journal.md); the accepted
ADRs record the load-bearing decisions.

Keep documents short: state the requirement or decision and its rationale, not
a narrative.
