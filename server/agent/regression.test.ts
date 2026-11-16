import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

type Turn = { id: string; session_id: string; role: "user" | "assistant"; ts: string; text: string; entities_json: string };
type Point = { id: string; vector: number[]; payload: Record<string, unknown> };
const corpus = JSON.parse(readFileSync(new URL("../../tests/fixtures/agent-regression.json", import.meta.url), "utf8"));
const temp = mkdtempSync(join(tmpdir(), "kitty-agent-regression-"));
process.env.DB_PATH = join(temp, "isolated.db");
process.env.QDRANT_URL = "http://qdrant.fixture";

const points = new Map<string, Point>();
const qdrantAudits: { requestedSession: string | null; unfilteredTopIds: string[]; filteredTopIds: string[] }[] = [];
const synonyms: Record<string, string> = {
  notebook: "laptop", module: "ram", dimm: "ram", memory: "ram", actually: "corrected", correction: "corrected",
  paid: "price", purchased: "price", size: "dimension", dimensions: "dimension", folder: "folder", keyboard: "keyboard",
};
function vectorize(text: string): number[] {
  const vector = Array<number>(384).fill(0);
  for (const raw of text.toLowerCase().match(/[a-z0-9$]+/g) ?? []) {
    const word = synonyms[raw] ?? raw;
    let hash = 2166136261;
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    vector[(hash >>> 0) % vector.length] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}
function answerFromEvidence(item: any, results: any[], system: string): string {
  const cite = (result: any) => `[${result.title}](${result.url}), ${result.published_at ?? "undated"}`;
  const snippet = (result: any) => String(result.snippet ?? result.content ?? "");
  if (!results.length) return "I couldn't verify a current price because the search returned no sources.";
  const cited = results.map(cite).join("; ");
  if (item.id === "postgres-pricing-new-thread") {
    const historical = system.includes("$5–$9/month") && system.includes("$15–$30/month");
    if (!historical) return `The current source says ${results.map(snippet).join(" ")} Historical pricing isn't available in context, so I can't confirm a change. ${cited}.`;
    const heroku = results.find((result) => result.title.includes("Heroku"));
    const neon = results.find((result) => result.title.includes("Neon"));
    const herokuPrice = Number(snippet(heroku).match(/\$(\d+(?:\.\d+)?)/)?.[1]);
    const herokuStatus = heroku && herokuPrice >= 5 && herokuPrice <= 9 ? "unchanged within the historical $5 to $9/month range" : "outside the historical entry-level range; a change needs confirmation";
    return `Historically, the previous answer said entry-level paid tiers were $5 to $9/month (Heroku and Railway; Hostmath, undated), and small production workloads were $15 to $30/month (DigitalOcean, Render, Supabase; Hostmath and Bytebase, undated). Current snapshot: ${snippet(heroku) || "No Heroku source was found."} ${heroku ? `Heroku is ${herokuStatus}.` : "Heroku pricing is unverified."} ${snippet(neon) || "No Neon source was found."} Neon is not directly comparable to the historical aggregate plan, so its change is unverified. No confirmed price changes appear in these snapshots; current pricing for Railway, Supabase, Render, and DigitalOcean is unverified. ${cited}.`;
  }
  if (item.evidenceMode === "contradictory") {
    const prices = results.map((result) => snippet(result).match(/\$\d+(?:\.\d+)?/)?.[0]).filter(Boolean);
    if (new Set(prices).size > 1) return `The sources conflict: ${prices.join(" versus ")}. The current price is unverified. ${cited}.`;
    return `The sources agree on ${prices[0] ?? "no price"}; the snapshot does not show a conflict. ${cited}.`;
  }
  if (item.evidenceMode === "stale") {
    const result = results[0];
    const published = Date.parse(result.published_at ?? "");
    const asOf = Date.parse(corpus.asOf);
    if (Number.isFinite(published) && asOf - published > 365 * 864e5) return `The only price evidence is stale: ${snippet(result)} The current price and any change are unverified. ${cite(result)}.`;
    return `The source is dated ${result.published_at ?? "undated"} and does not meet the stale-source condition. ${snippet(result)} ${cite(result)}.`;
  }
  if (item.evidenceMode === "unsupported_change") {
    const historic = /historical[^\n]*\$\d/i.test(system);
    return `The current snapshot says ${snippet(results[0])} ${historic ? "This can be compared with the historical price." : "I can't confirm a change because there is no earlier comparable price in context."} ${cited}.`;
  }
  const result = results[0];
  if (item.intent === "temporal_delta") {
    const historic = system.match(/Historical price: (\$\d+(?:\.\d+)?)/i)?.[1];
    const current = snippet(result).match(/\$\d+(?:\.\d+)?/)?.[0];
    if (historic && current && historic !== current) return `The price changed from ${historic} to ${current}. ${snippet(result)} ${cite(result)}.`;
    return `The current price is ${snippet(result)}; a change is unverified without a comparable earlier price. ${cite(result)}.`;
  }
  return `Current evidence: ${snippet(result)} ${cite(result)}.`;
}

class FixtureQdrantClient {
  constructor(_options: unknown) {}
  async getCollections() { return { collections: [{ name: "kitty_turns_minilm384" }] }; }
  async createCollection() { return true; }
  async createPayloadIndex() { return true; }
  async upsert(_collection: string, args: { points: Point[] }) {
    for (const point of args.points) points.set(String(point.id), point);
    return { status: "completed" };
  }
  async query(_collection: string, args: { query: number[]; limit: number; filter: any }) {
    const allowed = (point: Point) => {
      const must = args.filter?.must ?? [];
      if (must.some((filter: any) => filter.key === "session_id" && point.payload.session_id !== filter.match.value)) return false;
      if (must.some((filter: any) => filter.key === "ts_ms" && (Number(point.payload.ts_ms) < filter.range.gte || Number(point.payload.ts_ms) > filter.range.lte))) return false;
      const excluded = args.filter?.must_not?.flatMap((filter: any) => filter.has_id ?? []) ?? [];
      return !excluded.includes(point.id);
    };
    const rank = (point: Point) => ({
      id: point.id,
      score: point.vector.reduce((sum, value, i) => sum + value * args.query[i], 0),
    });
    const allRanked = [...points.values()].map(rank).sort((a, b) => b.score - a.score);
    const filteredRanked = [...points.values()].filter(allowed).map(rank).sort((a, b) => b.score - a.score);
    qdrantAudits.push({
      requestedSession: args.filter?.must?.find((filter: any) => filter.key === "session_id")?.match?.value ?? null,
      unfilteredTopIds: allRanked.slice(0, args.limit).map((point) => point.id),
      filteredTopIds: filteredRanked.slice(0, args.limit).map((point) => point.id),
    });
    return { points: filteredRanked.slice(0, args.limit) };
  }
  async delete(_collection: string, args: any) {
    for (const [id, point] of points) if (point.payload.session_id === args.filter.must[0].match.value) points.delete(id);
    return { status: "completed" };
  }
}

const aiCalls: any[] = [];
let failRouter = false;
let extractionMode: "normal" | "delayed" | "fail" = "normal";
let onHistoricalExtractionStarted: (() => void) | undefined;
let releaseHistoricalExtraction: (() => void) | undefined;
const ai = {
  models: {
    async generateContent(args: any) {
      aiCalls.push(args);
      const prompt = String(args.config?.systemInstruction ?? "");
      if (prompt.includes("You classify the user's next turn")) {
        if (failRouter) throw new Error("fixture router unavailable");
        const request = JSON.parse(args.contents[0].parts[0].text);
        const item = corpus.agentCases.find((candidate: any) => candidate.query === request.utterance)
          ?? corpus.crossConversationCases.find((candidate: any) => candidate.query === request.utterance);
        const intent = item?.intent ?? "chat";
        return { text: JSON.stringify({ intent, entities: item?.entities ?? [], date_range: null, needs_memory: item?.needsMemory ?? false, needs_web: item?.needsWeb ?? false, search_queries: item?.searchQueries ?? (item?.searchQuery ? [item.searchQuery] : []) }) };
      }
      if (prompt.includes("You decide whether the context")) return { text: JSON.stringify({ action: "answer", query: "" }) };
      if (prompt.includes("Extract durable factual claims")) {
        const source = args.contents[0].parts[0].text;
        const scenario = corpus.crossConversationCases.find((candidate: any) => source.includes(candidate.previousMessage));
        const fixture = corpus.extractorCases?.find((candidate: any) => source.includes(candidate.sourceText));
        if (scenario && extractionMode === "delayed") {
          onHistoricalExtractionStarted?.();
          await new Promise<void>((resolve) => { releaseHistoricalExtraction = resolve; });
        }
        if (scenario && extractionMode === "fail") throw new Error("fixture extraction failure");
        return { text: JSON.stringify(scenario?.extractedClaims ?? (fixture ? { entities: fixture.entities, claims: fixture.claims } : { entities: [], claims: [] })) };
      }
      throw new Error(`Unexpected Gemini request: ${prompt.slice(0, 80)}`);
    },
    async *generateContentStream(args: any) {
      aiCalls.push(args);
      const candidate = [...args.contents].reverse().find((entry: any) => entry.role === "user" && entry.parts?.some((part: any) => part.text));
      const query = candidate.parts.find((part: any) => part.text).text;
      const item = corpus.agentCases.find((entry: any) => entry.query === query)
        ?? corpus.crossConversationCases.find((entry: any) => entry.query === query);
      const hasSearchResponse = args.contents.some((entry: any) => entry.parts?.some((part: any) => part.functionResponse));
      const evidence = args.contents.flatMap((entry: any) => entry.parts ?? [])
        .flatMap((part: any) => part.functionResponse?.response?.results ?? []);
      if (item?.needsWeb && !hasSearchResponse) {
        const searchQuery = item.searchQueries?.[0] ?? item.searchQuery;
        yield { candidates: [{ content: { parts: [{ functionCall: { name: "web_search", args: { query: searchQuery } } }] } }] };
        return;
      }
      let answer = "Anytime.";
      if (item?.needsWeb) {
        if (!hasSearchResponse) throw new Error("Fixture synthesizer expected a web search response before answering");
        answer = answerFromEvidence(item, evidence, String(args.config.systemInstruction));
      } else if (item?.id === "context-correction-followup") answer = "You corrected it to $108, not $98.";
      else if (item?.id === "anvilly-cross-thread-recall") {
        answer = String(args.config.systemInstruction).includes("User asked who built Anvilly")
          ? "Yes—you asked who built Anvilly in an earlier conversation."
          : "I don't have a record of that earlier chat.";
      }
      yield { candidates: [{ content: { parts: [{ text: answer }] } }] };
    },
  },
};

const mockModule = (specifier: string, exports: Record<string, unknown>) => mock.module(specifier, { exports } as any);
mockModule("@huggingface/transformers", {
    env: {},
    pipeline: async () => async (text: string) => ({ tolist: () => [vectorize(text)] }),
});
mockModule("@qdrant/js-client-rest", { QdrantClient: FixtureQdrantClient });
mockModule("@google/genai", { GoogleGenAI: class { constructor() { return ai; } }, ThinkingLevel: { LOW: "LOW" } });

const [{ claimsByEntities, ensureSession, insertTurnWithId, searchTurns, turnsByIds, writeExtraction }, { db }, memory, prefetch, metrics, router, synthesizer, extractor, agent] = await Promise.all([
  import("../db/queries.js"),
  import("../db/client.js"),
  import("./memory.js"),
  import("./prefetch.js"),
  import("../../scripts/retrieval-metrics.js"),
  import("./router.js"),
  import("./synthesizer.js"),
  import("./extractor.js"),
  import("./index.js"),
]);

const sessions = corpus.sessions as Record<string, { id: string; user: string; turns: Turn[] }>;
for (const session of Object.values(sessions)) {
  ensureSession(session.id);
  for (const turn of session.turns) {
    const stored = insertTurnWithId(session.id, turn.role, turn.text, turn.id, turn.ts);
    await memory.indexTurn(stored);
  }
}
for (const claim of corpus.claims) writeExtraction(claim.turnId, [claim.entity], [{ entity: claim.entity, attribute: claim.attribute, value: claim.value, source_url: claim.source_url, as_of: claim.as_of }]);

const categoryScores = new Map<string, ReturnType<typeof metrics.scoreRetrieval>[]>();
const claimCategoryScores = new Map<string, ReturnType<typeof metrics.scoreRetrieval>[]>();
const failures: { id: string; category: string; detail: string }[] = [];
const knownLimitations: Record<string, unknown>[] = [];
const behaviorResults: { id: string; category: string; passed: boolean }[] = [];
const rankings: { id: string; category: string; firstRelevantRank: number | null; relevantIds: string[]; returnedIds: string[] }[] = [];
const claimRankings: { id: string; category: string; firstRelevantRank: number | null; relevantClaimIds: string[]; returnedClaimIds: string[] }[] = [];
const crossConversationDiagnostics: Record<string, unknown>[] = [];
const claimSharingDiagnostics: Record<string, unknown>[] = [];
const extractionAvailabilityDiagnostics: Record<string, unknown>[] = [];
function recordFailure(item: any, error: unknown, retrieval = false, claims = false) {
  failures.push({ id: item.id, category: item.category, detail: String(error) });
  if (retrieval) {
    const target = claims ? claimCategoryScores : categoryScores;
    const scores = target.get(item.category) ?? [];
    scores.push({ hitAt8: 0, recallAt3: 0, recallAt5: 0, recallAt8: 0, mrr: 0 });
    target.set(item.category, scores);
    if (claims) claimRankings.push({ id: item.id, category: item.category, firstRelevantRank: null, relevantClaimIds: [], returnedClaimIds: [] });
    else rankings.push({ id: item.id, category: item.category, firstRelevantRank: null, relevantIds: item.relevantTurnIds, returnedIds: [] });
  } else behaviorResults.push({ id: item.id, category: item.category, passed: false });
}
function diagnoseRawRecall(args: { found: boolean; indexed: boolean; filteredBySession: boolean; generated: boolean; candidateRank: number; hydrated: boolean }) {
  if (args.found) return "raw_turn_recall_available";
  if (!args.indexed) return "missing_indexing";
  if (args.filteredBySession) return "session_filtering";
  if (!args.generated) return "candidate_generation_failure";
  if (args.candidateRank >= 8) return "ranking_failure";
  if (args.candidateRank >= 0 && !args.hydrated) return "hydration_failure";
  return "candidate_generation_failure";
}

async function askPostgresInSession(sessionId: string, scenario: any) {
  const events: any[] = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: any, options: any) => {
    assert.equal(JSON.parse(options.body).query, scenario.searchQuery);
    return Response.json({ results: scenario.currentSnapshots });
  });
  try {
    await agent.runAgent({ sessionId, userMessage: scenario.query, onEvent: (event: any) => events.push(event) });
  } finally {
    fetchMock.mock.restore();
  }
  return events.filter((event) => event.type === "token").map((event) => event.data.text).join("");
}

