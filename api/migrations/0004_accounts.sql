-- OpenPinsheet API, migration 0004: accounts and self-service data partners.
--
-- A GitHub login now opens an account (table sessions). In the account a
-- reader rotates the key and may sign up as a data partner. Partners carry
-- their GitHub id, website and the time they accepted the terms. archive_from
-- holds back the pins of a new partner from the files until the operator has
-- reviewed it; the partners that exist today are reviewed, so they get the
-- earliest possible date. prefix shows the start of a key in the account.

ALTER TABLE channels ADD COLUMN website TEXT;
ALTER TABLE channels ADD COLUMN github_id INTEGER;
ALTER TABLE channels ADD COLUMN login TEXT;
ALTER TABLE channels ADD COLUMN terms TEXT;
ALTER TABLE channels ADD COLUMN archive_from TEXT;
ALTER TABLE channels ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
UPDATE channels SET archive_from = '0000-01-01' WHERE archive_from IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channels_github ON channels (github_id) WHERE github_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS channels_name ON channels (lower(name));

ALTER TABLE keys ADD COLUMN prefix TEXT;
ALTER TABLE reader_keys ADD COLUMN prefix TEXT;

CREATE TABLE IF NOT EXISTS sessions (
  token_sha256 TEXT PRIMARY KEY,
  reader_id INTEGER NOT NULL REFERENCES readers(id),
  csrf TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT NOT NULL
);
