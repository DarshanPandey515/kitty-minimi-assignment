import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? "./data/agent.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));

// CREATE TABLE IF NOT EXISTS does not evolve an existing SQLite database.
const turnColumns = new Set((db.prepare("PRAGMA table_info(turns)").all() as { name: string }[]).map((column) => column.name));
if (!turnColumns.has("embedding_status")) db.exec("ALTER TABLE turns ADD COLUMN embedding_status TEXT NOT NULL DEFAULT 'pending'");
if (!turnColumns.has("embedding_attempts")) db.exec("ALTER TABLE turns ADD COLUMN embedding_attempts INTEGER NOT NULL DEFAULT 0");
if (!turnColumns.has("embedding_retry_at")) db.exec("ALTER TABLE turns ADD COLUMN embedding_retry_at TEXT");
if (!turnColumns.has("embedding_model")) {
  db.exec("ALTER TABLE turns ADD COLUMN embedding_model TEXT");
  db.exec("UPDATE turns SET embedding_status = 'pending', embedding_retry_at = NULL");
}
if (!turnColumns.has("extraction_status")) db.exec("ALTER TABLE turns ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'");
if (!turnColumns.has("extraction_attempts")) db.exec("ALTER TABLE turns ADD COLUMN extraction_attempts INTEGER NOT NULL DEFAULT 0");
if (!turnColumns.has("extraction_retry_at")) db.exec("ALTER TABLE turns ADD COLUMN extraction_retry_at TEXT");
