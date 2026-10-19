-- OpenPinsheet API, migration 0003: the limits count per reader, not per key.
--
-- reader_usage counted per key, so a new GitHub login, which issues a new key,
-- started the day again at 0. reader_days counts per reader. The old counters
-- are dropped last: they only enforce the limit of one day.
--
-- The unique index allows one active key per reader. Before it is made, every
-- active key but the newest of each reader is deactivated (newest by created,
-- then by rowid, so two keys with the same created keep exactly one), so the
-- index can be built where two logins at once left two. Safe to run twice.

CREATE TABLE IF NOT EXISTS reader_days (
  reader_id INTEGER,
  day TEXT,
  count INTEGER,
  PRIMARY KEY (reader_id, day)
);

UPDATE reader_keys SET active = 0
WHERE active = 1 AND rowid NOT IN (
  SELECT (
    SELECT keep.rowid FROM reader_keys AS keep
    WHERE keep.reader_id = readers_with_keys.reader_id AND keep.active = 1
    ORDER BY keep.created DESC, keep.rowid DESC LIMIT 1
  )
  FROM (SELECT DISTINCT reader_id FROM reader_keys WHERE active = 1) AS readers_with_keys
);

CREATE UNIQUE INDEX IF NOT EXISTS reader_keys_one_active ON reader_keys (reader_id) WHERE active = 1;

DROP TABLE IF EXISTS reader_usage;
