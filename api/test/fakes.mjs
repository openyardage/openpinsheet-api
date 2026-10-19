// Test doubles for api/src/worker.js.
//
// env.DB answers like a D1 database: prepare(sql).bind(...).all()/first()/run()
// and batch([...]) atomically. env.BUCKET is an in-memory R2 bucket with
// put/get/head/list. Nothing here talks to a network or to a real service.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// D1 platform limits, measured at developers.cloudflare.com/d1/platform/limits
// on 17.10.2026: 50 statements per Worker invocation (every statement inside
// batch() counts on its own), at most 100 bound parameters per statement and
// at most 100 KB of SQL text. The fake enforces all three, so a regression
// turns red here and not only in production.
const MAX_STATEMENTS = 50;
const MAX_PARAMS = 100;
const MAX_SQL_BYTES = 100000;

export function hashKey(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

class D1Statement {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params || [];
  }

  bind(...params) {
    return new D1Statement(this.db, this.sql, params);
  }

  all() {
    return this._all();
  }

  first(column) {
    this._check();
    const row = this.db.db.prepare(this.sql).get(...this.params);
    if (!row) {
      return null;
    }
    const plain = Object.assign({}, row);
    if (typeof column === "string") {
      return plain[column] === undefined ? null : plain[column];
    }
    return plain;
  }

  run() {
    return this._run();
  }

  _check() {
    if (this.params.length > MAX_PARAMS) {
      throw new Error("D1 limit: " + this.params.length + " bound parameters in one statement, at most "
        + MAX_PARAMS + " are allowed");
    }
    if (this.sql.length > MAX_SQL_BYTES) {
      throw new Error("D1 limit: " + this.sql.length + " characters of SQL, at most "
        + MAX_SQL_BYTES + " are allowed");
    }
    this.db.statements += 1;
    this.db.maxParams = Math.max(this.db.maxParams, this.params.length);
    this.db.maxSqlLength = Math.max(this.db.maxSqlLength, this.sql.length);
    if (this.db.statements > MAX_STATEMENTS) {
      throw new Error("D1 limit: more than " + MAX_STATEMENTS + " statements in one Worker invocation");
    }
  }

  _all() {
    this._check();
    const rows = this.db.db.prepare(this.sql).all(...this.params).map((row) => Object.assign({}, row));
    return { success: true, results: rows, meta: { changes: 0 } };
  }

  _run() {
    this._check();
    const info = this.db.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(info.changes) || 0,
        last_row_id: Number(info.lastInsertRowid) || 0,
      },
    };
  }
}

class FakeD1 {
  constructor(db) {
    this.db = db;
    this.statements = 0;
    this.maxParams = 0;
    this.maxSqlLength = 0;
  }

  // One Worker invocation starts here. Tests call this before every fetch or
  // scheduled call, because D1 counts the statements of one invocation and
  // starts again at zero for the next.
  startInvocation() {
    this.statements = 0;
    this.maxParams = 0;
    this.maxSqlLength = 0;
  }

  prepare(sql) {
    return new D1Statement(this, sql, []);
  }

  batch(statements) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement._run());
      this.db.exec("COMMIT");
      return results;
    } catch (problem) {
      this.db.exec("ROLLBACK");
      throw problem;
    }
  }
}

function toBytes(body) {
  if (body instanceof Uint8Array) {
    return new Uint8Array(body);
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  throw new TypeError("a bucket body must be bytes or text");
}

class FakeBucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options) {
    const bytes = toBytes(body);
    const httpMetadata = options && options.httpMetadata ? Object.assign({}, options.httpMetadata) : {};
    this.objects.set(key, { body: bytes, httpMetadata });
    return { key, size: bytes.length, httpMetadata };
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    const bytes = object.body;
    return {
      key,
      size: bytes.length,
      httpMetadata: object.httpMetadata,
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async head(key) {
    const object = this.objects.get(key);
    if (!object) {
      return null;
    }
    return { key, size: object.body.length, httpMetadata: object.httpMetadata };
  }

  async list(prefix) {
    const wanted = prefix || "";
    const objects = Array.from(this.objects.keys())
      .filter((key) => key.startsWith(wanted))
      .sort()
      .map((key) => ({
        key,
        size: this.objects.get(key).body.length,
        httpMetadata: this.objects.get(key).httpMetadata,
      }));
    return { objects, truncated: false };
  }
}

export function createEnv(now) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    DB: new FakeD1(db),
    BUCKET: new FakeBucket(),
    NOW_ISO: now,
    // A Cloudflare rate limiting binding that lets everything through. A test
    // that wants the limit replaces this with { limit: async () => ({ success: false }) }.
    LIVE_LIMIT: { limit: async () => ({ success: true }) },
    SHARED_LIMIT: { limit: async () => ({ success: true }) },
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  };
}

// A reviewed data partner, like the ones the operator set up by hand. Pass
// archiveFrom null for a partner that signed up and waits for the review.
export function addChannel(env, id, name, archiveFrom) {
  env.DB.prepare("INSERT INTO channels (id, name, created, archive_from) VALUES (?, ?, ?, ?)")
    .bind(id, name, "2027-01-01T00:00:00Z", archiveFrom === undefined ? "0000-01-01" : archiveFrom).run();
}

export function addKey(env, channel, key, active) {
  env.DB.prepare("INSERT INTO keys (key_sha256, channel, active, created) VALUES (?, ?, ?, ?)")
    .bind(hashKey(key), channel, active === undefined ? 1 : active, "2027-01-01T00:00:00Z").run();
}

// A reader of the live interface. Returns the new row id.
export function addReader(env, githubId, login, active) {
  const result = env.DB.prepare(
    "INSERT INTO readers (github_id, login, created, active) VALUES (?, ?, ?, ?)",
  ).bind(githubId, login, "2027-01-01T00:00:00Z", active === undefined ? 1 : active).run();
  return result.meta.last_row_id;
}

export function addReaderKey(env, readerId, key, active, origins) {
  env.DB.prepare(
    "INSERT INTO reader_keys (key_sha256, reader_id, active, created, origins) "
    + "VALUES (?, ?, ?, ?, ?)",
  ).bind(hashKey(key), readerId, active === undefined ? 1 : active,
    "2027-01-01T00:00:00Z", origins === undefined ? null : origins).run();
}

// Set the daily counter of a reader, so a test reaches the limit without 1000 calls.
export function setUsage(env, readerId, day, count) {
  env.DB.prepare(
    "INSERT OR REPLACE INTO reader_days (reader_id, day, count) VALUES (?, ?, ?)",
  ).bind(readerId, day, count).run();
}

// The body of an error as worker.js sends it (RFC 9457, type about:blank).
export function problemOf(status, title, error, detail) {
  return { type: "about:blank", title, status, detail, error };
}

export { FakeBucket };
