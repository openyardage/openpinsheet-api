// Tests for the reader interface of api/src/worker.js: the key on GET
// /v1/live, the minute and day limits, and the GitHub login. The D1 database comes from
// api/test/fakes.mjs; GitHub itself is a faked fetch. Nothing touches a
// network.
//
// Run from openpinsheet/ with a glob:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { addReader, addReaderKey, createEnv, hashKey, problemOf, setUsage } from "./fakes.mjs";

const BASE = "https://api.openpinsheet.com";
const READER_KEY = "opr_test_reader_key";
const BBOX = "12.9,51.9,13.1,52.1";
const NOW = "2027-04-12T12:00:00Z";
const TOKEN = "gho_secret_token";

function setup(now = NOW) {
  const env = createEnv(now);
  const reader = addReader(env, 4242, "reader", 1);
  addReaderKey(env, reader, READER_KEY, 1, null);
  return env;
}

// The reader behind READER_KEY: the day counter is per reader, not per key.
function readerOf(env) {
  return env.DB.prepare("SELECT reader_id FROM reader_keys WHERE key_sha256 = ?")
    .bind(hashKey(READER_KEY)).first("reader_id");
}

function liveRequest(key, options = {}) {
  const headers = {};
  if (key !== undefined) {
    headers.Authorization = "Bearer " + key;
  }
  Object.assign(headers, options.headers || {});
  return new Request(BASE + "/v1/live?bbox=" + encodeURIComponent(options.bbox || BBOX), { headers });
}

function getLive(env, key, options) {
  env.DB.startInvocation();
  return worker.fetch(liveRequest(key, options), env);
}

test("live without a key is 401 unauthorized and counts nothing", async () => {
  const env = setup();
  const response = await getLive(env, undefined);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(),
    problemOf(401, "Unauthorized", "unauthorized", "a valid key is required in the header Authorization: Bearer"));
  const usage = await env.DB.prepare("SELECT COUNT(*) AS n FROM reader_days").first();
  assert.equal(usage.n, 0);
});

test("live with a key is 200 and carries the daily headers", async () => {
  const env = setup();
  const response = await getLive(env, READER_KEY);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "1000");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "999");
  const data = await response.json();
  assert.equal(data.features.length, 0);
});

test("an unknown or inactive key is 401", async () => {
  const env = setup();
  const unknown = await getLive(env, "opr_nope");
  assert.equal(unknown.status, 401);

  addReaderKey(env, 1, "opr_inactive", 0, null);
  const inactive = await getLive(env, "opr_inactive");
  assert.equal(inactive.status, 401);

  const blockedReader = addReader(env, 5555, "blocked", 0);
  addReaderKey(env, blockedReader, "opr_blocked", 1, null);
  const blocked = await getLive(env, "opr_blocked");
  assert.equal(blocked.status, 401);
});

test("a key in the query string is refused: it would land in logs and history", async () => {
  const env = setup();
  env.DB.startInvocation();
  const response = await worker.fetch(
    new Request(BASE + "/v1/live?bbox=" + encodeURIComponent(BBOX) + "&key=" + READER_KEY),
    env,
  );
  assert.equal(response.status, 401);
});

test("the old header X-API-Key is refused", async () => {
  const env = setup();
  env.DB.startInvocation();
  const response = await worker.fetch(
    new Request(BASE + "/v1/live?bbox=" + encodeURIComponent(BBOX), { headers: { "X-API-Key": READER_KEY } }),
    env,
  );
  assert.equal(response.status, 401);
});

test("a key with origins refuses a foreign Origin with 403", async () => {
  const env = setup();
  const reader = addReader(env, 4747, "origin", 1);
  addReaderKey(env, reader, "opr_origin", 1, '["https://ok.example"]');

  const foreign = await getLive(env, "opr_origin", { headers: { Origin: "https://bad.example" } });
  assert.equal(foreign.status, 403);
  assert.equal((await foreign.json()).error, "origin_not_allowed");
  assert.equal(foreign.headers.get("Access-Control-Allow-Origin"), "*");

  const allowed = await getLive(env, "opr_origin", { headers: { Origin: "https://ok.example" } });
  assert.equal(allowed.status, 200);

  const noOrigin = await getLive(env, "opr_origin");
  assert.equal(noOrigin.status, 200);
});

