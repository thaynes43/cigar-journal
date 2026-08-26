# Flow: Name

- **Trigger:** the command or event that starts this flow, and its actor
  (user, agent via MCP, scheduled job).

## Sequence

Numbered steps: actor → command → aggregate → domain event(s) → reactions.

## Aggregates and invariants

Which aggregates are touched and the rules they enforce.

## Failure modes

What can reject or fail mid-flow, and what the caller sees.