test("synthetic corpus retrieves the expected evidence and honors temporal/session filters", async (t) => {
  for (const item of corpus.memoryCases) {
    await t.test(item.id, async () => {
      try {
      const session = sessions[item.session];
      if (item.category === "cross_session_recall") {
        const result = await prefetch.prefetchWithStats({ intent: "recall", entities: item.entities, search_queries: [], date_range: null, needs_memory: true, needs_web: false }, session.id);
        assert.ok(result.block.includes("invoices"), `Expected cross-session claim context; got: ${result.block}`);
        const returnedClaims = claimsByEntities(item.entities);
        const relevantClaims = returnedClaims.filter((claim) => item.relevantTurnIds.includes(claim.turn_id));
        assert.ok(relevantClaims.length, `No source claims for ${item.relevantTurnIds.join(", ")}`);
        claimCategoryScores.set(item.category, [...(claimCategoryScores.get(item.category) ?? []), metrics.scoreRetrieval(returnedClaims.map((claim) => claim.id), relevantClaims.map((claim) => claim.id))]);
        const rank = returnedClaims.findIndex((claim) => relevantClaims.some((relevant) => relevant.id === claim.id));
        claimRankings.push({ id: item.id, category: item.category, firstRelevantRank: rank < 0 ? null : rank + 1, relevantClaimIds: relevantClaims.map((claim) => claim.id), returnedClaimIds: returnedClaims.map((claim) => claim.id) });
        return;
      }
      const turns = await memory.retrieveMemory({ sessionId: session.id, query: item.query, intent: "recall", dateRange: item.dateRange ?? null, limit: 8 });
      const returnedIds = turns.map((turn) => turn.id);
      const text = turns.map((turn) => turn.text.toLowerCase()).join("\n");
      for (const fact of item.expectedFacts) assert.ok(text.includes(fact.toLowerCase()), `Missing fact ${JSON.stringify(fact)}; returned: ${text}`);
      for (const forbidden of item.forbiddenTurnIds ?? []) assert.ok(!returnedIds.includes(forbidden), `Leaked out-of-session turn ${forbidden}`);
      assert.ok(item.relevantTurnIds.some((id: string) => returnedIds.includes(id)), `No relevant IDs in ${returnedIds.join(", ")}`);
      const score = metrics.scoreRetrieval(returnedIds, item.relevantTurnIds);
      const firstRelevant = returnedIds.findIndex((id) => item.relevantTurnIds.includes(id));
      rankings.push({ id: item.id, category: item.category, firstRelevantRank: firstRelevant < 0 ? null : firstRelevant + 1, relevantIds: item.relevantTurnIds, returnedIds });
      const scores = categoryScores.get(item.category) ?? [];
      scores.push(score);
      categoryScores.set(item.category, scores);
      } catch (error) {
        recordFailure(item, error, true, item.category === "cross_session_recall");
        throw error;
      }
    });
  }
});

