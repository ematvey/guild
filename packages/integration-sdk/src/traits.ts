// Trait tools are Guild-provided: one canonical name, description, and
// argument schema per capability, independent of the integration that
// implements it. The model sees "web search", not a vendor's search.

export interface TraitSpec {
  name: string;
  description: string;
  parameters: unknown;
}

const TRAITS: Record<string, TraitSpec> = {
  web_search: {
    name: "web_search",
    description:
      "Search the public web and return the top results (title, url, snippet). " +
      "Use it for facts outside the workspace, current events, and finding a page " +
      "to read with web_fetch.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "1-10 results, default 5" },
      },
      required: ["query"],
    },
  },
  web_fetch: {
    name: "web_fetch",
    description:
      "Fetch one web page and return its readable content (title, description, " +
      "main text). Use it after web_search to read a result in full.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL" },
        max_chars: { type: "number", description: "Max characters of content, default 8000" },
      },
      required: ["url"],
    },
  },
};

export function traitSpec(trait: string): TraitSpec | undefined {
  return TRAITS[trait];
}

export function traitNames(): string[] {
  return Object.keys(TRAITS);
}
