-- OpenPinsheet API, migration 0002: keys for the live interface.
--
-- Readers log in with GitHub and get one key. Only the sha256 of the key is
-- stored; the GitHub token is never stored. `origins` is a JSON list of
-- allowed origins, or NULL for any origin. reader_usage counts the requests
-- per key and UTC day. Same tables as in schema.sql, safe to run twice.

CREATE TABLE IF NOT EXISTS readers (
  id INTEGER PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  created TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reader_keys (
  key_sha256 TEXT PRIMARY KEY,
  reader_id INTEGER NOT NULL REFERENCES readers(id),
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  origins TEXT,
  daily_limit INTEGER
);

CREATE TABLE IF NOT EXISTS reader_usage (
  key_sha256 TEXT,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (key_sha256, day)
);