test("agent planning, dated web evidence, citations, and no-search behavior use fixed fixtures", async (t) => {
  const searchCalls: string[] = [];
  for (const item of corpus.agentCases) {
    await t.test(item.id, async () => {
      try {
      const plan = await router.route(item.query, null, []);
      assert.equal(plan.intent, item.intent);
      assert.equal(plan.needs_web, item.needsWeb);
      assert.deepEqual(plan.search_queries, item.searchQueries);
      const responseArgs: any[] = [];
      const searchesBefore = searchCalls.length;
      const callsBefore = aiCalls.length;
      const fetchMock = mock.method(globalThis, "fetch", async (_url: any, options: any) => {
        const body = JSON.parse(options.body);
        searchCalls.push(body.query);
        const results = item.sources ?? (item.source ? [{ title: item.source.title, url: item.source.url, content: "Price is $120 as of November 15, 2026.", published_date: item.source.published_at }] : []);
        return Response.json({ results });
      });
      try {
        const out = await synthesizer.synthesize({
          plan, memoryBlock: item.historicalContext ?? "<memory></memory>", history: item.history ?? [], userMessage: item.query,
          onToken: () => {}, onSearch: () => {},
        });
        responseArgs.push(...aiCalls.filter((call) => call.config?.systemInstruction?.includes("You are Kitty")));
        for (const fact of item.answerFacts) assert.ok(out.text.toLowerCase().includes(fact.toLowerCase()), `Missing ${fact} in ${out.text}`);
        for (const fact of item.forbiddenAnswerFacts ?? []) assert.ok(!out.text.toLowerCase().includes(fact.toLowerCase()), `Unsupported claim ${fact} in ${out.text}`);
        if (item.history) {
          assert.ok(aiCalls.some((call) => call.config?.systemInstruction?.includes("You are Kitty") && call.contents.some((entry: any) => entry.parts?.some((part: any) => part.text?.includes("Correction: I paid $108")))), "Prior correction was not passed into synthesis");
        }
        const urls = [...new Set([...out.text.matchAll(/https?:\/\/[^)\s]+/g)].map((match) => match[0]))];
        const expectedUrls = item.expectedCitationUrls ?? item.sources?.map((source: any) => source.url) ?? (item.source ? [item.source.url] : []);
        if (item.needsWeb) {
          assert.deepEqual(new Set(urls), new Set(expectedUrls), "Citations must match exactly the sources returned by the fixture search");
          assert.ok(responseArgs.some((args) => String(args.config.systemInstruction).includes(item.searchQueries[0])), "Synthesizer did not receive the planned search query");
          const searchTurn = aiCalls.slice(callsBefore).find((call) => call.config?.systemInstruction?.includes("You are Kitty") && call.contents?.some((entry: any) => entry.parts?.some((part: any) => part.functionResponse)));
          assert.ok(searchTurn, "Synthesizer did not receive the fixture search response");
          const received = searchTurn.contents.flatMap((entry: any) => entry.parts ?? []).flatMap((part: any) => part.functionResponse?.response?.results ?? []);
          assert.deepEqual(received.map((result: any) => ({ title: result.title, url: result.url, snippet: result.snippet, published_at: result.published_at })), (item.sources ?? (item.source ? [{ title: item.source.title, url: item.source.url, content: "Price is $120 as of November 15, 2026.", published_date: item.source.published_at }] : [])).map((source: any) => ({ title: source.title, url: source.url, snippet: source.content, published_at: source.published_date ?? source.published_at ?? "undated" })), "Synthesis evidence differs from the fixture results");
        } else {
          assert.deepEqual(urls, []);
          assert.equal(searchCalls.length, searchesBefore);
        }
        behaviorResults.push({ id: item.id, category: item.category, passed: true });
      } finally {
        fetchMock.mock.restore();
      }
      } catch (error) {
        recordFailure(item, error);
        throw error;
      }
    });
  }
  assert.deepEqual(searchCalls, corpus.agentCases.filter((item: any) => item.needsWeb).map((item: any) => item.searchQueries[0]));
});

