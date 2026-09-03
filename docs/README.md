# Documentation

Docs-first, as in the sibling repos (haynesnetwork, todos-for-dues): PRD →
ADR → DDD flow → code. Documents get stable 3-digit IDs (`001-slug.md`),
starting from the `000-template.md` in each directory. The launched product —
the public journal, the unified catalog with its brand/line/blend/vitola
hierarchy and humidor overlay, want and favorites, prices, and the MCP server —
is the sum of these.

- [`prd/`](prd/) — product requirements documents (through the unified catalog
  and want, PRD-003).
- [`adr/`](adr/) — architecture decision records (MADR-style). Immutable once
  accepted; supersede rather than edit.
- [`design/`](design/) — cross-cutting UX/research design docs, through the
  critic and journal score surfaces (DESIGN-006).
- [`ddd/`](ddd/) — ubiquitous language, bounded contexts, aggregates, and the
  [cigar industry vocabulary](ddd/cigar-industry-vocabulary.md) that binds
  enrichment, curation, and UI copy.
- [`flows/`](flows/) — cross-boundary workflows with sequence diagrams.
- [`mcp/`](mcp/) — the MCP tool contract (schemas, errors, examples), the
  LLM client-compatibility matrix, and the
  [service-token operator runbook](mcp/service-tokens.md) (mint, rotate,
  revoke).
- [`security-and-observability.md`](security-and-observability.md) — threat
  model and diagnosability requirements.

Start with [PRD-001](prd/001-conversational-cigar-journal.md); the accepted
ADRs record the load-bearing decisions.

Keep documents short: state the requirement or decision and its rationale, not
a narrative.
