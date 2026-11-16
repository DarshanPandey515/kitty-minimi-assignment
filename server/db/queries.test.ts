import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "kitty-memory-test-"));
process.env.DB_PATH = join(dir, "test.db");
const queries = await import("./queries.js");

test("date-range turn retrieval remains scoped to its session", () => {
  queries.ensureSession("session-a");
  queries.ensureSession("session-b");
  assert.equal(queries.sessionExists("session-a"), true);
  assert.equal(queries.sessionExists("missing-session"), false);
  queries.insertTurn("session-a", "user", "same date");
  queries.insertTurn("session-b", "user", "other session");
  const start = "2000-01-01T00:00:00.000Z";
  const end = "2999-01-01T00:00:00.000Z";
  assert.deepEqual(queries.turnsInRange("session-a", start, end).map((turn) => turn.session_id), ["session-a"]);
});

test("indexed turns record their embedding model and leave the pending queue", () => {
  queries.ensureSession("session-index");
  const turn = queries.insertTurn("session-index", "user", "Index this turn");
  const model = "Xenova/all-MiniLM-L6-v2@revision:q8:mean-normalized";
  queries.markTurnIndexed(turn.id, "legacy-model");
  assert.equal(queries.pendingTurns(model).some((pending) => pending.id === turn.id), true);
  queries.markTurnIndexed(turn.id, model);
  assert.equal(queries.pendingTurns(model).some((pending) => pending.id === turn.id), false);
});

test("benchmark seeding preserves explicit turn IDs and timestamps", () => {
  queries.ensureSession("session-seed");
  const turn = queries.insertTurnWithId("session-seed", "user", "seed text", "seed-turn-id", "2026-01-02T03:04:05.000Z");
  assert.equal(turn.id, "seed-turn-id");
  assert.equal(queries.getTurn(turn.id)?.ts, "2026-01-02T03:04:05.000Z");
});

test("conversation listing summarizes sessions and deletion removes their turns", () => {
  queries.ensureSession("session-delete");
  queries.insertTurn("session-delete", "user", "A conversation title");
  const listed = queries.listSessions().find((session) => session.id === "session-delete");
  assert.equal(listed?.title, "A conversation title");
  assert.equal(listed?.turn_count, 1);
  assert.equal(queries.deleteSession("session-delete"), true);
  assert.equal(queries.deleteSession("session-delete"), false);
  assert.deepEqual(queries.lastTurns("session-delete", 10), []);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
