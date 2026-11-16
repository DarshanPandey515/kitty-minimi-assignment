import { performance } from "node:perf_hooks";
import { ai } from "./gemini.js";
import { pendingTurns, retryTurnIndex, markTurnIndexed, searchTurns, turnsByIds, turnsInRange, type Turn } from "../db/queries.js";
import { isInternalAssistantText } from "./prefetch.js";
import { QdrantClient } from "@qdrant/js-client-rest";

const DIMENSIONS = 768;
const COLLECTION = process.env.QDRANT_COLLECTION ?? "kitty_turns";
const client = process.env.QDRANT_URL
  ? new QdrantClient({ url: process.env.QDRANT_URL, ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}) })
  : null;
let collectionReady: Promise<boolean> | undefined;

export async function embedText(text: string): Promise<number[]> {
  const result = await ai.models.embedContent({
    model: process.env.GEMINI_MODEL_EMBEDDING ?? "gemini-embedding-001",
    contents: text,
    config: { outputDimensionality: DIMENSIONS },
  });
  const vector = result.embeddings?.[0]?.values;
  if (!vector || vector.length !== DIMENSIONS) throw new Error("Gemini returned an invalid embedding");
  return vector;
}

async function ensureCollection() {
  if (!client) return false;
  collectionReady ??= (async () => {
    const { collections } = await client.getCollections();
    if (!collections.some((item) => item.name === COLLECTION)) {
      await client.createCollection(COLLECTION, { vectors: { size: DIMENSIONS, distance: "Cosine" } });
      await client.createPayloadIndex(COLLECTION, { field_name: "session_id", field_schema: "keyword" });
      await client.createPayloadIndex(COLLECTION, { field_name: "role", field_schema: "keyword" });
      await client.createPayloadIndex(COLLECTION, { field_name: "ts_ms", field_schema: "integer" });
    }
    return true;
  })().catch((err) => {
    collectionReady = undefined;
    throw err;
  });
  return collectionReady;
}

export async function indexTurn(turn: Turn) {
  if (!client || !(await ensureCollection())) throw new Error("Qdrant is not configured");
  const vector = await embedText(turn.text);
  await client.upsert(COLLECTION, {
    wait: true,
    points: [{
      id: turn.id,
      vector,
      payload: { session_id: turn.session_id, role: turn.role, ts: turn.ts, ts_ms: Date.parse(turn.ts) },
    }],
  });
}

export async function deleteSessionIndex(sessionId: string) {
  if (!client || !(await ensureCollection())) return;
  await client.delete(COLLECTION, {
    filter: { must: [{ key: "session_id", match: { value: sessionId } }] },
    wait: true,
  });
}

type Ranked = { id: string; score: number };
export function reciprocalRankFusion(lists: string[][], k = 60): Ranked[] {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

export async function retrieveMemory(args: {
  sessionId: string;
  query: string;
  intent: "recall" | "temporal_delta";
  dateRange: [string, string] | null;
  excludeTurnIds?: string[];
  limit?: number;
}) {
  const totalStart = performance.now();
  const { sessionId, query, intent, dateRange, excludeTurnIds = [] } = args;
  const limit = args.limit ?? 8;
  const pureTemporal = intent === "recall" && dateRange !== null;
  const timings: Record<string, number> = {};
  const excluded = new Set(excludeTurnIds);
  let embeddingPromise: Promise<number[]> | undefined;
  const embeddingStart = performance.now();
  if (!pureTemporal && client) embeddingPromise = embedText(query);

  const lexicalStart = performance.now();
  const lexicalResults = pureTemporal ? [] : searchTurns(sessionId, query, limit * 3).filter((turn) => !excluded.has(turn.id));
  const lexical = dateRange
    ? lexicalResults.filter((turn) => turn.ts >= dateRange[0] && turn.ts <= dateRange[1])
    : lexicalResults;
  timings.lexicalMs = performance.now() - lexicalStart;

  const temporalStart = performance.now();
  const temporal = dateRange ? turnsInRange(sessionId, dateRange[0], dateRange[1], limit * 3).filter((turn) => !excluded.has(turn.id)) : [];
  timings.temporalMs = performance.now() - temporalStart;

  let dense: string[] = [];
  if (embeddingPromise && client) {
    try {
      const vector = await embeddingPromise;
      timings.embeddingMs = performance.now() - embeddingStart;
      const qdrantStart = performance.now();
      await ensureCollection();
      const must: any[] = [{ key: "session_id", match: { value: sessionId } }];
      const filter: any = { must };
      if (dateRange) must.push({ key: "ts_ms", range: { gte: Date.parse(dateRange[0]), lte: Date.parse(dateRange[1]) } });
      if (excludeTurnIds.length) filter.must_not = [{ has_id: excludeTurnIds }];
      const result = await client.query(COLLECTION, {
        query: vector,
        limit: limit * 3,
        with_payload: false,
        filter,
      });
      dense = result.points.map((point) => String(point.id));
      timings.qdrantMs = performance.now() - qdrantStart;
    } catch (err) {
      console.warn("[memory] semantic retrieval unavailable; using SQL results:", (err as Error).message);
    }
  }

  const fusionStart = performance.now();
  const candidateIds = reciprocalRankFusion([
    dense,
    lexical.map((turn) => turn.id),
    temporal.map((turn) => turn.id),
  ]).slice(0, limit).map((hit) => hit.id);
  const byId = new Map(turnsByIds(sessionId, candidateIds).map((turn) => [turn.id, turn]));
  const turns = candidateIds.map((id) => byId.get(id)).filter((turn): turn is Turn => Boolean(turn))
    .filter((turn) => turn.role !== "assistant" || !isInternalAssistantText(turn.text));
  timings.fusionMs = performance.now() - fusionStart;
  timings.totalMs = performance.now() - totalStart;
  console.info("[memory] retrieval", JSON.stringify({ intent, pureTemporal, dense: dense.length, lexical: lexical.length, temporal: temporal.length, returned: turns.length, ...timings }));
  return turns;
}

let workerRunning = false;
export function startMemoryIndexWorker() {
  if (!client) {
    console.info("[memory] QDRANT_URL unset; semantic index disabled");
    return;
  }
  const timer = setInterval(() => void drainIndexQueue(), 1_000);
  timer.unref();
  void drainIndexQueue();
}

async function drainIndexQueue() {
  if (workerRunning || !client) return;
  workerRunning = true;
  try {
    const batch = pendingTurns(8);
    for (const turn of batch) {
      try {
        await indexTurn(turn);
        markTurnIndexed(turn.id);
      } catch (err) {
        retryTurnIndex(turn.id, turn.embedding_attempts);
        console.warn("[memory] index retry scheduled:", (err as Error).message);
      }
    }
  } catch (err) {
    console.warn("[memory] index worker failed:", (err as Error).message);
  } finally {
    workerRunning = false;
  }
}

