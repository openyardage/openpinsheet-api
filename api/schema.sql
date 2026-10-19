-- OpenPinsheet API, D1 schema, version 1.
--
-- API.md 4: per pin the data partner, the group, the date and the columns of
-- FORMAT.md 2. No time of day outside visible_from, no IP address, no names.
-- The two-active-key rule of API.md 3 is enforced by the administration script,
-- not by this schema.

-- A data partner. Partners who sign up in the account (API.md 3) carry the
-- GitHub id of their account, their website and when they accepted the terms.
-- archive_from is the first date whose pins go into the files: NULL until the
-- operator has reviewed the partner, then the earliest day still open at the
-- review. Pins of earlier days stay in the database and out of the archive,
-- because a published day file never changes. blocked = 1 stops the partner:
-- no key works, the account issues none, and a review cannot undo it.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created TEXT NOT NULL,
  website TEXT,
  github_id INTEGER,
  login TEXT,
  terms TEXT,
  archive_from TEXT,
  blocked INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX channels_github ON channels (github_id) WHERE github_id IS NOT NULL;
CREATE UNIQUE INDEX channels_name ON channels (lower(name));

CREATE TABLE keys (
  key_sha256 TEXT PRIMARY KEY,
  channel TEXT NOT NULL REFERENCES channels(id),
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  prefix TEXT
);

-- cell is the coarse 0.1 degree cell of a pin:
--
--   cell = floor(lat * 10) * 10000 + floor(lon * 10) + 1800
--
-- The longitude part lies in 0..3600 because floor(lon * 10) lies in
-- -1800..1800 and the offset is 1800. That is below the latitude step of
-- 10000, so each (lat, lon) pair maps to one cell also for negative
-- coordinates. NULL means the pin has no coordinate (a lost position).
CREATE TABLE pins (
  channel TEXT NOT NULL,
  grp TEXT NOT NULL,
  date TEXT NOT NULL,
  hole TEXT NOT NULL,
  lat REAL,
  lon REAL,
  source TEXT,
  accuracy_m REAL,
  front_m REAL,
  left_m REAL,
  input_front REAL,
  input_offset REAL,
  input_side TEXT,
  input_unit TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  cell INTEGER,
  play_bearing_deg REAL,
  correction TEXT,
  PRIMARY KEY (channel, grp, date, hole)
);

CREATE INDEX pins_cell_date ON pins (cell, date);

CREATE TABLE days (
  channel TEXT NOT NULL,
  grp TEXT NOT NULL,
  date TEXT NOT NULL,
  visible_from TEXT NOT NULL,
  PRIMARY KEY (channel, grp, date)
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  date TEXT,
  year TEXT,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  rows INTEGER NOT NULL
);

-- One key and value. `dirty` = 1 while years and index.json still have to be
-- written after a day file was entered. A run that stops between the day file
-- and the index leaves it at 1, and the next run rebuilds both.
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT
);

INSERT INTO state (key, value) VALUES ('dirty', '0');

-- Readers of the live interface. One reader is one GitHub account. `active` is
-- 0 for a blocked account, which then gets no key. The GitHub token is never
-- stored, only the id and the login name.
CREATE TABLE readers (
  id INTEGER PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  created TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- One key per reader at a time: the first login issues it, "New key" in the
-- account replaces it. Only the sha256 of the key is stored, never the key
-- itself; `prefix` is its first 12 characters, shown in the account. `origins`
-- is a JSON list of allowed origins, or NULL for any origin. `daily_limit`
-- overrides the default of 1000 a day, for a key many visitors share (a
-- website that reads live pins in the browser).
CREATE TABLE reader_keys (
  key_sha256 TEXT PRIMARY KEY,
  reader_id INTEGER NOT NULL REFERENCES readers(id),
  active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL,
  origins TEXT,
  daily_limit INTEGER,
  prefix TEXT
);

-- At most one active key per reader. The login deactivates and inserts in one
-- batch; this index makes a second active key fail instead of slipping in.
CREATE UNIQUE INDEX reader_keys_one_active ON reader_keys (reader_id) WHERE active = 1;

-- One row per reader and UTC day. Per reader and not per key, so a new login
-- does not reset the count. The daily limit of API.md is 1000.
CREATE TABLE reader_days (
  reader_id INTEGER,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (reader_id, day)
);

-- A signed-in account (API.md 3). The cookie carries a random token; only its
-- sha256 is stored. csrf is the token every form of the account sends back.
-- The nightly run deletes expired rows.
CREATE TABLE sessions (
  token_sha256 TEXT PRIMARY KEY,
  reader_id INTEGER NOT NULL REFERENCES readers(id),
  csrf TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT NOT NULL
);
