import { randomUUID } from "node:crypto";
import { db } from "./client.js";

export type Turn = { id: string; session_id: string; ts: string; role: "user" | "assistant"; text: string; entities_json: string };
export type Claim = { id: string; turn_id: string; entity: string; attribute: string; value: string; source_url: string | null; as_of: string };

export function ensureSession(id: string) {
  db.prepare("INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)").run(id, new Date().toISOString());
}

export function listSessions(limit = 100) {
  return db.prepare(`
    SELECT s.id,
      COALESCE((SELECT text FROM turns WHERE session_id = s.id AND role = 'user' ORDER BY ts, rowid LIMIT 1), 'New conversation') AS title,
      COALESCE(MAX(t.ts), s.created_at) AS updated_at,
      COUNT(t.id) AS turn_count
    FROM sessions s LEFT JOIN turns t ON t.session_id = s.id
    GROUP BY s.id ORDER BY updated_at DESC LIMIT ?
  `).all(limit) as { id: string; title: string; updated_at: string; turn_count: number }[];
}

export function deleteSession(id: string) {
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM claims WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)").run(id);
    db.prepare("DELETE FROM turns WHERE session_id = ?").run(id);
    return db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  });
  return remove();
}

function saveTurn(t: Turn): Turn {
  db.prepare("INSERT INTO turns (id, session_id, ts, role, text, entities_json) VALUES (@id, @session_id, @ts, @role, @text, @entities_json)").run(t);
  return t;
}

export function insertTurn(sessionId: string, role: Turn["role"], text: string): Turn {
  return insertTurnWithId(sessionId, role, text, randomUUID(), new Date().toISOString());
}

export function insertTurnWithId(sessionId: string, role: Turn["role"], text: string, id: string, ts: string): Turn {
  return saveTurn({ id, session_id: sessionId, ts, role, text, entities_json: "[]" });
}

export function getTurn(id: string): Turn | undefined {
  return db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as Turn | undefined;
}

/** Last n turns of a session, chronological. */
export function lastTurns(sessionId: string, n: number): Turn[] {
  const rows = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?").all(sessionId, n) as Turn[];
  return rows.reverse();
}

const RECALL_STOP_WORDS = new Set("about after again any are did do for from has have how i in is it me my of on or our since that the then there this time to today was we were what when where which who why with you your".split(" "));

export function searchTurns(sessionId: string, query: string, limit = 20): Turn[] {
  const timestamp = query.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)?.[0];
  if (timestamp) {
    const center = Date.parse(timestamp);
    if (!Number.isFinite(center)) return [];
    return db.prepare("SELECT * FROM turns WHERE session_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?")
      .all(sessionId, new Date(center - 120_000).toISOString(), new Date(center + 120_000).toISOString(), limit) as Turn[];
  }

  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    .filter((term) => !RECALL_STOP_WORDS.has(term));
  if (!terms.length) return [];
  const clauses = terms.map(() => "LOWER(text) LIKE ?").join(" OR ");
  const rows = db.prepare(`SELECT * FROM turns WHERE session_id = ? AND (${clauses}) ORDER BY ts DESC LIMIT 200`)
    .all(sessionId, ...terms.map((term) => `%${term}%`)) as Turn[];
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  return rows
    .sort((a, b) => {
      const score = (turn: Turn) => {
        const turnWords = words(turn.text);
        return terms.reduce((n, term) => n + Number(turnWords.has(term)), 0);
      };
      return score(b) - score(a) || b.ts.localeCompare(a.ts);
    })
    .slice(0, limit);
}

/** Turns in one session within [start, end]. */
export function turnsInRange(sessionId: string, start: string, end: string, limit = 40): Turn[] {
  return db.prepare("SELECT * FROM turns WHERE session_id = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC LIMIT ?").all(sessionId, start, end, limit) as Turn[];
}

export function turnsByIds(sessionId: string, ids: string[]): Turn[] {
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM turns WHERE session_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(sessionId, ...ids) as Turn[];
}

export type PendingTurn = Turn & { embedding_attempts: number };
export function pendingTurns(model: string, limit = 8): PendingTurn[] {
  return db.prepare("SELECT * FROM turns WHERE (embedding_status = 'pending' OR embedding_model IS NOT ?) AND (embedding_retry_at IS NULL OR embedding_retry_at <= ?) ORDER BY ts LIMIT ?")
    .all(model, new Date().toISOString(), limit) as PendingTurn[];
}

export function markTurnIndexed(id: string, model: string) {
  db.prepare("UPDATE turns SET embedding_status = 'indexed', embedding_model = ?, embedding_retry_at = NULL WHERE id = ?").run(model, id);
}

export function retryTurnIndex(id: string, attempts: number) {
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
  db.prepare("UPDATE turns SET embedding_attempts = embedding_attempts + 1, embedding_retry_at = ? WHERE id = ?")
    .run(new Date(Date.now() + delay).toISOString(), id);
}

export function claimsByEntities(entities: string[], limit = 20): Claim[] {
  if (!entities.length) return [];
  const ph = entities.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM claims WHERE entity COLLATE NOCASE IN (${ph}) ORDER BY as_of DESC LIMIT ?`).all(...entities, limit) as Claim[];
}

export function recentClaims(days: number, limit = 20): Claim[] {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return db.prepare("SELECT * FROM claims WHERE as_of >= ? ORDER BY as_of DESC LIMIT ?").all(since, limit) as Claim[];
}

export function claimsByEntityOrText(q: string, limit = 20): Claim[] {
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return db.prepare(
    "SELECT * FROM claims WHERE entity LIKE ? OR attribute LIKE ? OR value LIKE ? ORDER BY as_of DESC LIMIT ?"
  ).all(like, like, like, limit) as Claim[];
}

export function lastEntities(sessionId: string): string[] {
  const rows = db.prepare("SELECT entities_json FROM turns WHERE session_id = ? AND entities_json != '[]' ORDER BY ts DESC LIMIT 3").all(sessionId) as { entities_json: string }[];
  const set = new Set<string>();
  for (const r of rows) { try { for (const e of JSON.parse(r.entities_json)) set.add(e); } catch { /* ignore */ } }
  return [...set];
}

/** Idempotent per turn_id: replaces any previous extraction for the turn. */
export function writeExtraction(turnId: string, entities: string[], claims: Omit<Claim, "id" | "turn_id">[]) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE turns SET entities_json = ? WHERE id = ?").run(JSON.stringify(entities), turnId);
    db.prepare("DELETE FROM claims WHERE turn_id = ?").run(turnId);
    const ins = db.prepare("INSERT INTO claims (id, turn_id, entity, attribute, value, source_url, as_of) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const c of claims) ins.run(randomUUID(), turnId, c.entity, c.attribute, c.value, c.source_url, c.as_of);
  });
  tx();
}
