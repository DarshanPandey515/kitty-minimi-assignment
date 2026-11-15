export type SearchResult = { title: string; url: string; snippet: string; published_at: string | null };

export const webSearchDecl = {
  name: "web_search",
  description: "Search the public web for current information. Returns up to 5 results with title, url, snippet, and published date.",
  parameters: {
    type: "OBJECT",
    properties: { query: { type: "STRING", description: "The search query." } },
    required: ["query"],
  },
};

/** Tavily wrapper. No LLM inside. Returns [] on any failure so the synthesizer can narrate the gap. */
export async function webSearch(query: string, opts: { max?: number } = {}): Promise<SearchResult[]> {
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY ?? ""}` },
      body: JSON.stringify({ query, search_depth: "basic", max_results: opts.max ?? 5, include_answer: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}`);
    const data = (await res.json()) as { results?: any[] };
    return (data.results ?? []).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.content ?? ""),
      published_at: r.published_date ?? null,
    }));
  } catch (err) {
    console.error("[webSearch]", (err as Error).message);
    return [];
  }
}