test("the faked rate limiting binding turns a request into 429", async () => {
  const env = setup();
  setUsage(env, await readerOf(env), "2027-04-12", 7);
  env.LIVE_LIMIT = { limit: async () => ({ success: false }) };
  const response = await getLive(env, READER_KEY);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(response.headers.get("Retry-After"), "60");
  // The minute 429 carries the day values too, without counting itself.
  assert.equal(response.headers.get("X-RateLimit-Limit"), "1000");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "993");
});

test("a browser may read the limit headers: CORS exposes them", async () => {
  const env = setup();
  const response = await getLive(env, READER_KEY);
  const exposed = response.headers.get("Access-Control-Expose-Headers").split(", ");
  for (const name of ["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "ETag"]) {
    assert.ok(exposed.includes(name), name);
  }
});

test("X-RateLimit-Reset is the next 00:00 UTC in Unix seconds", async () => {
  const env = setup();
  const response = await getLive(env, READER_KEY);
  assert.equal(response.headers.get("X-RateLimit-Reset"), String(Date.UTC(2027, 3, 13) / 1000));
});

test("a malformed or too large bbox costs no request of the day", async () => {
  const env = setup();
  for (const bbox of ["1,2,3", "12,51,13,52"]) {
    const response = await getLive(env, READER_KEY, { bbox });
    assert.equal(response.status, 400, bbox);
    assert.equal(response.headers.get("X-RateLimit-Remaining"), null, bbox);
  }
  const usage = await env.DB.prepare("SELECT COUNT(*) AS n FROM reader_days").first();
  assert.equal(usage.n, 0);
});

test("a matching If-None-Match is 304 without a body, a weak one too", async () => {
  const env = setup();
  const first = await getLive(env, READER_KEY);
  const tag = first.headers.get("ETag");
  assert.match(tag, /^"[0-9a-f]{32}"$/);
  for (const sent of [tag, "W/" + tag, "\"other\", " + tag]) {
    const again = await getLive(env, READER_KEY, { headers: { "If-None-Match": sent } });
    assert.equal(again.status, 304, sent);
    assert.equal(again.headers.get("ETag"), tag, sent);
    assert.equal(again.headers.get("Cache-Control"), "private, max-age=300", sent);
    assert.equal(await again.text(), "", sent);
  }
  const other = await getLive(env, READER_KEY, { headers: { "If-None-Match": "\"other\"" } });
  assert.equal(other.status, 200);
});

test("a key with origins counts the minute limit per visitor, a plain key per key", async () => {
  const env = setup();
  const seen = [];
  env.LIVE_LIMIT = { limit: async ({ key }) => { seen.push(key); return { success: true }; } };
  const reader = addReader(env, 4848, "shared", 1);
  addReaderKey(env, reader, "opr_shared", 1, '["https://ok.example"]');

  await getLive(env, "opr_shared", { headers: { Origin: "https://ok.example", "CF-Connecting-IP": "203.0.113.7" } });
  await getLive(env, "opr_shared", { headers: { Origin: "https://ok.example", "CF-Connecting-IP": "203.0.113.8" } });
  await getLive(env, READER_KEY, { headers: { "CF-Connecting-IP": "203.0.113.7" } });

  assert.equal(seen.length, 3);
  assert.equal(seen[0], "reader:" + reader + ":203.0.113.7");
  assert.equal(seen[1], "reader:" + reader + ":203.0.113.8");
  assert.equal(seen[2], "reader:" + (await readerOf(env)));
});

// The ceiling of a key with origins: a second binding behind the visitor
// limit. A copied shared key cannot get past it by rotating the IP.
test("a shared key is 429 rate_limited once SHARED_LIMIT says no, also from a new IP", async () => {
  const env = setup();
  const liveKeys = [];
  env.LIVE_LIMIT = { limit: async ({ key }) => { liveKeys.push(key); return { success: true }; } };
  const sharedKeys = [];
  env.SHARED_LIMIT = { limit: async ({ key }) => { sharedKeys.push(key); return { success: false }; } };
  const reader = addReader(env, 4949, "shared", 1);
  addReaderKey(env, reader, "opr_shared", 1, '["https://ok.example"]');

  const response = await getLive(env, "opr_shared", {
    headers: { Origin: "https://ok.example", "CF-Connecting-IP": "203.0.113.9" },
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(response.headers.get("Retry-After"), "60");
  // The refusal came from the ceiling, not from the visitor limit: the minute
  // limit saw this new IP and let it through.
  assert.deepEqual(liveKeys, ["reader:" + reader + ":203.0.113.9"]);
  assert.deepEqual(sharedKeys, ["reader:" + reader]);
});

test("a plain key never asks SHARED_LIMIT", async () => {
  const env = setup();
  const sharedKeys = [];
  env.SHARED_LIMIT = { limit: async ({ key }) => { sharedKeys.push(key); return { success: false }; } };
  const response = await getLive(env, READER_KEY);
  assert.equal(response.status, 200);
  assert.deepEqual(sharedKeys, []);
});

test("a refused visitor limit does not spend the shared ceiling", async () => {
  const env = setup();
  env.LIVE_LIMIT = { limit: async () => ({ success: false }) };
  const sharedKeys = [];
  env.SHARED_LIMIT = { limit: async ({ key }) => { sharedKeys.push(key); return { success: true }; } };
  const reader = addReader(env, 5050, "shared", 1);
  addReaderKey(env, reader, "opr_shared", 1, '["https://ok.example"]');

  const response = await getLive(env, "opr_shared", {
    headers: { Origin: "https://ok.example", "CF-Connecting-IP": "203.0.113.9" },
  });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.deepEqual(sharedKeys, []);
});

test("the shared ceiling also guards /v1/pins", async () => {
  const env = setup();
  env.SHARED_LIMIT = { limit: async () => ({ success: false }) };
  const reader = addReader(env, 5151, "shared", 1);
  addReaderKey(env, reader, "opr_shared", 1, '["https://ok.example"]');

  const params = new URLSearchParams({ bbox: BBOX, from: "2027-04-01", to: "2027-04-05" });
  env.DB.startInvocation();
  const response = await worker.fetch(new Request(BASE + "/v1/pins?" + params.toString(), {
    headers: { Authorization: "Bearer opr_shared", Origin: "https://ok.example", "CF-Connecting-IP": "203.0.113.9" },
  }), env);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "rate_limited");
  assert.equal(response.headers.get("Retry-After"), "60");
});

test("without a SHARED_LIMIT binding a shared key still works", async () => {
  const env = setup();
  delete env.SHARED_LIMIT;
  const reader = addReader(env, 5252, "shared", 1);
  addReaderKey(env, reader, "opr_shared", 1, '["https://ok.example"]');

  const response = await getLive(env, "opr_shared", {
    headers: { Origin: "https://ok.example", "CF-Connecting-IP": "203.0.113.9" },
  });
  assert.equal(response.status, 200);
});

test("the 1001st request of the day is 429 daily_limit", async () => {
  const env = setup();
  setUsage(env, readerOf(env), NOW.slice(0, 10), 1000);
  const response = await getLive(env, READER_KEY);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "daily_limit");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "1000");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "0");
  // 12:00 UTC, so twelve hours to midnight.
  assert.equal(response.headers.get("Retry-After"), "43200");
});