const toolCall = (query: string, name = "web_search") => ({ functionCall: { name, args: { query } } });
const modelChunk = (parts: unknown[]) => ({ candidates: [{ content: { parts } }] });
const searchPlan = { intent: "search" as const, entities: [], date_range: null, needs_memory: false, needs_web: true, search_queries: [] };

test("same-round searches overlap and Gemini receives ordered results despite a failed search", async (t) => {
  const started: string[] = [];
  const progress: [string, string[] | undefined][] = [];
  const tokens: string[] = [];
  let rounds = 0;
  let releaseFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: { body: string }) => {
    const { query } = JSON.parse(options.body);
    started.push(query);
    if (query === "first") await firstPending;
    if (query === "failed") throw new Error("fixture search unavailable");
    return Response.json({ results: [{ title: query, url: `https://fixture.example/${query}`, content: `${query} evidence` }] });
  });
  t.mock.method(ai.models, "generateContentStream", async function* (args: any) {
    if (++rounds === 1) {
      yield modelChunk([toolCall("first"), toolCall("failed")]);
      yield modelChunk([toolCall("third")]);
      return;
    }
    const parts = args.contents.at(-1).parts;
    assert.deepEqual(parts.map((part: any) => part.functionResponse.name), ["web_search", "web_search", "web_search"]);
    const responses = parts.map((part: any) => part.functionResponse.response);
    assert.deepEqual(responses, [
      { results: [{ title: "first", url: "https://fixture.example/first", snippet: "first evidence", published_at: "undated" }], note: undefined },
      { results: [], note: "no results (search failed or empty)" },
      { results: [{ title: "third", url: "https://fixture.example/third", snippet: "third evidence", published_at: "undated" }], note: undefined },
    ]);
    yield modelChunk([{ text: responses.flatMap((response: any) => response.results.map((source: any) => `[${source.title}](${source.url})`)).join(" ") }]);
  });

  const run = synthesizer.synthesize({
    plan: searchPlan, memoryBlock: "", history: [], userMessage: "Search three topics",
    onToken: (token) => tokens.push(token),
    onSearch: (query, results) => progress.push([query, results?.map((source) => source.title)]),
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(started, ["first", "failed", "third"], "all searches must start while the first is pending");
    assert.equal(rounds, 1, "the next Gemini round must wait for the whole batch");
    assert.deepEqual(progress.filter(([, results]) => results === undefined), [["first", undefined], ["failed", undefined], ["third", undefined]]);
  } finally {
    releaseFirst();
    await run;
  }
  assert.deepEqual(progress.filter(([, results]) => results !== undefined), [["first", ["first"]], ["failed", []], ["third", ["third"]]]);
  assert.equal(rounds, 2);
  assert.equal(tokens.join(""), "[first](https://fixture.example/first) [third](https://fixture.example/third)");
});

