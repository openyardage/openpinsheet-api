// Tests for api/migrations: 0002 then 0003 on a database that already holds
// readers, keys and counters, the way the production D1 does, and 0005 on a
// pins table with a stored pin. node:sqlite stands in for D1, as in fakes.mjs.
//
// Run from openpinsheet/:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

function migration(name) {
  return readFileSync(fileURLToPath(new URL("../migrations/" + name, import.meta.url)), "utf8");
}

function before0003() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration("0002_readers.sql"));
  db.exec(
    "INSERT INTO readers (id, github_id, login, created) VALUES (1, 1, 'a', 't'), (2, 2, 'b', 't');"
    // Reader 1: two active keys with the same created, as two logins in the
    // same second could leave them. Reader 2: one active, one old.
    + "INSERT INTO reader_keys (key_sha256, reader_id, active, created) VALUES "
    + "('k1', 1, 1, '2027-01-01T00:00:00Z'), ('k2', 1, 1, '2027-01-01T00:00:00Z'), "
    + "('k3', 2, 1, '2027-01-02T00:00:00Z'), ('k4', 2, 0, '2027-01-05T00:00:00Z');"
    + "INSERT INTO reader_usage (key_sha256, day, count) VALUES ('k1', '2027-01-02', 5);",
  );
  return db;
}

test("0003 leaves one active key per reader, also on the same created", () => {
  const db = before0003();
  db.exec(migration("0003_reader_days.sql"));
  const active = db.prepare(
    "SELECT reader_id, COUNT(*) AS n FROM reader_keys WHERE active = 1 GROUP BY reader_id ORDER BY reader_id",
  ).all().map((row) => Object.assign({}, row));
  assert.deepEqual(active, [{ reader_id: 1, n: 1 }, { reader_id: 2, n: 1 }]);
  const kept = db.prepare("SELECT key_sha256 FROM reader_keys WHERE reader_id = 2 AND active = 1").get();
  assert.equal(kept.key_sha256, "k3", "the active key of reader 2 was swapped");
});

test("0003 builds the index, moves the counters and runs twice", () => {
  const db = before0003();
  db.exec(migration("0003_reader_days.sql"));
  db.exec(migration("0003_reader_days.sql"));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
    .all().map((row) => row.name);
  assert.ok(names.includes("reader_days"));
  assert.ok(names.includes("reader_keys_one_active"));
  assert.equal(names.includes("reader_usage"), false);
  assert.throws(() => db.exec(
    "INSERT INTO reader_keys (key_sha256, reader_id, active, created) VALUES ('k5', 2, 1, 't')",
  ), /UNIQUE/);
});

// 0005 on a pins table as it stood before, with a stored pin: the two columns
// are added empty, the pin stays, and the table then has the columns of
// schema.sql in the same order. The CREATE TABLE below is pins as of 0004.
function pinsBefore0005() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE pins (channel TEXT NOT NULL, grp TEXT NOT NULL, date TEXT NOT NULL, "
    + "hole TEXT NOT NULL, lat REAL, lon REAL, source TEXT, accuracy_m REAL, front_m REAL, "
    + "left_m REAL, input_front REAL, input_offset REAL, input_side TEXT, input_unit TEXT, "
    + "missing INTEGER NOT NULL DEFAULT 0, cell INTEGER, PRIMARY KEY (channel, grp, date, hole));"
    + "INSERT INTO pins (channel, grp, date, hole, lat, lon, source, missing) "
    + "VALUES ('openyardage', 'g1', '2027-04-12', '7', 52.1, 13.1, 'mapped', 0);",
  );
  return db;
}

function columnsOf(db) {
  return db.prepare("PRAGMA table_info(pins)").all()
    .map((row) => ({ name: row.name, type: row.type, notnull: row.notnull, pk: row.pk }));
}

test("0005 adds play_bearing_deg and correction and keeps the stored pins", () => {
  const db = pinsBefore0005();
  db.exec(migration("0005_bearing_correction.sql"));
  const pin = Object.assign({}, db.prepare("SELECT * FROM pins").get());
  assert.equal(pin.hole, "7");
  assert.equal(pin.play_bearing_deg, null);
  assert.equal(pin.correction, null);
  db.exec("UPDATE pins SET play_bearing_deg = 274.5, correction = 'rtk'");
  const updated = db.prepare("SELECT play_bearing_deg, correction FROM pins").get();
  assert.equal(updated.play_bearing_deg, 274.5);
  assert.equal(updated.correction, "rtk");
});

test("after 0005 the pins table has the columns of schema.sql", () => {
  const migrated = pinsBefore0005();
  migrated.exec(migration("0005_bearing_correction.sql"));
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  assert.deepEqual(columnsOf(migrated), columnsOf(fresh));
});
