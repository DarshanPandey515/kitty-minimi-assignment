import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { scoreRetrieval, type RetrievalMetrics } from "./retrieval-metrics.js";

type Case = {
  id?: string;
  sessionId: string;
  query: string;
  intent: "recall" | "temporal_delta";
  dateRange: [string, string] | null;
  relevantTurnIds: string[];
};

const args = process.argv.slice(2);
const outputArg = args.indexOf("--output");
const fixturePath = process.env.MEMORY_EVAL_FILE ?? args.find((arg, index) => !arg.startsWith("--") && !(outputArg >= 0 && index === outputArg + 1));
const outputPath = process.env.MEMORY_BENCH_OUTPUT ?? (outputArg >= 0 ? args[outputArg + 1] : undefined);
if (outputArg >= 0 && !outputPath) throw new Error("--output requires a file path");
if (!fixturePath) {
  console.error("Usage: npm run bench:memory -- <labeled-cases.json>\nOr set MEMORY_EVAL_FILE. See scripts/memory-eval.example.json.");
  process.exit(1);
}
if (!process.env.QDRANT_URL) {
  console.error("Set QDRANT_URL in .env before running the hybrid memory benchmark.");
  process.exit(1);
}

let cases: Case[];
try {
  const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as Case[] | {
    sessions: Record<string, { id: string }>;
    cases: { id: string; session: string; query: string; type: "semantic" | "temporal"; dateRange?: [string, string]; relevantTurnIds: string[] }[];
  };
  cases = Array.isArray(parsed) ? parsed : parsed.cases.map((item) => ({
    id: item.id,
    sessionId: parsed.sessions[item.session]?.id ?? item.session,
    query: item.query,
    intent: "recall",
    dateRange: item.dateRange ?? null,
    relevantTurnIds: item.relevantTurnIds,
  }));
  if (!cases.length) throw new Error("expected a non-empty case list");
} catch (error) {
  console.error(`Cannot load benchmark cases from ${fixturePath}: ${(error as Error).message}`);
  process.exit(1);
}

const [{ searchTurns, turnsInRange, turnsByIds }, { retrieveMemory, warmupMemoryModel }] = await Promise.all([
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
await warmupMemoryModel();
for (const item of cases) {
  if (!(item.intent === "recall" && item.dateRange)) searchTurns(item.sessionId, item.query, 24);
  if (item.dateRange) turnsInRange(item.sessionId, ...item.dateRange, 24);
}

type Metrics = { hitAt8: number[]; recallAt8: number[]; mrr: number[]; latency: number[] };
const metrics: Record<string, { sql: Metrics; minilm: Metrics }> = {};
const caseResults: object[] = [];

for (const [index, item] of cases.entries()) {
  const type = item.intent === "recall" && item.dateRange ? "temporal" : "semantic";
  const group = metrics[type] ??= { sql: newMetrics(), minilm: newMetrics() };
  const start = performance.now();
  const sqlLexical = item.intent === "recall" && item.dateRange
    ? []
    : searchTurns(item.sessionId, item.query, 24).filter((turn) => !item.dateRange || (turn.ts >= item.dateRange[0] && turn.ts <= item.dateRange[1]));
  const sqlTemporal = item.dateRange ? turnsInRange(item.sessionId, ...item.dateRange, 24) : [];
  const sql = [...new Map([...sqlLexical, ...sqlTemporal].map((turn) => [turn.id, turn])).values()].slice(0, 8);
  group.sql.latency.push(performance.now() - start);
  const sqlScore = scoreRetrieval(sql.map((turn) => turn.id), item.relevantTurnIds);
  recordMetrics(group.sql, sqlScore);

  const hybridStart = performance.now();
  const hybrid = await retrieveMemory({ ...item, limit: 8 });
  const hybridLatency = performance.now() - hybridStart;
  const minilmScore = scoreRetrieval(hybrid.map((turn) => turn.id), item.relevantTurnIds);
  group.minilm.latency.push(hybridLatency);
  recordMetrics(group.minilm, minilmScore);
  caseResults.push({
    id: item.id ?? `case-${index + 1}`,
    type,
    sql: { ...sqlScore, latencyMs: Number((group.sql.latency.at(-1) ?? 0).toFixed(1)) },
    minilm: { ...minilmScore, latencyMs: Number(hybridLatency.toFixed(1)) },
  });
}

const report = { comparison: "SQL-only baseline vs MiniLM hybrid on the same corpus", corpus: path.basename(fixturePath), cases: caseResults, byType: Object.fromEntries(Object.entries(metrics).map(([type, group]) => [type, {
  cases: group.sql.hitAt8.length,
  sql: summarize(group.sql),
  minilm: summarize(group.minilm),
}])) };
const reportJson = `${JSON.stringify(report, null, 2)}\n`;
console.log(reportJson);
if (outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, reportJson);
}

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
