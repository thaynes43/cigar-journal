// Server identity, scope map, and the verbatim server instructions the tool
// contract mandates. These are the client-facing surface: the six tool names,
// the scopes each demands, and the instruction text every client receives at
// initialize (docs/mcp/tool-contract.md).

export const SERVER_INFO = { name: "cigar-journal", version: "0.1.0" } as const;

// The six tools, exactly per the contract. Reads are annotated readOnlyHint.
export const TOOL_NAMES = [
  "search_cigars",
  "get_cigar",
  "get_my_smokes",
  "get_smoke",
  "save_smoke",
  "update_smoke",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

// Scope required to INVOKE each tool (tool-contract "Scopes" section). Response
// scope-bounding (personal fields on catalog tools) is a separate, additive
// check against journal:read inside the read handlers.
export const TOOL_SCOPES: Record<ToolName, string[]> = {
  search_cigars: ["catalog:read"],
  get_cigar: ["catalog:read"],
  get_my_smokes: ["journal:read"],
  get_smoke: ["journal:read"],
  save_smoke: ["journal:write"],
  update_smoke: ["journal:write"],
};

// Personal fields on catalog tools require this additional scope.
export const PERSONAL_SCOPE = "journal:read";

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// Verbatim from docs/mcp/tool-contract.md "Server instructions" block. Reproduced
// exactly (including line breaks) — this is guidance the model reads, not code.
export const INSTRUCTIONS = `This server manages the authenticated user's personal cigar journal.
During an active smoking conversation, converse naturally; do not save
observations as they happen. Use search_cigars/get_cigar when identification
or factual cigar information helps; use get_my_smokes/get_smoke when prior
experiences would improve comparison. When the user clearly indicates the
cigar is finished, synthesize the conversation into one save_smoke call.
Preserve uncertainty: omit ratings, vitolas, times, pairings, blend details,
or tasting stages that were never established — sparse is correct. Reuse the
same clientRequestId when retrying a mutation. The server identifies the
user from the authorization context; never supply or infer a user id.`;
