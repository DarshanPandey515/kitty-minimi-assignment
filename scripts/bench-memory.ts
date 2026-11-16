import "dotenv/config";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

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

const [{ searchTurns, turnsInRange }, { retrieveMemory }] = await Promise.all([
  import("../server/db/queries.js"),
  import("../server/agent/memory.js"),
]);
const metrics = { sql: { recall: [] as number[], latency: [] as number[] }, hybrid: { recall: [] as number[], latency: [] as number[] } };

for (const item of cases) {
  const start = performance.now();
  const sqlLexical = item.intent === "recall" && item.dateRange
    ? []
    : searchTurns(item.sessionId, item.query, 24).filter((turn) => !item.dateRange || (turn.ts >= item.dateRange[0] && turn.ts <= item.dateRange[1]));
  const sqlTemporal = item.dateRange ? turnsInRange(item.sessionId, ...item.dateRange, 24) : [];
  const sql = [...new Map([...sqlLexical, ...sqlTemporal].map((turn) => [turn.id, turn])).values()].slice(0, 8);
  metrics.sql.latency.push(performance.now() - start);
  metrics.sql.recall.push(hitRate(sql.map((turn) => turn.id), item.relevantTurnIds));

  const hybridStart = performance.now();
  const hybrid = await retrieveMemory({ ...item, limit: 8 });
  metrics.hybrid.latency.push(performance.now() - hybridStart);
  metrics.hybrid.recall.push(hitRate(hybrid.map((turn) => turn.id), item.relevantTurnIds));
}

console.log(JSON.stringify({ cases: cases.length, sql: summarize(metrics.sql), hybrid: summarize(metrics.hybrid) }, null, 2));

function hitRate(returned: string[], relevant: string[]) {
  if (!relevant.length) return 0;
  const hits = new Set(returned.filter((id) => relevant.includes(id))).size;
  return hits / relevant.length;
}

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number((sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(1));
}

function summarize(values: { recall: number[]; latency: number[] }) {
  return {
    recallAt8: Number((values.recall.reduce((sum, value) => sum + value, 0) / Math.max(values.recall.length, 1)).toFixed(3)),
    latencyMs: { p50: percentile(values.latency, 0.5), p95: percentile(values.latency, 0.95) },
  };
}
