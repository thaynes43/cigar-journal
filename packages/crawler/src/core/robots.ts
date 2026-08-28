// A tiny robots.txt parser scoped to what the crawler needs: pick the rule group
// for our product token (exact case-insensitive match, else the `*` group,
// combining every group that matches per RFC 9309), then answer isAllowed(path)
// by longest-match precedence (Allow wins ties; no matching rule → allowed).
//
// The Fox probe shows the shapes we must honor: a `*` group with `Allow: /` plus
// a second `*` group disallowing only /wp-admin/, and named AI-training bots
// (ClaudeBot, GPTBot, CCBot, …) each disallowed `/`. Our token is not among the
// banned bots, so we fall under `*`. Content-Signal / Crawl-delay / Sitemap
// lines are ignored for allow/deny.

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

export interface Robots {
  // The user-agent group actually applied ("*" or the matched token), for audit.
  matchedAgent: string;
  rules: Rule[];
  isAllowed(path: string): boolean;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A robots path pattern → matcher. `*` is a wildcard, a trailing `$` anchors the
// end; an empty pattern (e.g. `Disallow:`) matches nothing.
function ruleMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = "^" + body.split("*").map(escapeRegex).join(".*") + (anchored ? "$" : "");
  return new RegExp(source).test(path);
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  // True right after a user-agent line: consecutive user-agent lines extend the
  // same group; the first rule line closes the agent list, so the next
  // user-agent line opens a fresh group.
  let expectingAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !expectingAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      expectingAgent = true;
    } else if (field === "allow" || field === "disallow") {
      if (!current) continue; // a rule before any user-agent is ignored
      current.rules.push({ allow: field === "allow", pattern: value });
      expectingAgent = false;
    }
    // Every other directive (sitemap, crawl-delay, content-signal, host) is
    // irrelevant to allow/deny and skipped.
  }
  return groups;
}

export function parseRobots(text: string, userAgentToken: string): Robots {
  const token = userAgentToken.toLowerCase();
  const groups = parseGroups(text);

  const exact = groups.filter((g) => g.agents.includes(token));
  const selected = exact.length > 0 ? exact : groups.filter((g) => g.agents.includes("*"));
  const matchedAgent = exact.length > 0 ? token : "*";
  const rules = selected.flatMap((g) => g.rules);

  return {
    matchedAgent,
    rules,
    isAllowed(path: string): boolean {
      let best: { allow: boolean; length: number } | null = null;
      for (const rule of rules) {
        if (!ruleMatches(rule.pattern, path)) continue;
        const length = rule.pattern.length;
        if (
          !best ||
          length > best.length ||
          // Longest-match wins; an Allow of equal length beats a Disallow.
          (length === best.length && rule.allow && !best.allow)
        ) {
          best = { allow: rule.allow, length };
        }
      }
      return best ? best.allow : true;
    },
  };
}