test("search budget is shared across Gemini rounds and skips invalid or excess calls", async (t) => {
  const queries: string[] = [];
  const starts: string[] = [];
  const completions: string[] = [];
  const toolAvailability: boolean[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: { body: string }) => {
    const { query } = JSON.parse(options.body);
    queries.push(query);
    return Response.json({ results: [{ title: query, url: `https://fixture.example/${query}` }] });
  });
  t.mock.method(ai.models, "generateContentStream", async function* (args: any) {
    toolAvailability.push(Boolean(args.config.tools));
    if (toolAvailability.length === 1) {
      yield modelChunk([toolCall("ignored", "unknown"), toolCall(""), ...["1", "2", "3", "4"].map((q) => toolCall(q))]);
    } else if (toolAvailability.length === 2) {
      const responses = args.contents.at(-1).parts.map((part: any) => part.functionResponse);
      assert.deepEqual(responses.map((response: any) => [response.name, response.response.results[0]?.title]), [
        ["unknown", undefined], ["web_search", undefined], ...["1", "2", "3", "4"].map((q) => ["web_search", q]),
      ]);
      assert.deepEqual(queries, ["1", "2", "3", "4"]);
      yield modelChunk([toolCall("5"), toolCall("6"), toolCall("over budget")]);
    } else {
      const responses = args.contents.at(-1).parts.map((part: any) => part.functionResponse.response);
      assert.deepEqual(responses.map((response: any) => response.results[0]?.title), ["5", "6", undefined]);
      yield modelChunk([{ text: "Done." }]);
    }
  });

  const answer = await synthesizer.synthesize({
    plan: searchPlan, memoryBlock: "", history: [], userMessage: "Search multiple rounds",
    onToken: () => {}, onSearch: (query, results) => (results ? completions : starts).push(query),
  });
  assert.deepEqual(toolAvailability, [true, true, false]);
  assert.deepEqual(queries, ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(starts, queries);
  assert.deepEqual(completions, queries);
  assert.equal(answer.text, "Done.");
});

