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
  queries.insertTurn("session-a", "user", "same date");
  queries.insertTurn("session-b", "user", "other session");
  const start = "2000-01-01T00:00:00.000Z";
  const end = "2999-01-01T00:00:00.000Z";
  assert.deepEqual(queries.turnsInRange("session-a", start, end).map((turn) => turn.session_id), ["session-a"]);
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
