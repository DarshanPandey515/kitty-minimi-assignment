CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  ts            TEXT NOT NULL,
  role          TEXT NOT NULL,
  text          TEXT NOT NULL,
  entities_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_turns_session_ts ON turns(session_id, ts);

CREATE TABLE IF NOT EXISTS claims (
  id         TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL REFERENCES turns(id),
  entity     TEXT NOT NULL,
  attribute  TEXT NOT NULL,
  value      TEXT NOT NULL,
  source_url TEXT,
  as_of      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_entity_asof ON claims(entity, as_of DESC);
