import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { searchTurns, turnsInRange } from "../server/db/queries.js";
import { retrieveMemory } from "../server/agent/memory.js";

type Case = {
  sessionId: string;
  query: string;
  intent: "recall" | "temporal_delta";
  dateRange: [string, string] | null;
  relevantTurnIds: string[];
};

const path = process.env.MEMORY_EVAL_FILE;
if (!path) throw new Error("Set MEMORY_EVAL_FILE to a JSON file of labeled recall cases");
const cases = JSON.parse(readFileSync(path, "utf8")) as Case[];
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