test("Postgres pricing can be compared in a new thread from extracted historical claims", async () => {
  const scenario = corpus.crossConversationCases[0];
  try {
  const sessionA = sessions[scenario.sessionA];
  const sessionB = sessions[scenario.sessionB];
  const historicalAssistantId = scenario.historicalTurnIds[1];
  const indexed = scenario.historicalTurnIds.every((id: string) => points.has(id));
  const rawTurns = await memory.retrieveMemory({
    sessionId: sessionB.id, query: scenario.query, intent: "temporal_delta", dateRange: null, limit: 8,
  });
  const historicalRawTurnFound = rawTurns.some((turn) => scenario.historicalTurnIds.includes(turn.id));
  const sourceSqlIds = searchTurns(sessionA.id, scenario.query, 24).map((turn) => turn.id);
  const targetSqlIds = searchTurns(sessionB.id, scenario.query, 24).map((turn) => turn.id);
  const qdrantAudit = [...qdrantAudits].reverse().find((audit) => audit.requestedSession === sessionB.id);
  const generatedForHistoricalTurn = scenario.historicalTurnIds.some((id: string) => sourceSqlIds.includes(id) || qdrantAudit?.unfilteredTopIds.includes(id));
  const excludedByRequestedSession = scenario.historicalTurnIds.some((id: string) => sourceSqlIds.includes(id) && !targetSqlIds.includes(id))
    || Boolean(qdrantAudit && scenario.historicalTurnIds.some((id: string) => qdrantAudit.unfilteredTopIds.includes(id) && !qdrantAudit.filteredTopIds.includes(id)));
  const fusedTargetCandidates = memory.reciprocalRankFusion([qdrantAudit?.filteredTopIds ?? [], targetSqlIds]).map((item: any) => item.id);
  const candidateRank = fusedTargetCandidates.findIndex((id: string) => scenario.historicalTurnIds.includes(id));
  const selectedTargetIds = fusedTargetCandidates.slice(0, 8);
  const hydratedTargetIds = turnsByIds(sessionB.id, selectedTargetIds).map((turn) => turn.id);
  const hydratedHistoricalTurnFound = hydratedTargetIds.some((id) => scenario.historicalTurnIds.includes(id));

  // Exercise the real extractor with a deterministic model response, then use the real global claim prefetch.
  await extractor.extract(historicalAssistantId);
  const storedClaims = claimsByEntities(scenario.entities);
  const plan = {
    intent: "temporal_delta" as const,
    entities: scenario.entities,
    search_queries: [scenario.searchQuery],
    date_range: null,
    needs_memory: true,
    needs_web: true,
  };
  const recalled = await prefetch.prefetchWithStats(plan, sessionB.id);
  for (const fact of scenario.expectedClaimFacts) {
    assert.ok(recalled.block.toLowerCase().includes(fact.toLowerCase()), `Historical claim missing from Session B context: ${fact}`);
  }
  const relevantClaims = storedClaims.filter((claim) => claim.turn_id === historicalAssistantId);
  const returnedClaimIds = storedClaims.map((claim) => claim.id);
  const relevantClaimIds = relevantClaims.map((claim) => claim.id);
  const claimScore = metrics.scoreRetrieval(returnedClaimIds, relevantClaimIds);
  const crossScores = claimCategoryScores.get(scenario.category) ?? [];
  crossScores.push(claimScore);
  claimCategoryScores.set(scenario.category, crossScores);
  const claimRank = returnedClaimIds.findIndex((id) => relevantClaimIds.includes(id));
  claimRankings.push({ id: scenario.id, category: scenario.category, firstRelevantRank: claimRank < 0 ? null : claimRank + 1, relevantClaimIds, returnedClaimIds });

  const fetchMock = mock.method(globalThis, "fetch", async (_url: any, options: any) => {
    assert.equal(JSON.parse(options.body).query, scenario.searchQuery);
    return Response.json({ results: scenario.currentSnapshots });
  });
  const events: any[] = [];
  try {
    await agent.runAgent({ sessionId: sessionB.id, userMessage: scenario.query, onEvent: (event: any) => events.push(event) });
  } finally {
    fetchMock.mock.restore();
  }

  const planEvent = events.find((event) => event.type === "plan");
  assert.equal(planEvent?.data.intent, "temporal_delta");
  const toolEvents = events.filter((event) => event.type === "tool");
  assert.ok(toolEvents.some((event) => event.data.query === scenario.searchQuery), "Expected deterministic current-price search");
  const answer = events.filter((event) => event.type === "token").map((event) => event.data.text).join("");
  for (const fact of scenario.expectedAnswerFacts) assert.ok(answer.toLowerCase().includes(fact.toLowerCase()), `Missing comparison detail ${fact}: ${answer}`);
  for (const phrase of scenario.forbiddenAnswerPhrases) assert.ok(!answer.toLowerCase().includes(phrase.toLowerCase()), `Agent asked user to repeat existing history: ${answer}`);
  const citations = [...answer.matchAll(/https?:\/\/[^)\s]+/g)].map((match) => match[0]);
  assert.deepEqual(new Set(citations), new Set(scenario.requiredCurrentCitationUrls));
  assert.ok(events.some((event) => event.type === "done"));

  const synthCall = [...aiCalls].reverse().find((call: any) => call.config?.systemInstruction?.includes("You are Kitty") && call.contents?.some((entry: any) => entry.parts?.some((part: any) => part.text === scenario.query)));
  assert.ok(synthCall, "Expected synthesis to receive the temporal query");
  assert.ok(scenario.expectedClaimFacts.every((fact: string) => synthCall.config.systemInstruction.toLowerCase().includes(fact.toLowerCase())), "Historical claims were not included in synthesis context");

  const cause = diagnoseRawRecall({ found: historicalRawTurnFound, indexed, filteredBySession: excludedByRequestedSession, generated: generatedForHistoricalTurn, candidateRank, hydrated: hydratedHistoricalTurnFound });
  crossConversationDiagnostics.push({
    id: scenario.id,
    rawTurn: { indexed, foundFromNewSession: historicalRawTurnFound, retrievalMetrics: metrics.scoreRetrieval(rawTurns.map((turn) => turn.id), scenario.historicalTurnIds), diagnosis: cause, expectedByDesign: cause === "session_filtering", sourceSessionSqlCandidates: sourceSqlIds.filter((id: string) => scenario.historicalTurnIds.includes(id)), targetSessionSqlCandidates: targetSqlIds.filter((id: string) => scenario.historicalTurnIds.includes(id)), qdrantUnfilteredCandidates: qdrantAudit?.unfilteredTopIds.filter((id) => scenario.historicalTurnIds.includes(id)) ?? [], qdrantFilteredCandidates: qdrantAudit?.filteredTopIds.filter((id) => scenario.historicalTurnIds.includes(id)) ?? [], targetFusionCandidateRank: candidateRank < 0 ? null : candidateRank + 1, hydratedTargetCandidates: hydratedTargetIds },
    claims: { extractionRan: true, storedForHistoricalTurn: storedClaims.filter((claim) => claim.turn_id === historicalAssistantId).length, visibleInNewSessionContext: true },
    ranking: { rawTurns: historicalRawTurnFound ? "ranked" : generatedForHistoricalTurn ? "candidate_excluded_by_session_filter" : "no_candidate", firstRelevantClaimRank: claimRank < 0 ? null : claimRank + 1 },
    overallRecall: "supported through globally retrieved extracted claims when extraction has completed",
    ownerModel: "single_application_owner; session_ids_are_conversation_threads; claims_are_shared_across_threads_by_design",
    oldSession: sessionA.id,
  });
  if (!historicalRawTurnFound && cause !== "session_filtering") knownLimitations.push({ id: scenario.id, path: "raw_turn_cross_session", cause });
  behaviorResults.push({ id: scenario.id, category: scenario.category, passed: true });
  } catch (error) {
    recordFailure(scenario, error, true);
    behaviorResults.push({ id: scenario.id, category: scenario.category, passed: false });
    throw error;
  }
});

