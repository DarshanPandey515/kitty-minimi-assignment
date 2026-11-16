import "dotenv/config";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

type Corpus = {
  sessions: Record<string, { id: string; turns: { id: string; role: "user" | "assistant"; ts: string; text: string }[] }>;
  cases: { id: string; session: string; query: string; type: "semantic" | "temporal"; dateRange?: [string, string]; relevantTurnIds: string[] }[];
};

const args = process.argv.slice(2);
const corpusPath = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? "scripts/memory-eval.corpus.json");
const dbPath = path.resolve(process.env.DB_PATH ?? "./data/agent.db");
const reset = args.includes("--reset");
if (!process.env.QDRANT_URL) throw new Error("Set QDRANT_URL before seeding the MiniLM memory benchmark.");

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;
if (!corpus.sessions || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error("Corpus must define sessions and labeled cases.");
for (const [name, session] of Object.entries(corpus.sessions)) {
  if (!session.id || !Array.isArray(session.turns)) throw new Error(`Invalid session: ${name}`);
  const ids = new Set<string>();
  for (const turn of session.turns) {
    if (!turn.id || ids.has(turn.id) || !["user", "assistant"].includes(turn.role) || !Number.isFinite(Date.parse(turn.ts)) || !turn.text) {
      throw new Error(`Invalid or duplicate turn in session: ${name}`);
    }
    ids.add(turn.id);
  }
}
for (const item of corpus.cases) {
  const session = corpus.sessions[item.session];
  const ids = new Set(session?.turns.map((turn) => turn.id));
  if (!session || !item.query || !item.relevantTurnIds.length || item.relevantTurnIds.some((id) => !ids.has(id))) {
    throw new Error(`Invalid labeled case: ${item.id}`);
  }
  if (item.type === "temporal" && !item.dateRange) throw new Error(`Temporal case needs a dateRange: ${item.id}`);
}

if (existsSync(dbPath) && !reset) throw new Error(`Refusing to overwrite ${dbPath}; pass --reset to replace it.`);
if (reset) for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });

const [{ ensureSession, insertTurnWithId, markTurnIndexed }, { db }, { deleteSessionIndex, EMBEDDING_VERSION, indexTurn, warmupMemoryModel }] = await Promise.all([
  import("../server/db/queries.js"),
  import("../server/db/client.js"),
  import("../server/agent/memory.js"),
]);

try {
  await warmupMemoryModel();
  const turns = Object.values(corpus.sessions).flatMap((session) => {
    ensureSession(session.id);
    return session.turns.map((turn) => ({ ...turn, session_id: session.id, entities_json: "[]" as const }));
  });
  for (const session of Object.values(corpus.sessions)) await deleteSessionIndex(session.id);
  for (const turn of turns) {
    const stored = insertTurnWithId(turn.session_id, turn.role, turn.text, turn.id, turn.ts);
    await indexTurn(stored);
    markTurnIndexed(stored.id, EMBEDDING_VERSION);
  }
  console.log(JSON.stringify({ corpus: corpusPath, sessions: Object.keys(corpus.sessions).length, turns: turns.length, indexed: turns.length }));
} finally {
  db.close();
}