function fakeGithub(t) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify({ access_token: TOKEN }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (String(url) === "https://api.github.com/user") {
      return new Response(JSON.stringify({ id: 7777, login: "octo" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error("unexpected fetch to " + url);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function callback(env, state, cookie) {
  env.DB.startInvocation();
  return worker.fetch(new Request(BASE + "/v1/auth/github/callback?code=abc&state=" + state, {
    headers: cookie === null ? {} : { Cookie: "ops_state=" + cookie },
  }), env);
}

// The cookies of a login answer, by name.
function setCookies(response) {
  const out = {};
  for (const line of response.headers.getSetCookie()) {
    const name = line.slice(0, line.indexOf("="));
    out[name] = line;
  }
  return out;
}

// A login through the faked GitHub: the session cookie, the csrf token of the
// account forms, and the page.
async function login(env) {
  const response = await callback(env, "st", "st");
  const cookies = setCookies(response);
  const token = /^ops_session=([^;]+)/.exec(cookies.ops_session)[1];
  const body = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(body)[1];
  return { cookie: "ops_session=" + token, csrf, body, response };
}

function postAccount(env, path, session, fields) {
  env.DB.startInvocation();
  return worker.fetch(new Request(BASE + path, {
    method: "POST",
    headers: { Cookie: session.cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(Object.assign({ csrf: session.csrf }, fields || {})).toString(),
  }), env);
}

test("the start redirects to GitHub with state in the cookie and the URL", async () => {
  const env = setup();
  env.DB.startInvocation();
  const response = await worker.fetch(new Request(BASE + "/v1/auth/github"), env);
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("Location"));
  assert.equal(location.origin + location.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "test-client-id");
  assert.equal(location.searchParams.get("redirect_uri"), "https://api.openpinsheet.com/v1/auth/github/callback");
  assert.equal(location.searchParams.get("scope"), "");
  const state = location.searchParams.get("state");
  assert.ok(state && state.length >= 20, "no state in the URL");
  assert.match(response.headers.get("Set-Cookie"), new RegExp("ops_state=" + state));
  assert.match(response.headers.get("Set-Cookie"), /HttpOnly/);
  assert.match(response.headers.get("Set-Cookie"), /Secure/);
  assert.match(response.headers.get("Set-Cookie"), /SameSite=Lax/);
});

test("a wrong state is 400 and the code is never traded", async (t) => {
  const env = setup();
  const calls = fakeGithub(t);
  const response = await callback(env, "state-in-url", "state-in-cookie");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_state");
  assert.equal(calls.length, 0, "GitHub was called despite the bad state");

  const noCookie = await callback(env, "state", null);
  assert.equal(noCookie.status, 400);
});

test("a key with its own daily_limit uses it instead of 1000", async () => {
  const env = setup();
  env.DB.prepare("UPDATE reader_keys SET daily_limit = 50000 WHERE key_sha256 = ?")
    .bind(hashKey(READER_KEY)).run();
  setUsage(env, readerOf(env), NOW.slice(0, 10), 1000);
  const response = await getLive(env, READER_KEY);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RateLimit-Limit"), "50000");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "48999");
});

test("the login sets the account cookie and drops the state cookie", async (t) => {
  const env = setup();
  fakeGithub(t);
  const response = await callback(env, "same-state", "same-state");
  assert.equal(response.status, 200);
  const cookies = setCookies(response);
  assert.match(cookies.ops_state, /^ops_state=;.*Max-Age=0/);
  assert.match(cookies.ops_session, /^ops_session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/v1\/account; Max-Age=2592000$/);
  const token = /^ops_session=([^;]+)/.exec(cookies.ops_session)[1];
  const stored = await env.DB.prepare("SELECT token_sha256 FROM sessions").all();
  assert.deepEqual(stored.results.map((row) => row.token_sha256), [hashKey(token)]);
});

test("a good callback makes a reader and a key and drops the GitHub token", async (t) => {
  const env = setup();
  fakeGithub(t);
  const response = await callback(env, "same-state", "same-state");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Security-Policy"), /default-src 'none'/);
  const body = await response.text();
  const match = /opr_[A-Za-z0-9_-]+/.exec(body);
  assert.ok(match, "no key in the page");
  const key = match[0];

  const reader = await env.DB.prepare("SELECT id, login, active FROM readers WHERE github_id = ?")
    .bind(7777).first();
  assert.ok(reader, "the reader row is missing");
  assert.equal(reader.login, "octo");
  assert.equal(reader.active, 1);

  const keyRow = await env.DB.prepare(
    "SELECT reader_id, active, origins FROM reader_keys WHERE key_sha256 = ?",
  ).bind(hashKey(key)).first();
  assert.ok(keyRow, "the key row is missing");
  assert.equal(keyRow.reader_id, reader.id);
  assert.equal(keyRow.active, 1);
  assert.equal(keyRow.origins, null);

  // The token and the raw key are nowhere in the two tables.
  const rows = await env.DB.prepare("SELECT * FROM readers").all();
  const keyRows = await env.DB.prepare("SELECT * FROM reader_keys").all();
  const dump = JSON.stringify(rows.results) + JSON.stringify(keyRows.results);
  assert.equal(dump.includes(TOKEN), false, "the GitHub token was stored");
  assert.equal(dump.includes(key), false, "the raw key was stored");
});

test("a second login keeps the key and shows no new one", async (t) => {
  const env = setup();
  const reader = addReader(env, 7777, "octo", 1);
  addReaderKey(env, reader, "opr_old_key", 1, null);
  fakeGithub(t);
  const session = await login(env);
  assert.equal(/opr_[A-Za-z0-9_-]{20,}/.test(session.body), false, "a full key was shown");
  const old = await env.DB.prepare("SELECT active FROM reader_keys WHERE key_sha256 = ?")
    .bind(hashKey("opr_old_key")).first();
  assert.equal(old.active, 1, "the login replaced the key");
  const readers = await env.DB.prepare("SELECT COUNT(*) AS n FROM readers WHERE github_id = 7777").first();
  assert.equal(readers.n, 1, "a second reader was made");
});

test("New key in the account replaces the key and keeps the day's count and the minute limit", async (t) => {
  const env = setup();
  const reader = addReader(env, 7777, "octo", 1);
  addReaderKey(env, reader, "opr_old_key", 1, null);
  setUsage(env, reader, NOW.slice(0, 10), 1000);
  const keys = [];
  env.LIVE_LIMIT = {
    limit: async (options) => {
      keys.push(options.key);
      return { success: true };
    },
  };
  fakeGithub(t);
  const session = await login(env);
  const page = await postAccount(env, "/v1/account/reader-key", session);
  assert.equal(page.status, 200);
  const key = /opr_[A-Za-z0-9_-]{43}/.exec(await page.text())[0];

  const old = await env.DB.prepare("SELECT active FROM reader_keys WHERE key_sha256 = ?")
    .bind(hashKey("opr_old_key")).first();
  assert.equal(old.active, 0, "the old key stayed active");
  const fresh = await env.DB.prepare("SELECT active, prefix FROM reader_keys WHERE key_sha256 = ?")
    .bind(hashKey(key)).first();
  assert.deepEqual(fresh, { active: 1, prefix: key.slice(0, 12) });
  const response = await getLive(env, key);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "daily_limit");
  assert.deepEqual(keys, ["reader:" + reader]);
});

test("a form without the right csrf token changes nothing", async (t) => {
  const env = setup();
  const reader = addReader(env, 7777, "octo", 1);
  addReaderKey(env, reader, "opr_old_key", 1, null);
  fakeGithub(t);
  const session = await login(env);
  const page = await postAccount(env, "/v1/account/reader-key", { cookie: session.cookie, csrf: "wrong" });
  assert.equal(page.status, 403);
  const old = await env.DB.prepare("SELECT active FROM reader_keys WHERE key_sha256 = ?")
    .bind(hashKey("opr_old_key")).first();
  assert.equal(old.active, 1);
});

test("the schema allows one active key per reader", async () => {
  const env = setup();
  const reader = addReader(env, 7777, "octo", 1);
  addReaderKey(env, reader, "opr_first", 1, null);
  assert.throws(() => addReaderKey(env, reader, "opr_second", 1, null), /UNIQUE/);
  addReaderKey(env, reader, "opr_retired", 0, null);
});

test("New key keeps origins and daily_limit of the old key", async (t) => {
  const env = setup();
  const reader = addReader(env, 7777, "octo", 1);
  addReaderKey(env, reader, "opr_shared", 1, '["https://club.example"]');
  env.DB.prepare("UPDATE reader_keys SET daily_limit = 50000 WHERE key_sha256 = ?")
    .bind(hashKey("opr_shared")).run();
  setUsage(env, reader, NOW.slice(0, 10), 1000);
  fakeGithub(t);
  const session = await login(env);
  const page = await postAccount(env, "/v1/account/reader-key", session);
  const key = /opr_[A-Za-z0-9_-]{43}/.exec(await page.text())[0];

  const row = await env.DB.prepare(
    "SELECT origins, daily_limit FROM reader_keys WHERE key_sha256 = ?",
  ).bind(hashKey(key)).first();
  assert.deepEqual(row, { origins: '["https://club.example"]', daily_limit: 50000 });
  const response = await getLive(env, key, { headers: { Origin: "https://club.example" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "48999");
});

test("a blocked reader gets no key, only a 403 page", async (t) => {
  const env = setup();
  const blocked = addReader(env, 7777, "blocked", 0);
  fakeGithub(t);
  const response = await worker.fetch(new Request(BASE + "/v1/auth/github/callback?code=abc&state=st", {
    headers: { Cookie: "ops_state=st" },
  }), env);
  assert.equal(response.status, 403);
  const keys = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reader_keys WHERE reader_id = ?",
  ).bind(blocked).first();
  assert.equal(keys.n, 0, "a key was made for a blocked reader");
});

test("the login answers 503 when the GitHub settings are missing", async () => {
  const env = setup();
  delete env.GITHUB_CLIENT_ID;
  const start = await worker.fetch(new Request(BASE + "/v1/auth/github"), env);
  assert.equal(start.status, 503);
  assert.equal((await start.json()).error, "not_configured");

  const call = await callback(env, "st", "st");
  assert.equal(call.status, 503);
});

test("the nightly run drops day counters older than 30 days", async () => {
  const env = setup();
  setUsage(env, readerOf(env), "2027-03-01", 5);
  setUsage(env, readerOf(env), "2027-03-20", 7);
  setUsage(env, readerOf(env), NOW.slice(0, 10), 9);
  await worker.scheduled({}, env);
  const rows = await env.DB.prepare("SELECT day FROM reader_days ORDER BY day").all();
  assert.deepEqual(rows.results.map((row) => row.day), ["2027-03-20", NOW.slice(0, 10)]);
});