test("Anvilly discussion topic is recalled across threads through global claims", async () => {
  const oldAssistantTurn = sessions["anvilly-history"].turns[1];
  await extractor.extract(oldAssistantTurn.id);
  const plan = { intent: "recall" as const, entities: ["Anvilly"], search_queries: [], date_range: null, needs_memory: true, needs_web: false };
  const oldThreadClaims = await prefetch.prefetchWithStats(plan, sessions["anvilly-new-thread"].id);
  assert.match(oldThreadClaims.block, /User asked who built Anvilly/);

  const events: any[] = [];
  await agent.runAgent({ sessionId: sessions["anvilly-new-thread"].id, userMessage: "did i ever asked you about anvilly?", onEvent: (event: any) => events.push(event) });
  const answer = events.filter((event) => event.type === "token").map((event) => event.data.text).join("");
  assert.match(answer, /asked who built Anvilly/i);
});

test("verifies conflicting claims are intentionally shared across this owner's threads", async () => {
  for (const scenario of corpus.claimSharingCases) {
    const session = sessions[scenario.session];
    const context = await prefetch.prefetchWithStats({ intent: "recall", entities: scenario.entities, search_queries: [], date_range: null, needs_memory: true, needs_web: false }, session.id);
    const retrievedClaims = claimsByEntities(scenario.entities);
    const sessionTurnIds = new Set(session.turns.map((turn) => turn.id));
    const relevantClaimIds = retrievedClaims.filter((claim) => sessionTurnIds.has(claim.turn_id)).map((claim) => claim.id);
    const claimScore = metrics.scoreRetrieval(retrievedClaims.map((claim) => claim.id), relevantClaimIds);
    claimCategoryScores.set(scenario.category, [...(claimCategoryScores.get(scenario.category) ?? []), claimScore]);
    const firstRelevantClaim = retrievedClaims.findIndex((claim) => relevantClaimIds.includes(claim.id));
    claimRankings.push({ id: scenario.id, category: scenario.category, firstRelevantRank: firstRelevantClaim < 0 ? null : firstRelevantClaim + 1, relevantClaimIds, returnedClaimIds: retrievedClaims.map((claim) => claim.id) });
    const ownPresent = context.block.includes(scenario.ownClaim);
    const otherThreadPresent = context.block.includes(scenario.otherThreadClaim);
    assert.ok(ownPresent, `${scenario.id}: own preference claim missing`);
    assert.ok(otherThreadPresent, `${scenario.id}: claims from the owner's other thread should be shared`);
    const result = {
      id: scenario.id,
      status: "expected_cross_session_sharing",
      expected: `include other thread's claim: ${scenario.otherThreadClaim}`,
      observedSharedClaim: otherThreadPresent,
      ownerModel: "single application owner; sessions identify threads",
    };
    claimSharingDiagnostics.push(result);
    behaviorResults.push({ id: scenario.id, category: scenario.category, passed: true });
  }
});

test("reports pending, delayed, and failed historical extraction behavior", async () => {
  const scenario = corpus.crossConversationCases[0];
  const sourceTurnId = scenario.historicalTurnIds[1];
  const entities = scenario.entities;
  const sourceClaims = () => claimsByEntities(entities).filter((claim) => claim.turn_id === sourceTurnId);
  const unavailableFacts = ["$5 to $9/month", "$15 to $30/month"];
  const extractAndAssertUnavailable = async (sessionName: string, state: string) => {
    const answer = await askPostgresInSession(sessions[sessionName].id, scenario);
    for (const fact of unavailableFacts) assert.ok(!answer.includes(fact), `${state}: fabricated inaccessible history ${fact}`);
    assert.ok(answer.includes("Historical pricing isn't available in context"), `${state}: expected an honest missing-history response`);
    assert.ok(answer.includes("can't confirm a change"), `${state}: must not claim a price change without historical baseline`);
    assert.ok(!scenario.forbiddenAnswerPhrases.some((phrase: string) => answer.toLowerCase().includes(phrase.toLowerCase())));
    return answer;
  };

  writeExtraction(sourceTurnId, [], []);
  assert.equal(sourceClaims().length, 0);
  const pendingAnswer = await extractAndAssertUnavailable("postgres-pending", "pending extraction");
  extractionAvailabilityDiagnostics.push({ state: "pending", claimsAvailable: false, response: "no historical comparison; current price only; no repeat request" });
  knownLimitations.push({ id: scenario.id, state: "pending", cause: "historical turn is session-scoped and claims have not been extracted yet" });

  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  onHistoricalExtractionStarted = signalStarted;
  extractionMode = "delayed";
  const delayedExtraction = extractor.extract(sourceTurnId);
  await started;
  assert.equal(sourceClaims().length, 0, "Delayed extraction must not expose incomplete claims");
  const delayedAnswer = await extractAndAssertUnavailable("postgres-delayed", "delayed extraction");
  releaseHistoricalExtraction?.();
  await delayedExtraction;
  extractionMode = "normal";
  onHistoricalExtractionStarted = undefined;
  assert.ok(sourceClaims().length > 0, "Completed delayed extraction should make claims available to later threads");
  extractionAvailabilityDiagnostics.push({ state: "delayed", claimsAvailableDuringRequest: false, claimsAvailableAfterCompletion: true, response: "no historical comparison while extraction is in flight" });
  knownLimitations.push({ id: scenario.id, state: "delayed", cause: "historical turn is session-scoped until claim extraction commits" });

  writeExtraction(sourceTurnId, [], []);
  extractionMode = "fail";
  await extractor.extract(sourceTurnId);
  extractionMode = "normal";
  assert.equal(sourceClaims().length, 0, "Failed extraction must not leave partial claims");
  const retryState = db.prepare("SELECT extraction_status, extraction_retry_at FROM turns WHERE id = ?").get(sourceTurnId) as { extraction_status: string; extraction_retry_at: string | null };
  assert.equal(retryState.extraction_status, "pending");
  assert.ok(retryState.extraction_retry_at, "Failed extraction must be scheduled for retry");
  const failedAnswer = await extractAndAssertUnavailable("postgres-extraction-failed", "failed extraction");
  extractionAvailabilityDiagnostics.push({ state: "failed", claimsAvailable: false, response: "no historical comparison; current price only; no repeat request" });
  knownLimitations.push({ id: scenario.id, state: "failed", cause: "claim extraction failed; raw-turn recall remains session-scoped" });
  behaviorResults.push({ id: `${scenario.id}-extraction-availability`, category: "historical_extraction_availability", passed: true });
  assert.ok(pendingAnswer && delayedAnswer && failedAnswer);
});

