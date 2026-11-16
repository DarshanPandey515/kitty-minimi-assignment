import "dotenv/config";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { scoreRetrieval, type RetrievalMetrics } from "./retrieval-metrics.js";

type Case = {
  sessionId: string;
  query: string;
  intent: "recall" | "temporal_delta";
  dateRange: [string, string] | null;
  relevantTurnIds: string[];
};

const fixturePath = process.env.MEMORY_EVAL_FILE ?? process.argv[2];
if (!fixturePath) {
  console.error("Usage: npm run bench:memory -- <labeled-cases.json>\nOr set MEMORY_EVAL_FILE. See scripts/memory-eval.example.json.");
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY || !process.env.QDRANT_URL) {
  console.error("Set GEMINI_API_KEY and QDRANT_URL in .env before running the hybrid memory benchmark.");
  process.exit(1);
}

let cases: Case[];
try {
  cases = JSON.parse(readFileSync(fixturePath, "utf8")) as Case[];
  if (!Array.isArray(cases) || cases.length === 0) throw new Error("expected a non-empty JSON array");
} catch (error) {
  console.error(`Cannot load benchmark cases from ${fixturePath}: ${(error as Error).message}`);
  process.exit(1);
}

const [{ searchTurns, turnsInRange, turnsByIds }, { retrieveMemory }] = await Promise.all([
  import("../server/db/queries.js"),
  import("../server/agent/memory.js"),
]);
for (const [index, item] of cases.entries()) {
  if (!item.sessionId || !item.query || !Array.isArray(item.relevantTurnIds) || !item.relevantTurnIds.length) {
    console.error(`Invalid benchmark case ${index + 1}: sessionId, query, and at least one relevantTurnId are required.`);
    process.exit(1);
  }
  const found = turnsByIds(item.sessionId, item.relevantTurnIds);
  const foundIds = new Set(found.map((turn) => turn.id));
  const missing = item.relevantTurnIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    console.error(`Invalid benchmark case ${index + 1}: missing IDs in session ${item.sessionId}:\n${missing.join("\n")}`);
    process.exit(1);
  }
}

type Metrics = { hitAt8: number[]; recallAt8: number[]; mrr: number[]; latency: number[] };
const metrics: Record<string, { sql: Metrics; hybrid: Metrics }> = {};

for (const item of cases) {
  const type = item.intent === "recall" && item.dateRange ? "temporal" : "semantic";
  const group = metrics[type] ??= { sql: newMetrics(), hybrid: newMetrics() };
  const start = performance.now();
  const sqlLexical = item.intent === "recall" && item.dateRange
    ? []
    : searchTurns(item.sessionId, item.query, 24).filter((turn) => !item.dateRange || (turn.ts >= item.dateRange[0] && turn.ts <= item.dateRange[1]));
  const sqlTemporal = item.dateRange ? turnsInRange(item.sessionId, ...item.dateRange, 24) : [];
  const sql = [...new Map([...sqlLexical, ...sqlTemporal].map((turn) => [turn.id, turn])).values()].slice(0, 8);
  group.sql.latency.push(performance.now() - start);
  recordMetrics(group.sql, scoreRetrieval(sql.map((turn) => turn.id), item.relevantTurnIds));

  const hybridStart = performance.now();
  const hybrid = await retrieveMemory({ ...item, limit: 8 });
  group.hybrid.latency.push(performance.now() - hybridStart);
  recordMetrics(group.hybrid, scoreRetrieval(hybrid.map((turn) => turn.id), item.relevantTurnIds));
}

console.log(JSON.stringify({ cases: cases.length, byType: Object.fromEntries(Object.entries(metrics).map(([type, group]) => [type, {
  cases: group.sql.hitAt8.length,
  sql: summarize(group.sql),
  hybrid: summarize(group.hybrid),
}])) }, null, 2));

function newMetrics(): Metrics {
  return { hitAt8: [], recallAt8: [], mrr: [], latency: [] };
}

function recordMetrics(target: Metrics, scored: RetrievalMetrics) {
  target.hitAt8.push(scored.hitAt8);
  target.recallAt8.push(scored.recallAt8);
  target.mrr.push(scored.mrr);
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(1));
}

function summarize(values: Metrics) {
  return {
    hitAt8: average(values.hitAt8),
    recallAt8: average(values.recallAt8),
    mrr: average(values.mrr),
    latencyMs: { p50: percentile(values.latency, 0.5), p95: percentile(values.latency, 0.95) },
  };
}

function average(values: number[]) {
  return Number((values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)).toFixed(3));
}