test("citation evaluator detects a fabricated source", () => {
  const fabricated = "Claim supported by [Fake Source](https://fabricated.example/not-real), 2026-11-15.";
  const citedUrls = [...fabricated.matchAll(/https?:\/\/[^)\s]+/g)].map((match) => match[0]);
  assert.equal(citedUrls.every((url) => url === "https://fixture.example/pricing"), false);
});

test("raw-recall diagnostics distinguish indexing, filtering, generation, ranking, and hydration", () => {
  const base = { found: false, indexed: true, filteredBySession: false, generated: false, candidateRank: -1, hydrated: false };
  assert.equal(diagnoseRawRecall({ ...base, indexed: false }), "missing_indexing");
  assert.equal(diagnoseRawRecall({ ...base, filteredBySession: true, generated: true }), "session_filtering");
  assert.equal(diagnoseRawRecall(base), "candidate_generation_failure");
  assert.equal(diagnoseRawRecall({ ...base, generated: true, candidateRank: 9 }), "ranking_failure");
  assert.equal(diagnoseRawRecall({ ...base, generated: true, candidateRank: 2 }), "hydration_failure");
});

test("router outage still recognizes explicit cross-thread recall", async () => {
  failRouter = true;
  try {
    const plan = await router.route("did i ever asked you about anvilly?", null, []);
    assert.equal(plan.intent, "recall");
    assert.equal(plan.needs_memory, true);
    assert.ok(plan.entities.some((entity: string) => entity.toLowerCase() === "anvilly"));
  } finally {
    failRouter = false;
  }
});

after(() => {
  console.log("AGENT REGRESSION REPORT " + JSON.stringify({
    categories: Object.fromEntries([...categoryScores].map(([category, scores]) => [category, {
      cases: scores.length,
      passed: scores.filter((score) => score.hitAt8).length,
      failed: scores.filter((score) => !score.hitAt8).length,
      hitAt8: Number((scores.reduce((sum, score) => sum + score.hitAt8, 0) / Math.max(scores.length, 1)).toFixed(3)),
      recallAt3: Number((scores.reduce((sum, score) => sum + score.recallAt3, 0) / Math.max(scores.length, 1)).toFixed(3)),
      recallAt5: Number((scores.reduce((sum, score) => sum + score.recallAt5, 0) / Math.max(scores.length, 1)).toFixed(3)),
      recallAt8: Number((scores.reduce((sum, score) => sum + score.recallAt8, 0) / Math.max(scores.length, 1)).toFixed(3)),
      mrr: Number((scores.reduce((sum, score) => sum + score.mrr, 0) / Math.max(scores.length, 1)).toFixed(3)),
    }])),
    claimRetrieval: Object.fromEntries([...claimCategoryScores].map(([category, scores]) => [category, {
      cases: scores.length,
      hitAt8: Number((scores.reduce((sum, score) => sum + score.hitAt8, 0) / Math.max(scores.length, 1)).toFixed(3)),
      recallAt3: Number((scores.reduce((sum, score) => sum + score.recallAt3, 0) / Math.max(scores.length, 1)).toFixed(3)),
      recallAt5: Number((scores.reduce((sum, score) => sum + score.recallAt5, 0) / Math.max(scores.length, 1)).toFixed(3)),
      recallAt8: Number((scores.reduce((sum, score) => sum + score.recallAt8, 0) / Math.max(scores.length, 1)).toFixed(3)),
      mrr: Number((scores.reduce((sum, score) => sum + score.mrr, 0) / Math.max(scores.length, 1)).toFixed(3)),
    }])),
    behavior: Object.fromEntries([...new Set(behaviorResults.map((result) => result.category))].map((category) => {
      const cases = behaviorResults.filter((result) => result.category === category);
      return [category, { cases: cases.length, passed: cases.filter((result) => result.passed).length, failed: cases.filter((result) => !result.passed).length }];
    })),
    lowestRanked: [...rankings].sort((a, b) => (a.firstRelevantRank ?? Infinity) - (b.firstRelevantRank ?? Infinity)).reverse().slice(0, 5),
    lowestRankedClaims: [...claimRankings].sort((a, b) => (a.firstRelevantRank ?? Infinity) - (b.firstRelevantRank ?? Infinity)).reverse().slice(0, 5),
    crossConversationDiagnostics,
    claimSharingDiagnostics,
    extractionAvailabilityDiagnostics,
    knownLimitations,
    failures,
  }));
  db.close();
  rmSync(temp, { recursive: true, force: true });
});
