// OpenPinsheet API worker, version 1.
//
// ES module worker: `export default { fetch, scheduled }`. The rules live in
// core.js; this file only speaks HTTP, reads and writes D1, and puts the files
// of FORMAT.md 4.3 into R2. See API.md for the interface.
//
// Bindings: env.DB (D1), env.BUCKET (R2). The clock is env.NOW_ISO when set
// (tests only), otherwise the current time. No line written here carries a
// key, a body or an IP address.

import {
  checkSubmission,
  dayCsv,
  dayGeojson,
  historyGeojson,
  indexJson,
  isClosed,
  liveGeojson,
  parseDate,
  selectLive,
  visibleFrom,
  yearCsv,
} from "./core.js";
import { parseUpload } from "./upload.js";
import { computePartnerStats, renderPartnerStats } from "./partnerstats.js";

const encoder = new TextEncoder();
const MAX_BODY = 65536;
const MAX_BOX = 0.5;
// D1 counts every statement of a batch on its own and allows 50 per Worker
// invocation (measured 17.10.2026). The nightly run stays far below that: at
// most five days are written per run, the rest follows on the next run. A
// submission needs five statements. Dates go in over json_each, so no IN list
// grows with the data; the live box yields at most 36 cells and stays below
// the 90 parameters an IN list is allowed to carry.
const MAX_DAYS_PER_RUN = 5;
const DAY_MS = 86400000;
const CELL_OFFSET = 1800;
const DAY_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=300";
// The live answer hangs on the key and carries the X-RateLimit values of one
// reader, so it must not land in a shared cache: that could hand it to a
// request without a key. The reader's browser may keep it for five minutes.
const LIVE_CACHE = "private, max-age=300";
// A closed day does not change, so the browser may keep a history answer for a
// day. Private for the same reason as LIVE_CACHE.
const HISTORY_CACHE = "private, max-age=86400";

// The two read endpoints of API.md 2 answer the same CORS headers. A browser
// shows a script only the headers named in Expose-Headers besides a short safe
// list (Fetch standard); without it a page never saw its own limits.
// X-API-Key is the old reader header, accepted until OpenYardage sends Bearer.
const CORS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, X-API-Key",
  "Access-Control-Expose-Headers": "ETag, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
});
// Two hours is the most Chromium keeps a preflight; Firefox allows a day.
const PREFLIGHT_MAX_AGE = "7200";

// The live interface of API.md 2 needs a key since 18.10.2026. A reader logs in
// with GitHub; only one key per reader is active at a time. The limits are per
// reader and not per key, so a new login does not buy a fresh day: 30 requests
// a minute (Cloudflare rate limiting binding) and 1000 a UTC day (reader_days).
// The day files stay open to everyone.
const DAILY_LIMIT = 1000;
const UNREVIEWED_GROUPS = 20;
const USAGE_KEEP_DAYS = 30;
const RATE_RETRY_AFTER = "60";
const AUTH_CALLBACK = "https://api.openpinsheet.com/v1/auth/github/callback";
const AUTH_COOKIE = "ops_state";
const AUTH_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const USER_AGENT = "OpenPinsheet";
const KEY_PREFIX = "opr_";
const PARTNER_PREFIX = "opp_";
const SHOWN_PREFIX = 12;
const SESSION_COOKIE = "ops_session";
const SESSION_DAYS = 30;
const ACCOUNT_PATH = "/v1/account";
const MAX_UPLOAD = 1048576;
const REVIEW_URL = "https://api.openpinsheet.com/v1/review";
const REVIEW_FROM = "partners@openpinsheet.com";
const REVIEW_TO = "info@openyardage.com";
const RESERVED_CHANNELS = Object.freeze(["openpinsheet", "admin", "api", "test", "example"]);
const CREDIT_URL = "https://openpinsheet.com/#credit";
// The account pages load the stylesheet, fonts and icon of openpinsheet.com;
// their forms post only to this origin.
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline' https://openpinsheet.com; "
  + "font-src https://openpinsheet.com; img-src https://openpinsheet.com; "
  + "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

// The error texts are fixed. The unauthorized text never depends on whether
// the key was missing, unknown or revoked (API.md 1.5); it names the header,
// so a reader who sent the key in the query string learns why.
const MESSAGES = Object.freeze({
  unauthorized: "a valid key is required in the header Authorization: Bearer",
  body_too_large: "the body is larger than 64 KiB",
  invalid_json: "the body is not JSON",
  invalid_submission: "the submission has problems",
  day_closed: "the day is closed",
  invalid_bbox: "bbox must be west,south,east,north",
  bbox_too_large: "bbox is larger than 0.5 by 0.5 degrees",
  invalid_request: "group and date are required",
  invalid_dry_run: "dry_run must be true or false",
  not_found: "no such path",
  method_not_allowed: "method not allowed",
  internal_error: "the request could not be completed",
});

// The reader interface adds its own codes. They are kept apart from MESSAGES
// so the openapi check of the old eleven codes stays as it was; the API page
// and the spec move after their own order.
const READER_MESSAGES = Object.freeze({
  origin_not_allowed: "the key is not allowed for this origin",
  rate_limited: "too many requests, try again in a minute",
  daily_limit: "the daily limit of this key is reached",
  not_configured: "the live API is not configured on this server",
  invalid_state: "the login could not be verified, start again",
  github_error: "the GitHub login could not be completed",
  invalid_range: "from and to must be dates, from not after to, at most 31 days",
  range_not_closed: "to must be a closed day; today's pins come from /v1/live",
  partner_limit: "a data partner waiting for review delivers at most 20 grounds a day",
});

function nowDate(env) {
  const raw = env ? env.NOW_ISO : undefined;
  if (raw) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return new Date();
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(day, days) {
  const parts = parseDate(day);
  return new Date(Date.UTC(parts.y, parts.m - 1, parts.d) + days * DAY_MS)
    .toISOString().slice(0, 10);
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}),
  });
}

// The reason phrases of RFC 9110, 15. A problem of type about:blank carries
// the phrase of its status as title (RFC 9457, 4.2.1).
const STATUS_TITLES = Object.freeze({
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Content Too Large",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
});

// An error as RFC 9457 problem details. `error` is the fixed code a client
// branches on and `problems` the list of a rejected submission, both extension
// members; `detail` is the fixed sentence of the code. type stays about:blank:
// the code says what a type URI would, and no page behind such a URI exists.
function problemBody(status, code, extra) {
  const detail = MESSAGES[code] !== undefined ? MESSAGES[code] : READER_MESSAGES[code];
  return Object.assign({
    type: "about:blank",
    title: STATUS_TITLES[status],
    status,
    detail,
    error: code,
  }, extra || {});
}

function problemResponse(status, body, headers) {
  const base = { "Content-Type": "application/problem+json" };
  // RFC 9110, 15.5.2: a 401 names the scheme it wants.
  if (status === 401) {
    base["WWW-Authenticate"] = "Bearer realm=\"openpinsheet\"";
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign(base, headers || {}),
  });
}

function error(status, code, headers, extra) {
  return problemResponse(status, problemBody(status, code, extra), headers);
}

// RFC 9110, 15.5.6: a 405 lists the methods the path does take.
function notAllowed(allow, headers) {
  return error(405, "method_not_allowed", Object.assign({ Allow: allow }, headers || {}));
}

function html(status, body, headers) {
  return new Response(body, {
    status,
    headers: Object.assign({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": HTML_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    }, headers || {}),
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 32 random bytes as base64url without padding. Used for the login state and
// for a reader key.
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieValue(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) {
      continue;
    }
    if (part.slice(0, at).trim() === name) {
      return part.slice(at + 1).trim();
    }
  }
  return null;
}

// Seconds from `now` to the next 00:00 UTC, at least one. The Retry-After of a
// spent daily limit.
function untilUtcMidnight(now) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function hex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return hex(new Uint8Array(digest));
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return hex(new Uint8Array(digest));
}

function bearer(request) {
  const header = request.headers.get("Authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer[ \t]+(.+)$/.exec(header.trim());
  return match ? match[1].trim() : null;
}

// The data partner behind a key, with whether the operator has reviewed it
// (archive_from set). One query.
async function channelFor(env, key) {
  if (key === null || key === "") {
    return null;
  }
  const digest = await sha256Hex(key);
  // A blocked partner, or one whose GitHub account is blocked as a reader,
  // looks like a missing key (found in a security review).
  const row = await env.DB.prepare(
    "SELECT k.channel AS channel, c.archive_from AS archive_from FROM keys k "
    + "JOIN channels c ON c.id = k.channel "
    + "LEFT JOIN readers r ON r.github_id = c.github_id "
    + "WHERE k.key_sha256 = ? AND k.active = 1 AND c.blocked = 0 "
    + "AND (c.github_id IS NULL OR r.active = 1)",
  ).bind(digest).first();
  if (!row || typeof row.channel !== "string") {
    return null;
  }
  return { id: row.channel, reviewed: row.archive_from !== null && row.archive_from !== undefined };
}

// One query for the key: the key row joined with its reader, so an inactive
// key and a blocked reader both look like a miss. Returns the reader id (the
// key of the rate limiter and of the daily counter) and the allowed origins.
async function readerKeyFor(env, key) {
  if (key === null || key === "") {
    return null;
  }
  const digest = await sha256Hex(key);
  const row = await env.DB.prepare(
    "SELECT rk.reader_id AS reader_id, rk.origins AS origins, rk.daily_limit AS daily_limit FROM reader_keys rk "
    + "JOIN readers r ON r.id = rk.reader_id "
    + "WHERE rk.key_sha256 = ? AND rk.active = 1 AND r.active = 1",
  ).bind(digest).first();
  if (!row) {
    return null;
  }
  const limit = Number.isInteger(row.daily_limit) && row.daily_limit > 0 ? row.daily_limit : DAILY_LIMIT;
  return { readerId: row.reader_id, origins: row.origins, limit };
}

function originsAllow(origins, origin) {
  if (origins === null || origins === undefined || origins === "") {
    return true;
  }
  if (!origin) {
    return true;
  }
  let list;
  try {
    list = JSON.parse(origins);
  } catch (problem) {
    return false;
  }
  return Array.isArray(list) && list.includes(origin);
}

function cellFor(pin) {
  if (typeof pin.lat !== "number" || typeof pin.lon !== "number") {
    return null;
  }
  return tenFloor(pin.lat) * 10000 + tenFloor(pin.lon) + CELL_OFFSET;
}

// floor(degree * 10) with the floating point error of a boundary such as 52.1
// (52.1 * 10 is 520.9999999999999) removed, so a pin at the boundary and the
// box that contains it land in the same cell.
function tenFloor(value) {
  return Math.floor(value * 10 + 1e-9);
}

function valueOrNull(value) {
  return value === undefined ? null : value;
}

// The body is read from the stream and abandoned as soon as it passes 64 KiB,
// so Content-Length is a shortcut and not the boundary. `null` means too large.
async function readBody(request, max = MAX_BODY) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > max) {
    return null;
  }
  const stream = request.body;
  if (!stream || typeof stream.getReader !== "function") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return bytes.byteLength > max ? null : bytes;
  }
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    total += step.value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch (problem) {
        // The stream is abandoned anyway; only the answer counts.
      }
      return null;
    }
    chunks.push(step.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// All pins of one submission go in as a single INSERT with one JSON parameter
// (D1: at most 100 parameters and 100 KB SQL text per statement). json_each is
// the SQLite JSON function, it exists in D1 and in node:sqlite.
function insertPinsStatement(env, channel, group, date, pins) {
  const rows = pins.map((pin) => ({
    channel,
    grp: group,
    date,
    hole: valueOrNull(pin.hole),
    lat: valueOrNull(pin.lat),
    lon: valueOrNull(pin.lon),
    source: valueOrNull(pin.source),
    accuracy_m: valueOrNull(pin.accuracy_m),
    front_m: valueOrNull(pin.front_m),
    left_m: valueOrNull(pin.left_m),
    input_front: valueOrNull(pin.input_front),
    input_offset: valueOrNull(pin.input_offset),
    input_side: valueOrNull(pin.input_side),
    input_unit: valueOrNull(pin.input_unit),
    missing: pin.missing === true ? 1 : 0,
    play_bearing_deg: valueOrNull(pin.play_bearing_deg),
    correction: valueOrNull(pin.correction),
    cell: cellFor(pin),
  }));
  const sql = "INSERT INTO pins (channel, grp, date, hole, lat, lon, source, "
    + "accuracy_m, front_m, left_m, input_front, input_offset, input_side, "
    + "input_unit, missing, play_bearing_deg, correction, cell) SELECT "
    + "json_extract(value, '$.channel'), json_extract(value, '$.grp'), "
    + "json_extract(value, '$.date'), json_extract(value, '$.hole'), "
    + "json_extract(value, '$.lat'), json_extract(value, '$.lon'), "
    + "json_extract(value, '$.source'), json_extract(value, '$.accuracy_m'), "
    + "json_extract(value, '$.front_m'), json_extract(value, '$.left_m'), "
    + "json_extract(value, '$.input_front'), json_extract(value, '$.input_offset'), "
    + "json_extract(value, '$.input_side'), json_extract(value, '$.input_unit'), "
    + "json_extract(value, '$.missing'), json_extract(value, '$.play_bearing_deg'), "
    + "json_extract(value, '$.correction'), json_extract(value, '$.cell') "
    + "FROM json_each(?)";
  return env.DB.prepare(sql).bind(JSON.stringify(rows));
}

// One statement for any number of `files` rows, again over json_each (D1: a
// batch counts each statement, so two day files cost one and not two).
function filesStatement(env, entries) {
  const rows = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    date: entry.date === undefined ? null : entry.date,
    year: entry.year === undefined ? null : entry.year,
    bytes: entry.bytes,
    sha256: entry.sha256,
    rows: entry.rows,
  }));
  const sql = "INSERT OR REPLACE INTO files (path, kind, date, year, bytes, sha256, rows) "
    + "SELECT json_extract(value, '$.path'), json_extract(value, '$.kind'), "
    + "json_extract(value, '$.date'), json_extract(value, '$.year'), "
    + "json_extract(value, '$.bytes'), json_extract(value, '$.sha256'), "
    + "json_extract(value, '$.rows') FROM json_each(?)";
  return env.DB.prepare(sql).bind(JSON.stringify(rows));
}

function dirtyStatement(env, value) {
  return env.DB.prepare(
    "INSERT INTO state (key, value) VALUES ('dirty', ?) "
    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).bind(value);
}

function sameBytes(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

async function bucketBytes(env, path) {
  const object = await env.BUCKET.get("v1/" + path);
  if (!object) {
    return null;
  }
  return new Uint8Array(await object.arrayBuffer());
}

async function countPins(env, channel, group, date) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pins WHERE channel = ? AND grp = ? AND date = ?",
  ).bind(channel, group, date).first();
  return row ? Number(row.n) || 0 : 0;
}

// One row of FORMAT.md 2 built from a database row. A lost position carries
// nothing from lat to channel and no play_bearing_deg or correction (FORMAT.md
// 2.1), so the channel is left out even though the database keeps it for
// every pin.
const POSITION_COLUMNS = [
  "lat", "lon", "source", "accuracy_m", "front_m", "left_m",
  "input_front", "input_offset", "input_side", "input_unit",
  "play_bearing_deg", "correction",
];

function rowForFile(row) {
  const out = { date: row.date, date_basis: "local", hole: row.hole };
  if (row.missing === 1 || row.missing === true) {
    out.missing = true;
    return out;
  }
  for (const column of POSITION_COLUMNS) {
    if (row[column] !== null && row[column] !== undefined) {
      out[column] = row[column];
    }
  }
  if (row.channel !== null && row.channel !== undefined) {
    out.channel = row.channel;
  }
  return out;
}

// The same row plus the internal fields selectLive groups by.
function rowForLive(row) {
  const out = rowForFile(row);
  out.grp = row.grp;
  out.visible_from = row.visible_from;
  if (out.missing === true) {
    out.channel = row.channel;
  }
  return out;
}

function rowForLiveOutput(row) {
  if (row.missing === true) {
    return { date: row.date, date_basis: "local", hole: row.hole, missing: true };
  }
  return row;
}

// The pins that belong in the archive: those of a reviewed data partner on or
// after its archive_from (schema.sql, channels). Day files, year files and
// GET /v1/pins all read through this join, so they stay the same records.
const ARCHIVED_JOIN = "JOIN channels c ON c.id = p.channel "
  + "AND c.archive_from IS NOT NULL AND p.date >= c.archive_from";

// One JSON parameter again, so a year with hundreds of days stays one query
// and never crosses the limit of 100 bound parameters.
async function pinsForDates(env, dates) {
  if (dates.length === 0) {
    return [];
  }
  const result = await env.DB.prepare(
    "SELECT p.* FROM pins p " + ARCHIVED_JOIN + " WHERE p.date IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(dates)).all();
  return (result.results || []).map(rowForFile);
}

async function submissions(request, env, url) {
  // The key comes first: a missing key is answered before size and JSON are
  // looked at (API.md 1.5).
  const channel = await channelFor(env, bearer(request));
  if (channel === null) {
    return error(401, "unauthorized");
  }

  // Until 19.10.2026 only "1" switched the dry run on, and ?dry_run=true
  // stored for real. A switch that keeps people from writing must not fail
  // open, so anything but the four spellings below is a 400.
  const dryRun = dryRunFlag(url.searchParams.get("dry_run"));
  if (dryRun === null) {
    return error(400, "invalid_dry_run");
  }

  const bodyBytes = await readBody(request);
  if (bodyBytes === null) {
    return error(413, "body_too_large");
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch (problem) {
    return error(400, "invalid_json");
  }

  const stored = await storeSubmission(env, channel, body, dryRun);
  if (stored.status !== 200) {
    return problemResponse(stored.status, stored.body);
  }
  return json(stored.status, stored.body);
}

// true, false, or null for a value that is neither. Only an absent dry_run is
// false: ?dry_run= with no value says someone meant to switch it.
function dryRunFlag(raw) {
  if (raw === null || raw === "false" || raw === "0") {
    return false;
  }
  if (raw === "true" || raw === "1") {
    return true;
  }
  return null;
}

// The part of POST /v1/submissions after the key and the body: check, store,
// answer. The account upload (API.md 3.2) calls it once per ground of a file.
// Returns { status, body } of the JSON answer.
async function storeSubmission(env, channel, body, dryRun) {
  const now = nowDate(env);
  const today = isoDay(now);
  const checked = checkSubmission(body, today);
  if (!checked.ok) {
    return {
      status: 422,
      body: problemBody(422, "invalid_submission", { problems: checked.problems }),
    };
  }

  // No closed-day check here: checkSubmission accepts only dates within one
  // day of today, and a day closes three days after it (core.js isClosed).
  const group = body.group;
  const date = body.date;

  const pins = checked.pins;
  const visible = visibleFrom(date, pins);
  const replaced = (await countPins(env, channel.id, group, date)) > 0;

  // A partner that waits for the review delivers at most UNREVIEWED_GROUPS
  // grounds a day (API.md 3): enough to try everything, too few to fill the
  // live API with invented courses before anyone has looked.
  if (!channel.reviewed && !replaced) {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM days WHERE channel = ? AND date = ?",
    ).bind(channel.id, date).first();
    if (row && Number(row.n) >= UNREVIEWED_GROUPS) {
      return { status: 429, body: problemBody(429, "partner_limit") };
    }
  }

  if (!dryRun) {
    // Five statements in one invocation: key, count, and this batch of three
    // (delete, one json_each INSERT for every pin, days row).
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM pins WHERE channel = ? AND grp = ? AND date = ?",
      ).bind(channel.id, group, date),
      insertPinsStatement(env, channel.id, group, date, pins),
      env.DB.prepare(
        "INSERT INTO days (channel, grp, date, visible_from) VALUES (?, ?, ?, ?) "
        + "ON CONFLICT(channel, grp, date) DO UPDATE SET visible_from = excluded.visible_from",
      ).bind(channel.id, group, date, visible),
    ]);
  }

  const answer = {
    stored: dryRun ? 0 : pins.length,
    group,
    date,
    replaced,
    visible_from: visible,
  };
  if (dryRun) {
    answer.dry_run = true;
  }
  return { status: 200, body: answer };
}

async function deleteSubmission(request, env, url) {
  const channel = await channelFor(env, bearer(request));
  if (channel === null) {
    return error(401, "unauthorized");
  }
  const group = url.searchParams.get("group");
  const date = url.searchParams.get("date");
  if (!group || !date || parseDate(date) === null) {
    return error(400, "invalid_request");
  }
  const today = isoDay(nowDate(env));
  if (isClosed(date, today)) {
    return error(409, "day_closed");
  }
  const results = await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM pins WHERE channel = ? AND grp = ? AND date = ?",
    ).bind(channel.id, group, date),
    env.DB.prepare(
      "DELETE FROM days WHERE channel = ? AND grp = ? AND date = ?",
    ).bind(channel.id, group, date),
  ]);
  const firstResult = Array.isArray(results) ? results[0] : null;
  const changes = firstResult && firstResult.meta ? Number(firstResult.meta.changes) || 0 : 0;
  return json(200, { deleted: changes });
}

function parseBbox(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const parts = raw.split(",");
  if (parts.length !== 4) {
    return null;
  }
  if (parts.some((part) => part.trim() === "")) {
    return null;
  }
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((number) => !Number.isFinite(number))) {
    return null;
  }
  const [west, south, east, north] = numbers;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return null;
  }
  if (!(west < east) || !(south < north)) {
    return null;
  }
  return { west, south, east, north };
}

function cellsFor(box) {
  const cells = [];
  for (let lat = tenFloor(box.south); lat <= tenFloor(box.north); lat += 1) {
    for (let lon = tenFloor(box.west); lon <= tenFloor(box.east); lon += 1) {
      cells.push(lat * 10000 + lon + CELL_OFFSET);
    }
  }
  return cells;
}

// The box of both read endpoints, or the 400 to send.
function checkedBox(url) {
  const box = parseBbox(url.searchParams.get("bbox"));
  if (box === null) {
    return { refused: error(400, "invalid_bbox", CORS) };
  }
  if (box.east - box.west > MAX_BOX || box.north - box.south > MAX_BOX) {
    return { refused: error(400, "bbox_too_large", CORS) };
  }
  return { box };
}

async function live(request, env, url) {
  const key = await readerFor(request, env);
  if (key.refused) {
    return key.refused;
  }
  const checked = checkedBox(url);
  if (checked.refused) {
    return checked.refused;
  }
  const box = checked.box;
  const access = await readerSpend(request, env, key.reader);
  if (access.refused) {
    return access.refused;
  }
  const { now, today, limitHeaders } = access;

  const cells = cellsFor(box);
  const placeholders = cells.map(() => "?").join(",");
  const since = addDays(today, -2);
  // One ground (channel, grp, date) is in the box as soon as one of its rows
  // carries a coordinate inside it. Then every row of that ground is returned,
  // including lost positions and rows that carry only front_m and left_m
  // (FORMAT.md 2.1 rule 3). The box of at most 0.5 by 0.5 degrees yields at
  // most 36 cells, so the IN list stays below 90 parameters.
  const sql = "SELECT p.channel, p.grp, p.date, p.hole, p.lat, p.lon, p.source, "
    + "p.accuracy_m, p.front_m, p.left_m, p.input_front, p.input_offset, "
    + "p.input_side, p.input_unit, p.missing, p.play_bearing_deg, p.correction, "
    + "d.visible_from "
    + "FROM pins p JOIN days d ON d.channel = p.channel AND d.grp = p.grp AND d.date = p.date "
    + "WHERE p.date >= ? AND EXISTS ("
    + "SELECT 1 FROM pins q WHERE q.channel = p.channel AND q.grp = p.grp AND q.date = p.date "
    + "AND q.cell IN (" + placeholders + ") AND q.lat IS NOT NULL AND q.lon IS NOT NULL "
    + "AND q.lat BETWEEN ? AND ? AND q.lon BETWEEN ? AND ?)";
  const params = [since]
    .concat(cells, [box.south, box.north, box.west, box.east]);
  const result = await env.DB.prepare(sql).bind(...params).all();
  const rows = (result.results || []).map(rowForLive);
  const selected = selectLive(rows, now.toISOString(), today).map(rowForLiveOutput);
  return withEtag(request, liveGeojson(today, selected), Object.assign({
    "Content-Type": "application/geo+json",
    "Cache-Control": LIVE_CACHE,
  }, CORS, limitHeaders));
}

// A strong ETag over the bytes of the answer, and 304 when the client already
// holds them. The request is counted all the same: the query has run by then.
// Both answers are the same bytes for the same day and box (as_of is a date).
async function withEtag(request, bytes, headers) {
  const tag = "\"" + (await sha256Bytes(bytes)).slice(0, 32) + "\"";
  const all = Object.assign({}, headers, { ETag: tag });
  if (etagMatches(request.headers.get("If-None-Match"), tag)) {
    delete all["Content-Type"];
    return new Response(null, { status: 304, headers: all });
  }
  return new Response(bytes, { status: 200, headers: all });
}

// If-None-Match compares weakly (RFC 9110, 13.1.2), so W/ before our tag counts.
function etagMatches(header, tag) {
  if (!header) {
    return false;
  }
  return header.split(",").some((part) => {
    const value = part.trim();
    return value === "*" || value === tag || value === "W/" + tag;
  });
}

// The day limit as headers. Reset is the next 00:00 UTC in Unix seconds, the
// form GitHub uses; the IETF RateLimit fields are still a draft (revision 11,
// May 2026) and changed shape between revisions.
function dayLimitHeaders(limit, used, now) {
  return {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(Math.max(0, limit - used)),
    "X-RateLimit-Reset": String(Math.floor(now.getTime() / 1000) + untilUtcMidnight(now)),
  };
}

// The 429 of both minute limits, the visitor one and the shared ceiling. It
// carries the day values too, read without counting this request.
async function rateLimited(env, reader) {
  const now = nowDate(env);
  const row = await env.DB.prepare(
    "SELECT count FROM reader_days WHERE reader_id = ? AND day = ?",
  ).bind(reader.readerId, isoDay(now)).first();
  const used = row ? Number(row.count) : 0;
  return error(429, "rate_limited", Object.assign(
    { "Retry-After": RATE_RETRY_AFTER }, dayLimitHeaders(reader.limit, used, now), CORS));
}

// The key of the two read endpoints of API.md 2, and the origin it may be used
// from. Returns { refused } or { reader }. The key goes as Bearer like the
// partner key; X-API-Key is the old header, kept until OpenYardage has moved.
// The key in the query string went on 19.10.2026: it ends up in
// browser history, proxy logs and Referer.
async function readerFor(request, env) {
  const rawKey = bearer(request) || request.headers.get("X-API-Key");
  const reader = await readerKeyFor(env, rawKey);
  if (reader === null) {
    return { refused: error(401, "unauthorized", CORS) };
  }
  if (!originsAllow(reader.origins, request.headers.get("Origin"))) {
    return { refused: error(403, "origin_not_allowed", CORS) };
  }
  return { reader };
}

// The minute limits and the day counter, in that order, after the parameters
// are checked: a request with a typo in bbox costs nothing. The day counter is
// one row per reader and UTC day, so /v1/live and /v1/pins spend the same 1000
// requests. Returns either { refused } with the answer to send as it is, or
// the values both endpoints need afterwards.
async function readerSpend(request, env, reader) {
  // 30 a minute, counted by the rate limiting binding. Counted per reader:
  // keyed by the key, every new login would start the minute again.
  if (env.LIVE_LIMIT && typeof env.LIVE_LIMIT.limit === "function") {
    // A key bound to origins is a browser key that every visitor of one site
    // shares (OpenYardage, API.md 2.2). Its minute limit counts per visitor,
    // otherwise the 31st visitor in a minute would get no pins. The day limit
    // stays with the reader and the key's daily_limit.
    const minuteKey = "reader:" + reader.readerId
      + (reader.origins ? ":" + (request.headers.get("CF-Connecting-IP") || "") : "");
    const outcome = await env.LIVE_LIMIT.limit({ key: minuteKey });
    if (!outcome || outcome.success === false) {
      return { refused: await rateLimited(env, reader) };
    }
  }

  // The ceiling of a shared key (SHARED_LIMIT in wrangler.toml). Whoever copies
  // the key from the site could rotate the IP and pass the visitor limit at
  // will; this one counts the key as a whole. Asked only after the visitor
  // limit passed, so a visitor refused there does not spend the site's ceiling.
  if (reader.origins && env.SHARED_LIMIT && typeof env.SHARED_LIMIT.limit === "function") {
    const outcome = await env.SHARED_LIMIT.limit({ key: "reader:" + reader.readerId });
    if (!outcome || outcome.success === false) {
      return { refused: await rateLimited(env, reader) };
    }
  }

  // 1000 a UTC day. One statement counts and reads the new value, so the limit
  // costs one query and not two (D1 allows 50 per invocation).
  const now = nowDate(env);
  const today = isoDay(now);
  const usage = await env.DB.prepare(
    "INSERT INTO reader_days (reader_id, day, count) VALUES (?, ?, 1) "
    + "ON CONFLICT(reader_id, day) DO UPDATE SET count = count + 1 RETURNING count",
  ).bind(reader.readerId, today).first();
  const used = usage ? Number(usage.count) : 0;
  const limitHeaders = dayLimitHeaders(reader.limit, used, now);
  if (used > reader.limit) {
    return {
      refused: error(429, "daily_limit",
        Object.assign(limitHeaders, CORS, { "Retry-After": String(untilUtcMidnight(now)) })),
    };
  }
  return { now, today, limitHeaders };
}

// GET /v1/pins: the closed days of a range (API.md 2.3). Same key, same
// limits, same box rule as /v1/live, but a fixed range of past days. No
// visible_from filter: a closed day is public in the files anyway.
async function history(request, env, url) {
  const key = await readerFor(request, env);
  if (key.refused) {
    return key.refused;
  }
  const checked = checkedBox(url);
  if (checked.refused) {
    return checked.refused;
  }
  const box = checked.box;

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const fromParts = parseDate(from);
  const toParts = parseDate(to);
  let span = null;
  if (fromParts !== null && toParts !== null) {
    span = (Date.UTC(toParts.y, toParts.m - 1, toParts.d)
      - Date.UTC(fromParts.y, fromParts.m - 1, fromParts.d)) / DAY_MS;
  }
  // A span of 30 is 31 days with both ends counted.
  if (span === null || span < 0 || span > 30) {
    return error(400, "invalid_range", CORS);
  }
  if (!isClosed(to, isoDay(nowDate(env)))) {
    return error(400, "range_not_closed", CORS);
  }

  const access = await readerSpend(request, env, key.reader);
  if (access.refused) {
    return access.refused;
  }
  const { limitHeaders } = access;

  const cells = cellsFor(box);
  const placeholders = cells.map(() => "?").join(",");
  // The same box rule as the live query, without the days join and without a
  // visible_from filter: rows of a ground whose coordinate lies in the box.
  const sql = "SELECT p.channel, p.grp, p.date, p.hole, p.lat, p.lon, p.source, "
    + "p.accuracy_m, p.front_m, p.left_m, p.input_front, p.input_offset, "
    + "p.input_side, p.input_unit, p.missing, p.play_bearing_deg, p.correction "
    + "FROM pins p " + ARCHIVED_JOIN + " WHERE p.date BETWEEN ? AND ? AND EXISTS ("
    + "SELECT 1 FROM pins q WHERE q.channel = p.channel AND q.grp = p.grp AND q.date = p.date "
    + "AND q.cell IN (" + placeholders + ") AND q.lat IS NOT NULL AND q.lon IS NOT NULL "
    + "AND q.lat BETWEEN ? AND ? AND q.lon BETWEEN ? AND ?)";
  const params = [from, to]
    .concat(cells, [box.south, box.north, box.west, box.east]);
  const result = await env.DB.prepare(sql).bind(...params).all();
  const rows = (result.results || []).map(rowForFile);
  return withEtag(request, historyGeojson(from, to, rows), Object.assign({
    "Content-Type": "application/geo+json",
    "Cache-Control": HISTORY_CACHE,
  }, CORS, limitHeaders));
}

function optionsLive() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": CORS["Access-Control-Allow-Headers"],
      "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
    },
  });
}

function contentTypeFor(path) {
  // header=present: the first line names the columns (RFC 4180, 3).
  if (path.endsWith(".csv")) {
    return "text/csv; charset=utf-8; header=present";
  }
  if (path.endsWith(".geojson")) {
    return "application/geo+json";
  }
  return "application/json";
}

function cacheControlFor(path) {
  return path.startsWith("days/") ? DAY_CACHE : SHORT_CACHE;
}

async function putFile(env, path, bytes) {
  await env.BUCKET.put("v1/" + path, bytes, {
    httpMetadata: {
      contentType: contentTypeFor(path),
      cacheControl: cacheControlFor(path),
    },
  });
}

async function runScheduled(event, env) {
  const now = nowDate(env);
  const today = isoDay(now);
  const report = { ok: true, written: [], years: [], errors: [] };

  // The day counters only enforce the daily limit; after USAGE_KEEP_DAYS they
  // serve nothing, so they go (openpinsheet.com/privacy, section 3).
  const keepFrom = isoDay(new Date(now.getTime() - USAGE_KEEP_DAYS * 86400000));
  await env.DB.prepare("DELETE FROM reader_days WHERE day < ?").bind(keepFrom).run();
  // Expired sessions serve nothing (openpinsheet.com/privacy, section 3).
  await env.DB.prepare("DELETE FROM sessions WHERE expires < ?").bind(now.toISOString()).run();

  const dirtyRow = await env.DB.prepare(
    "SELECT value FROM state WHERE key = 'dirty'",
  ).first();
  const dirty = dirtyRow !== null && dirtyRow.value === "1";

  // Only the days that are closed and have no files row yet, capped per run.
  const pendingRows = await env.DB.prepare(
    "SELECT DISTINCT p.date FROM pins p " + ARCHIVED_JOIN + " WHERE NOT EXISTS ("
    + "SELECT 1 FROM files f WHERE f.kind = 'day' AND f.date = p.date) "
    + "ORDER BY p.date",
  ).all();
  const pending = (pendingRows.results || []).map((row) => row.date);

  const writtenDates = [];
  let processed = 0;
  for (const date of pending) {
    if (!isClosed(date, today) || processed >= MAX_DAYS_PER_RUN) {
      continue;
    }
    processed += 1;

    const rows = await pinsForDates(env, [date]);
    const wanted = [
      { path: "days/" + date + ".csv", kind: "day", date, content: dayCsv(date, rows), rows: rows.length },
      { path: "days/" + date + ".geojson", kind: "day", date, content: dayGeojson(date, rows), rows: rows.length },
    ];
    for (const item of wanted) {
      item.bytes = item.content.length;
      item.sha256 = await sha256Bytes(item.content);
    }

    // A closed day is immutable, so its content is deterministic. An object
    // left behind by a run that stopped here is taken over when the bytes
    // match, and reported as a collision when they do not.
    const missing = [];
    let collision = null;
    for (const item of wanted) {
      const existing = await bucketBytes(env, item.path);
      if (existing === null) {
        missing.push(item);
      } else if (!sameBytes(existing, item.content)) {
        collision = item.path;
        break;
      }
    }
    if (collision !== null) {
      report.errors.push({
        date,
        path: "v1/" + collision,
        message: "exists in the bucket with other content and is not overwritten",
      });
      continue;
    }
    for (const item of missing) {
      await putFile(env, item.path, item.content);
    }
    // The files rows and `dirty` go in one batch: either the days table knows
    // about the day and the index is due, or neither.
    await env.DB.batch([
      filesStatement(env, wanted.map((item) => ({
        path: item.path, kind: item.kind, date: item.date,
        bytes: item.bytes, sha256: item.sha256, rows: item.rows,
      }))),
      dirtyStatement(env, "1"),
    ]);
    report.written.push(date);
    writtenDates.push(date);
  }

  const rebuild = dirty || writtenDates.length > 0;
  if (rebuild) {
    let years;
    if (dirty) {
      // A previous run stopped between the day files and the index. Which year
      // it was is in the files table, so every year with a day is rebuilt.
      const yearRows = await env.DB.prepare(
        "SELECT DISTINCT substr(date, 1, 4) AS year FROM files "
        + "WHERE kind = 'day' ORDER BY year",
      ).all();
      years = (yearRows.results || []).map((row) => row.year);
    } else {
      years = Array.from(new Set(writtenDates.map((date) => date.slice(0, 4)))).sort();
    }
    for (const year of years) {
      const dayRows = await env.DB.prepare(
        "SELECT date FROM files WHERE kind = 'day' AND date LIKE ? ORDER BY date",
      ).bind(year + "-%").all();
      const yearDates = (dayRows.results || []).map((row) => row.date);
      const rows = await pinsForDates(env, yearDates);
      const path = "years/" + year + ".csv";
      const csv = yearCsv(year, rows);
      await putFile(env, path, csv);
      await filesStatement(env, [{
        path, kind: "year", year, bytes: csv.length,
        sha256: await sha256Bytes(csv), rows: rows.length,
      }]).run();
      report.years.push(year);
    }

    const fileRows = await env.DB.prepare(
      "SELECT path, kind, date, year, bytes, sha256, rows FROM files ORDER BY path",
    ).all();
    const index = await indexJson((fileRows.results || []).map((row) => ({
      path: row.path,
      kind: row.kind,
      date: row.kind === "day" ? row.date : undefined,
      year: row.kind === "year" ? row.year : undefined,
      bytes: row.bytes,
      sha256: row.sha256,
      rows: row.rows,
    })), today);
    await env.BUCKET.put("v1/index.json", encoder.encode(index), {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: SHORT_CACHE,
      },
    });
    // Only now are years and index complete; until then `dirty` stays 1.
    await dirtyStatement(env, "0").run();
  }

  report.ok = report.errors.length === 0;
  return report;
}

// --- reader login (GitHub OAuth) -----------------------------------------

function blockedPage() {
  const body = "<!doctype html>\n"
    + "<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    + "<title>OpenPinsheet key</title>\n</head>\n<body>\n"
    + "<h1>No key</h1>\n"
    + "<p>This GitHub account may not use the live API.</p>\n"
    + "</body>\n</html>\n";
  return html(403, body);
}

// GET /v1/auth/github: send the reader to GitHub. The state is random and
// travels both in a cookie and in the parameter; the callback wants them equal.
function authStart(env) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return error(503, "not_configured");
  }
  const state = randomToken();
  const query = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: AUTH_CALLBACK,
    scope: "",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: AUTH_URL + "?" + query.toString(),
      "Set-Cookie": AUTH_COOKIE + "=" + state
        + "; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=600",
      "Cache-Control": "no-store",
    },
  });
}

// GET /v1/auth/github/callback: check the state, trade the code for a token,
// read the GitHub identity, and hand out one fresh key. The token is used and
// then dropped; it is never written anywhere.
async function authCallback(request, env, url) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return error(503, "not_configured");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = cookieValue(request, AUTH_COOKIE);
  if (!code || !state || !cookie || state !== cookie) {
    return error(400, "invalid_state");
  }

  let token = null;
  try {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: AUTH_CALLBACK,
      }),
    });
    const data = await tokenResponse.json();
    token = data && typeof data.access_token === "string" ? data.access_token : null;
  } catch (problem) {
    return error(502, "github_error");
  }
  if (!token) {
    return error(502, "github_error");
  }

  let github = null;
  try {
    const userResponse = await fetch(USER_URL, {
      headers: {
        Authorization: "Bearer " + token,
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.github+json",
      },
    });
    github = await userResponse.json();
  } catch (problem) {
    return error(502, "github_error");
  }
  const githubId = github && Number.isInteger(github.id) ? github.id : null;
  const login = github && typeof github.login === "string" ? github.login : null;
  if (githubId === null || login === null) {
    return error(502, "github_error");
  }

  const created = nowDate(env).toISOString();
  const existing = await env.DB.prepare(
    "SELECT id, active FROM readers WHERE github_id = ?",
  ).bind(githubId).first();
  if (existing && Number(existing.active) === 0) {
    return blockedPage();
  }

  let readerId;
  if (existing) {
    readerId = existing.id;
    await env.DB.prepare("UPDATE readers SET login = ? WHERE id = ?")
      .bind(login, readerId).run();
  } else {
    const inserted = await env.DB.prepare(
      "INSERT INTO readers (github_id, login, created, active) VALUES (?, ?, ?, 1)",
    ).bind(githubId, login, created).run();
    readerId = inserted && inserted.meta ? inserted.meta.last_row_id : null;
    if (!readerId) {
      return error(500, "internal_error");
    }
  }

  // The login opens the account. The first login issues the reader key and
  // shows it once; later logins keep it, "New key" in the account replaces it.
  const active = await env.DB.prepare(
    "SELECT 1 AS one FROM reader_keys WHERE reader_id = ? AND active = 1",
  ).bind(readerId).first();
  let notice = "";
  if (!active) {
    const key = await issueReaderKey(env, readerId, created);
    notice = newKeyNotice("Your key", key, "live");
  }
  const opened = await openSession(env, readerId, created);
  const session = { readerId, login, githubId, csrf: opened.csrf };
  // The state cookie has done its job; drop it so it cannot be replayed.
  return accountResponse(env, session, notice, [
    opened.cookie,
    AUTH_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth; Max-Age=0",
  ]);
}

// --- the account (API.md 3) ----------------------------------------------
//
// A GitHub login opens an account: a random token in the cookie ops_session,
// only its sha256 in the table sessions. Every form sends the session's csrf
// token back; the cookie is SameSite=Lax as well. In the account a reader
// replaces the reader key, signs up as a data partner, replaces the partner
// key and uploads CSV or KML files. Keys are shown once; the account shows
// only their first characters afterwards.

function keyPrefix(key) {
  return key.slice(0, SHOWN_PREFIX);
}

function plusDays(now, days) {
  return new Date(now.getTime() + days * DAY_MS).toISOString();
}

async function openSession(env, readerId, created) {
  const token = randomToken();
  const csrf = randomToken();
  const now = new Date(created);
  await env.DB.prepare(
    "INSERT INTO sessions (token_sha256, reader_id, csrf, created, expires) VALUES (?, ?, ?, ?, ?)",
  ).bind(await sha256Hex(token), readerId, csrf, created, plusDays(now, SESSION_DAYS)).run();
  return {
    csrf,
    cookie: SESSION_COOKIE + "=" + token + "; HttpOnly; Secure; SameSite=Lax; Path="
      + ACCOUNT_PATH + "; Max-Age=" + String(SESSION_DAYS * 86400),
  };
}

async function sessionFor(env, request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const row = await env.DB.prepare(
    "SELECT s.reader_id AS reader_id, s.csrf AS csrf, r.login AS login, r.github_id AS github_id "
    + "FROM sessions s JOIN readers r ON r.id = s.reader_id "
    + "WHERE s.token_sha256 = ? AND s.expires > ? AND r.active = 1",
  ).bind(await sha256Hex(token), nowDate(env).toISOString()).first();
  if (!row) {
    return null;
  }
  return { readerId: row.reader_id, csrf: row.csrf, login: row.login, githubId: row.github_id, token };
}

// One active key per reader. One batch, so two requests at once cannot both
// deactivate first and then both insert; the unique index on reader_keys
// (schema.sql) holds the rule as well. The new key takes over origins and
// daily_limit of the newest old one: a shared key that lost its higher limit
// would stop at once on the day's count, which belongs to the reader.
async function issueReaderKey(env, readerId, created) {
  const key = KEY_PREFIX + randomToken();
  const digest = await sha256Hex(key);
  const newest = "FROM reader_keys WHERE reader_id = ? ORDER BY created DESC, rowid DESC LIMIT 1";
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE reader_keys SET active = 0 WHERE reader_id = ? AND active = 1",
    ).bind(readerId),
    env.DB.prepare(
      "INSERT INTO reader_keys (key_sha256, reader_id, active, created, origins, daily_limit, prefix) "
      + "SELECT ?, ?, 1, ?, (SELECT origins " + newest + "), (SELECT daily_limit " + newest + "), ?",
    ).bind(digest, readerId, created, readerId, readerId, keyPrefix(key)),
  ]);
  return key;
}

async function issuePartnerKey(env, channelId, created) {
  const key = PARTNER_PREFIX + randomToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE keys SET active = 0 WHERE channel = ? AND active = 1").bind(channelId),
    env.DB.prepare(
      "INSERT INTO keys (key_sha256, channel, active, created, prefix) VALUES (?, ?, 1, ?, ?)",
    ).bind(await sha256Hex(key), channelId, created, keyPrefix(key)),
  ]);
  return key;
}

// The pages of the account look like openpinsheet.com: they load its
// stylesheet and fonts (the site's headers allow the fonts for this origin) and
// add only what the site has no use for, forms and the key box.
const SITE = "https://openpinsheet.com";
const PAGE_STYLE = ".konto .angemeldet{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-bottom:4px}"
  + ".konto .angemeldet .lead{margin:0}"
  + ".konto form.inline{display:inline}"
  + ".konto button.btn{font-family:inherit;cursor:pointer;background:var(--paper)}"
  + ".konto button.btn-primary{background:var(--green)}"
  + ".konto button.btn-primary:hover{background:var(--green-dark)}"
  + ".konto .btn-klein{padding:6px 12px;font-size:14px}"
  + ".konto .karte{background:var(--card);border:1px solid var(--rule);border-radius:var(--radius);padding:18px 20px;margin:14px 0}"
  + ".konto .karte p:last-child{margin-bottom:0}"
  + ".konto .zeile{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline}"
  + ".konto .zeile form{margin-left:auto}"
  + ".konto .wert{font-family:var(--mono);font-size:15px}"
  + ".konto .schluessel{display:block;font-family:var(--mono);font-size:16px;background:var(--card);border:1.5px solid var(--green);border-radius:var(--radius);padding:12px 14px;margin:8px 0 14px;word-break:break-all;user-select:all}"
  + ".konto .note pre{white-space:pre-wrap;word-break:break-all;font-size:13px}"
  + ".konto label{display:block;margin:16px 0 6px;font-weight:600;font-size:15px}"
  + ".konto label.haken{display:flex;gap:10px;align-items:flex-start;font-weight:400}"
  + ".konto label.haken input{margin-top:6px}"
  + ".konto input[type=text],.konto input[type=url],.konto input[type=number],.konto input[type=date],.konto select,.konto input[type=file]"
  + "{font:inherit;font-size:16px;padding:9px 11px;width:100%;max-width:28rem;box-sizing:border-box;border:1px solid var(--rule-strong);border-radius:var(--radius);background:var(--card);color:var(--ink)}"
  + ".konto .knopf{margin-top:20px}"
  + ".konto .karte > label:first-of-type{margin-top:0}"
  + ".konto input[type=file]::file-selector-button{font:inherit;font-size:14px;font-weight:600;color:var(--green);background:var(--paper);border:1.5px solid var(--green);border-radius:var(--radius);padding:5px 12px;margin-right:12px;cursor:pointer}"
  + ".konto .note{border:1px solid var(--green-line);border-left:3px solid var(--green);background:var(--tint);border-radius:var(--radius);padding:16px 18px;margin:24px 0 0}"
  + ".konto .note.bad{border-color:#e7b3ba;border-left-color:var(--flag);background:#fdf2f3}"
  + ".konto .note h3{margin-bottom:8px}.konto .note ul{margin:6px 0 0;padding-left:20px}"
  + ".konto li.bad{color:var(--flag)}"
  + ".konto .marke{display:inline-block;font-size:13px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--green-fill);color:var(--green-dark)}"
  + ".konto .marke.warten{background:#fff1c9;color:#6b4e00}"
  + ".konto .marke.gesperrt{background:#fbdde1;color:#8a0f22}"
  + ".konto .btn-github{display:inline-flex;align-items:center;gap:10px;background:#24292f;border-color:#24292f;color:#fff}"
  + ".konto .btn-github:hover{background:#1b1f23;color:#fff}"
  + ".konto .btn-github svg{width:20px;height:20px;fill:currentColor}"
  + ".konto .aktionen{margin-left:auto;display:flex;gap:8px}"
  + ".konto .zeile h1{margin-right:6px}"
  + ".konto .zurueck{margin:32px 0 0}.konto .zurueck + .zeile h1{margin-top:12px}"
  + ".konto .karte ul{margin:0;padding-left:20px}";

// The GitHub mark (Octicons mark-github, MIT), on the button people know from
// other sites. Inline, so the CSP needs no source for it.
const GITHUB_MARK = "<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59"
  + "c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15"
  + ".08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82"
  + "-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66"
  + "-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38"
  + "A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z\"/></svg>";

const PAGE_TOP = "<header class=\"top\"><div class=\"wrap top-in\"><a class=\"brand\" href=\"" + SITE + "/\">"
  + "<svg class=\"mark\" width=\"22\" height=\"26\" viewBox=\"0 0 22 26\" aria-hidden=\"true\">"
  + "<line x1=\"5\" y1=\"2\" x2=\"5\" y2=\"23\" stroke=\"currentColor\" stroke-width=\"1.8\"/>"
  + "<path d=\"M5 2 L19 6.5 L5 11 Z\" class=\"mark-flag\"/><ellipse cx=\"7\" cy=\"23.5\" rx=\"6\" ry=\"1.8\" class=\"mark-cup\"/></svg>"
  + "<span>OpenPinsheet</span></a><nav aria-label=\"Main\"><a href=\"" + SITE + "/#data\">Data</a>"
  + "<a href=\"" + SITE + "/format\">Format</a><a href=\"" + SITE + "/api\">API</a>"
  + "<a href=\"" + ACCOUNT_PATH + "\">Account</a></nav></div></header>\n";

const PAGE_FOOT = "<footer class=\"foot\"><div class=\"wrap foot-in\"><p>OpenPinsheet. Data under the Open Database License 1.0.</p>"
  + "<p><a href=\"" + SITE + "/format\">Format</a><a href=\"" + SITE + "/impressum\">Legal notice</a>"
  + "<a href=\"" + SITE + "/privacy\">Privacy</a></p></div></footer>\n";

function page(title, inner) {
  return "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
    + "<meta name=\"robots\" content=\"noindex\">\n"
    + "<title>" + escapeHtml(title) + " · OpenPinsheet</title>\n"
    + "<link rel=\"icon\" href=\"" + SITE + "/favicon.svg\" type=\"image/svg+xml\">\n"
    + "<link rel=\"stylesheet\" href=\"" + SITE + "/style.css\">\n<style>" + PAGE_STYLE + "</style>\n"
    + "</head>\n<body>\n" + PAGE_TOP + "<main class=\"doc konto\"><div class=\"wrap\">\n"
    + inner + "\n</div></main>\n" + PAGE_FOOT + "</body>\n</html>\n";
}

function htmlWithCookies(status, body, cookies) {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": HTML_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const cookie of cookies || []) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(body, { status, headers });
}

function newKeyNotice(title, key, use) {
  const example = use === "live"
    ? "curl -H \"Authorization: Bearer " + key + "\" \\\n     \"https://api.openpinsheet.com/v1/live?bbox=12.9,51.9,13.1,52.1\""
    : "curl -X POST -H \"Authorization: Bearer " + key + "\" \\\n     -H \"Content-Type: application/json\" \\\n"
      + "     --data @day.json https://api.openpinsheet.com/v1/submissions";
  return "<div class=\"note\"><h3>" + escapeHtml(title) + "</h3>\n"
    + "<p>Copy it now. This page shows it once.</p>\n<code class=\"schluessel\">" + escapeHtml(key) + "</code>\n"
    + "<pre>" + escapeHtml(example) + "</pre></div>\n";
}

function hiddenCsrf(session) {
  return "<input type=\"hidden\" name=\"csrf\" value=\"" + escapeHtml(session.csrf) + "\">";
}

function formatCount(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function keyLine(label, prefix, fallback, created, action, button, session) {
  return "<div class=\"zeile\"><span>" + label + " <span class=\"wert\">"
    + escapeHtml(prefix ? prefix + "…" : fallback) + "</span></span>"
    + "<span class=\"small\">since " + escapeHtml(String(created).slice(0, 10)) + "</span>"
    + "<form class=\"inline\" method=\"post\" action=\"" + ACCOUNT_PATH + "/" + action + "\">" + hiddenCsrf(session)
    + "<button class=\"btn btn-klein\">" + button + "</button></form></div>\n"
    + "<p class=\"small\">A new key replaces this one at once.</p>\n";
}

async function accountResponse(env, session, notice, cookies) {
  const today = isoDay(nowDate(env));
  const readerKey = await env.DB.prepare(
    "SELECT prefix, created, daily_limit FROM reader_keys WHERE reader_id = ? AND active = 1",
  ).bind(session.readerId).first();
  const used = await env.DB.prepare(
    "SELECT count FROM reader_days WHERE reader_id = ? AND day = ?",
  ).bind(session.readerId, today).first();
  const channel = await env.DB.prepare(
    "SELECT id, name, website, archive_from, blocked FROM channels WHERE github_id = ?",
  ).bind(session.githubId).first();

  let inner = "<h1>Your account</h1>\n<div class=\"angemeldet\">"
    + "<p class=\"lead\">Signed in with GitHub as <b>" + escapeHtml(session.login) + "</b>.</p>"
    + "<form class=\"inline\" method=\"post\" action=\"" + ACCOUNT_PATH + "/logout\">" + hiddenCsrf(session)
    + "<button class=\"btn btn-klein\">Sign out</button></form></div>\n" + (notice || "");

  const limit = readerKey && Number.isInteger(readerKey.daily_limit) && readerKey.daily_limit > 0
    ? readerKey.daily_limit : DAILY_LIMIT;
  inner += "<section>\n<h2>Reading</h2>\n<div class=\"karte\">\n";
  if (readerKey) {
    inner += keyLine("Key", readerKey.prefix, "opr_…", readerKey.created, "reader-key", "New key", session)
      + "<p>Requests today: <b>" + formatCount(used ? Number(used.count) : 0) + "</b> of "
      + formatCount(limit) + ".</p>\n";
  } else {
    inner += "<form method=\"post\" action=\"" + ACCOUNT_PATH + "/reader-key\">" + hiddenCsrf(session)
      + "<button class=\"btn btn-primary\">Get a key</button></form>\n";
  }
  inner += "</div>\n<p class=\"small\">Today's pins come from <code>GET /v1/live</code>, past days from "
    + "<code>GET /v1/pins</code>. See <a href=\"" + SITE + "/api\">the API</a>.</p>\n</section>\n";

  inner += "<section>\n<h2>Data partner</h2>\n";
  if (!channel) {
    inner += "<p>Send pins from your tool or your club. Your name appears in the credit of every pin you send.</p>\n"
      + "<form class=\"karte\" method=\"post\" action=\"" + ACCOUNT_PATH + "/partner\">" + hiddenCsrf(session)
      + "<label for=\"name\">Name in the credit</label>"
      + "<input type=\"text\" id=\"name\" name=\"name\" required minlength=\"2\" maxlength=\"60\" placeholder=\"Golfclub Wannsee\">"
      + "<label for=\"website\">Website <span class=\"small\">(optional)</span></label>"
      + "<input type=\"url\" id=\"website\" name=\"website\" maxlength=\"200\" placeholder=\"https://\">"
      + "<label class=\"haken\"><input type=\"checkbox\" name=\"terms\" value=\"yes\" required>"
      + "<span>I may share these pins and license them under the "
      + "<a href=\"https://opendatacommons.org/licenses/odbl/1-0/\">Open Database License 1.0</a>.</span></label>"
      + "<p class=\"knopf\"><button class=\"btn btn-primary\">Become a data partner</button></p></form>\n</section>\n";
    return accountPage(env, session, inner, cookies);
  }

  const reviewed = channel.archive_from !== null && channel.archive_from !== undefined;
  const blocked = Number(channel.blocked) === 1;
  const mark = blocked ? "<span class=\"marke gesperrt\">Blocked</span>"
    : reviewed ? "<span class=\"marke\">Reviewed</span>" : "<span class=\"marke warten\">Waiting for review</span>";
  inner += "<div class=\"karte\">\n<div class=\"zeile\"><h3>" + escapeHtml(channel.name) + "</h3>" + mark + "</div>\n"
    + "<p class=\"small\">Channel <span class=\"wert\">" + escapeHtml(channel.id) + "</span>"
    + (channel.website ? " · <a href=\"" + escapeHtml(channel.website) + "\">" + escapeHtml(channel.website) + "</a>" : "")
    + "</p>\n";
  if (blocked) {
    inner += "<p>This partner sends no pins. If that is a mistake, write to "
      + "<a href=\"mailto:info@openpinsheet.com\">info@openpinsheet.com</a>.</p>\n</div>\n</section>\n";
    return accountPage(env, session, inner, cookies);
  }
  inner += "<p>" + (reviewed
    ? "Your pins go live and into the archive."
    : "Your pins go live now and into the archive once we have looked at your account. "
      + "Until then, at most " + UNREVIEWED_GROUPS + " grounds a day.") + "</p>\n";
  const partnerKey = await env.DB.prepare(
    "SELECT prefix, created FROM keys WHERE channel = ? AND active = 1",
  ).bind(channel.id).first();
  if (partnerKey) {
    inner += keyLine("Partner key", partnerKey.prefix, "opp_…", partnerKey.created, "partner-key", "New partner key", session);
  } else {
    inner += "<form method=\"post\" action=\"" + ACCOUNT_PATH + "/partner-key\">" + hiddenCsrf(session)
      + "<button class=\"btn btn-primary\">Get a partner key</button></form>\n";
  }
  inner += "</div>\n<p class=\"small\">Tools send pins through <code>POST /v1/submissions</code> with the partner key. "
    + "See <a href=\"" + SITE + "/api\">the API</a>.</p>\n</section>\n";

  inner += "<section>\n<h2>Upload a file</h2>\n"
    + "<p>A CSV or KML with one point per hole, for example from an RTK app. A CSV needs the columns hole, "
    + "lat and lon. Names like “Pin 7” work. A new upload for the same course and day replaces the old one.</p>\n"
    + "<form class=\"karte\" method=\"post\" action=\"" + ACCOUNT_PATH + "/upload\" enctype=\"multipart/form-data\">" + hiddenCsrf(session)
    + "<label for=\"file\">File</label><input type=\"file\" id=\"file\" name=\"file\" accept=\".csv,.kml\" required>"
    + "<label for=\"date\">Date <span class=\"small\">(if the file has none)</span></label>"
    + "<input type=\"date\" id=\"date\" name=\"date\" value=\"" + escapeHtml(today) + "\">"
    + "<label for=\"source\">How the points were taken</label><select id=\"source\" name=\"source\">"
    + "<option value=\"surveyed\">Measured with GNSS (RTK or similar)</option>"
    + "<option value=\"mapped\">Placed on a map or aerial image</option></select>"
    + "<label for=\"accuracy\">Accuracy in metres, 95 % radius <span class=\"small\">(if the file has none; needed when measured)</span></label>"
    + "<input type=\"number\" id=\"accuracy\" name=\"accuracy_m\" step=\"0.001\" min=\"0.001\" placeholder=\"0.02\">"
    + "<p class=\"knopf\"><button class=\"btn btn-primary\">Upload</button></p></form>\n</section>\n";
  return accountPage(env, session, inner, cookies);
}

// The account page, plus the admin area for the ids in ADMIN_GITHUB_IDS.
async function accountPage(env, session, inner, cookies) {
  const admin = isAdmin(env, session) ? await adminSection(env, session) : "";
  return htmlWithCookies(200, page("Account", inner + admin), cookies);
}

function signInPage() {
  return htmlWithCookies(200, page("Account", "<h1>Your account</h1>\n"
    + "<p class=\"lead\">Get a key for reading, or send pins as a data partner.</p>\n"
    + "<p class=\"knopf\"><a class=\"btn btn-github\" href=\"/v1/auth/github\">" + GITHUB_MARK + "Sign in with GitHub</a></p>\n"
    + "<p class=\"small\">GitHub tells us your account id and user name, nothing else.</p>"), []);
}

function simplePage(status, title, text) {
  return htmlWithCookies(status, page(title, "<h1>" + escapeHtml(title) + "</h1>\n<p class=\"lead\">" + text + "</p>\n"
    + "<p class=\"knopf\"><a class=\"btn\" href=\"" + ACCOUNT_PATH + "\">Back to the account</a></p>"), []);
}

// GET /v1/account
async function accountGet(request, env) {
  const session = await sessionFor(env, request);
  return session ? accountResponse(env, session, "") : signInPage();
}

// Every POST of the account: a session, a form, and its csrf token.
async function accountForm(request, env) {
  const session = await sessionFor(env, request);
  if (!session) {
    return { refused: signInPage() };
  }
  // Counted while reading, not taken from Content-Length: a chunked request
  // carries none (found in a security review).
  const bytes = await readBody(request, MAX_UPLOAD);
  if (bytes === null) {
    return { refused: simplePage(413, "File too large", "Upload at most 1 MB at a time.") };
  }
  let form;
  try {
    form = await new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": request.headers.get("Content-Type") || "" },
      body: bytes,
    }).formData();
  } catch (problem) {
    return { refused: simplePage(400, "Not a form", "The request did not carry a form.") };
  }
  if (form.get("csrf") !== session.csrf) {
    return { refused: simplePage(403, "Form expired", "Open the account again and repeat.") };
  }
  return { session, form };
}

async function accountReaderKey(request, env) {
  const got = await accountForm(request, env);
  if (got.refused) {
    return got.refused;
  }
  const key = await issueReaderKey(env, got.session.readerId, nowDate(env).toISOString());
  return accountResponse(env, got.session, newKeyNotice("Your new key", key, "live"));
}

// A name as it appears in the credit, and the channel id made from it: ASCII
// letters and digits joined by "-", starting with a letter, 2 to 40 characters
// (FORMAT.md 5). Leading digits go, so "1. Golfclub Berlin" is
// golfclub-berlin. Until 19.10.2026 FORMAT.md and validate.py allowed no "-"
// and 30 characters, and the first such partner would have failed the files.
function partnerName(raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 60 || /[\u0000-\u001f\u007f<>]/.test(name)) {
    return null;
  }
  const id = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  if (id.length < 2 || RESERVED_CHANNELS.includes(id)) {
    return null;
  }
  return { name, id };
}

function partnerWebsite(raw) {
  const text = String(raw || "").trim();
  if (text === "") {
    return { ok: true, value: null };
  }
  try {
    const url = new URL(text);
    if ((url.protocol === "https:" || url.protocol === "http:") && text.length <= 200) {
      return { ok: true, value: url.toString() };
    }
  } catch (problem) {
    // falls through
  }
  return { ok: false };
}

async function accountPartner(request, env) {
  const got = await accountForm(request, env);
  if (got.refused) {
    return got.refused;
  }
  const { session, form } = got;
  if (!env.REVIEW_SECRET) {
    return simplePage(503, "Not available", "Signing up as a data partner is not configured on this server.");
  }
  const exists = await env.DB.prepare("SELECT id FROM channels WHERE github_id = ?").bind(session.githubId).first();
  if (exists) {
    return accountResponse(env, session, "");
  }
  if (form.get("terms") !== "yes") {
    return accountResponse(env, session, "<div class=\"note bad\"><p>Please accept the licence to send pins.</p></div>");
  }
  const named = partnerName(form.get("name"));
  if (named === null) {
    return accountResponse(env, session, "<div class=\"note bad\"><p>Use a name of 2 to 60 characters with letters in it.</p></div>");
  }
  const website = partnerWebsite(form.get("website"));
  if (!website.ok) {
    return accountResponse(env, session, "<div class=\"note bad\"><p>The website must be an address starting with https://.</p></div>");
  }
  const taken = await env.DB.prepare(
    "SELECT 1 AS one FROM channels WHERE id = ? OR lower(name) = lower(?)",
  ).bind(named.id, named.name).first();
  if (taken) {
    return accountResponse(env, session, "<div class=\"note bad\"><p>The name “" + escapeHtml(named.name)
      + "” is taken. Choose another.</p></div>");
  }
  const created = nowDate(env).toISOString();
  await env.DB.prepare(
    "INSERT INTO channels (id, name, created, website, github_id, login, terms, archive_from) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
  ).bind(named.id, named.name, created, website.value, session.githubId, session.login, created).run();
  const key = await issuePartnerKey(env, named.id, created);
  await sendReviewMail(env, { id: named.id, name: named.name, website: website.value, login: session.login, created });
  return accountResponse(env, session, newKeyNotice("Your partner key", key, "partner"));
}

async function accountPartnerKey(request, env) {
  const got = await accountForm(request, env);
  if (got.refused) {
    return got.refused;
  }
  const channel = await env.DB.prepare(
    "SELECT id FROM channels WHERE github_id = ? AND blocked = 0",
  ).bind(got.session.githubId).first();
  if (!channel) {
    return accountResponse(env, got.session, "");
  }
  const key = await issuePartnerKey(env, channel.id, nowDate(env).toISOString());
  return accountResponse(env, got.session, newKeyNotice("Your new partner key", key, "partner"));
}

async function accountUpload(request, env) {
  const got = await accountForm(request, env);
  if (got.refused) {
    return got.refused;
  }
  const { session, form } = got;
  const row = await env.DB.prepare(
    "SELECT id, archive_from FROM channels WHERE github_id = ? AND blocked = 0",
  ).bind(session.githubId).first();
  const keyRow = row ? await env.DB.prepare(
    "SELECT 1 AS one FROM keys WHERE channel = ? AND active = 1",
  ).bind(row.id).first() : null;
  if (!row || !keyRow) {
    return accountResponse(env, session, "");
  }
  const channel = { id: row.id, reviewed: row.archive_from !== null && row.archive_from !== undefined };
  const file = form.get("file");
  if (!file || typeof file.text !== "function") {
    return accountResponse(env, session, "<div class=\"note bad\"><p>Choose a file.</p></div>");
  }
  const accuracyRaw = String(form.get("accuracy_m") || "").trim();
  const accuracy = accuracyRaw === "" ? null : Number(accuracyRaw);
  const parsed = parseUpload({
    filename: String(file.name || ""),
    text: await file.text(),
    date: String(form.get("date") || "").trim(),
    source: String(form.get("source") || "").trim(),
    accuracy_m: Number.isFinite(accuracy) ? accuracy : null,
  });
  const lines = [];
  if (parsed.problems.length > 0) {
    for (const problem of parsed.problems.slice(0, 20)) {
      lines.push("<li>" + (problem.line ? "Line " + problem.line + ": " : "") + escapeHtml(problem.message) + "</li>");
    }
    return accountResponse(env, session, "<div class=\"note bad\"><p>Nothing was stored. The file has problems:</p><ul>"
      + lines.join("") + "</ul></div>");
  }
  // At most five grounds per upload: each costs a few D1 queries, and one
  // invocation may run 50 (API.md 4).
  if (parsed.submissions.length > 5) {
    return accountResponse(env, session, "<div class=\"note bad\"><p>Nothing was stored. The file holds "
      + parsed.submissions.length + " courses or days; upload at most 5 at a time.</p></div>");
  }
  for (const submission of parsed.submissions) {
    const stored = await storeSubmission(env, channel, submission, false);
    if (stored.status === 200) {
      lines.push("<li>" + escapeHtml(submission.date) + ", " + stored.body.stored + " pins"
        + (stored.body.replaced ? ", replacing the earlier upload" : "") + ".</li>");
    } else {
      const problems = (stored.body.problems || []).slice(0, 5)
        .map((p) => escapeHtml((p.hole ? "hole " + p.hole + ", " : "") + (p.field ? p.field + ": " : "") + p.message));
      lines.push("<li class=\"bad\">" + escapeHtml(submission.date) + ": " + escapeHtml(stored.body.detail)
        + (problems.length ? " (" + problems.join("; ") + ")" : "") + "</li>");
    }
  }
  return accountResponse(env, session, "<div class=\"note\"><p>Upload done:</p><ul>" + lines.join("") + "</ul></div>");
}

async function accountLogout(request, env) {
  const got = await accountForm(request, env);
  if (got.refused) {
    return got.refused;
  }
  await env.DB.prepare("DELETE FROM sessions WHERE token_sha256 = ?").bind(await sha256Hex(got.session.token)).run();
  return htmlWithCookies(200, page("Signed out", "<h1>Signed out</h1>\n<p class=\"knopf\"><a class=\"btn\" href=\"" + SITE + "/\">Back to OpenPinsheet</a></p>"), [
    SESSION_COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=" + ACCOUNT_PATH + "; Max-Age=0",
  ]);
}

// --- review of new data partners -------------------------------------------
//
// A new partner gets a mail to the operator with a signed link. The link opens
// a page; only its POST confirms or blocks, so a mail scanner that follows
// links changes nothing. The signature is an HMAC of the channel id with
// env.REVIEW_SECRET.

async function reviewSignature(env, channelId) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.REVIEW_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("review:" + channelId))));
}

async function reviewAllowed(env, channelId, signature) {
  if (!env.REVIEW_SECRET || typeof channelId !== "string" || typeof signature !== "string") {
    return false;
  }
  const expected = await reviewSignature(env, channelId);
  if (expected.length !== signature.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return difference === 0;
}

// The raw message for the operator. Plain text, no HTML.
export async function reviewMessage(env, partner) {
  const link = REVIEW_URL + "?channel=" + encodeURIComponent(partner.id)
    + "&sig=" + await reviewSignature(env, partner.id);
  const id = randomToken().slice(0, 24) + "@openpinsheet.com";
  const subject = "New data partner: " + partner.name.replace(/[^\x20-\x7e]/g, "?");
  return [
    "From: OpenPinsheet <" + REVIEW_FROM + ">",
    "To: " + REVIEW_TO,
    "Subject: " + subject,
    "Message-ID: <" + id + ">",
    "Date: " + new Date(partner.created).toUTCString(),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    "A data partner signed up and waits for the review.",
    "",
    "Name:    " + partner.name,
    "Channel: " + partner.id,
    "Website: " + (partner.website || "(none)"),
    "GitHub:  https://github.com/" + partner.login,
    "Time:    " + partner.created,
    "",
    "Its pins are live now. They go into the archive once you confirm, in your",
    "account (https://api.openpinsheet.com/v1/account#review) or with this link:",
    link,
    "",
  ].join("\r\n");
}

// Best effort: a failed mail must not stop the sign-up. The send_email
// binding REVIEW_MAIL only exists in the deployed worker; cloudflare:email is
// loaded only then, so the tests under Node never import it.
async function sendReviewMail(env, partner) {
  if (!env.REVIEW_MAIL || typeof env.REVIEW_MAIL.send !== "function") {
    return false;
  }
  try {
    const raw = await reviewMessage(env, partner);
    const { EmailMessage } = await import("cloudflare:email");
    await env.REVIEW_MAIL.send(new EmailMessage(REVIEW_FROM, REVIEW_TO, raw));
    return true;
  } catch (problem) {
    return false;
  }
}

async function reviewGet(env, url) {
  const channelId = url.searchParams.get("channel");
  const signature = url.searchParams.get("sig");
  if (!(await reviewAllowed(env, channelId, signature))) {
    return simplePage(403, "Link not valid", "This review link is not valid.");
  }
  const channel = await env.DB.prepare(
    "SELECT id, name, website, login, created, archive_from, blocked FROM channels WHERE id = ?",
  ).bind(channelId).first();
  if (!channel) {
    return simplePage(404, "No such partner", "The partner does not exist.");
  }
  const counts = await env.DB.prepare(
    "SELECT COUNT(*) AS days, COUNT(DISTINCT grp) AS grounds FROM days WHERE channel = ?",
  ).bind(channelId).first();
  const form = (action, label) => "<form class=\"inline\" method=\"post\" action=\"/v1/review\">"
    + "<input type=\"hidden\" name=\"channel\" value=\"" + escapeHtml(channelId) + "\">"
    + "<input type=\"hidden\" name=\"sig\" value=\"" + escapeHtml(signature) + "\">"
    + "<input type=\"hidden\" name=\"action\" value=\"" + action + "\"><button class=\"btn" + (action === "confirm" ? " btn-primary" : "") + "\">" + label + "</button></form> ";
  const inner = "<h1>Review " + escapeHtml(channel.name) + "</h1>\n<ul>"
    + "<li>Channel <code>" + escapeHtml(channel.id) + "</code></li>"
    + "<li>Website: " + (channel.website ? "<a href=\"" + escapeHtml(channel.website) + "\">" + escapeHtml(channel.website) + "</a>" : "none") + "</li>"
    + "<li>GitHub: <a href=\"https://github.com/" + escapeHtml(channel.login || "") + "\">" + escapeHtml(channel.login || "") + "</a></li>"
    + "<li>Signed up " + escapeHtml(String(channel.created).slice(0, 10)) + "; "
    + (counts ? Number(counts.grounds) : 0) + " grounds on " + (counts ? Number(counts.days) : 0) + " days so far</li>"
    + "<li>Status: " + (Number(channel.blocked) === 1 ? "blocked"
      : channel.archive_from ? "reviewed, archive from " + escapeHtml(channel.archive_from) : "waiting for review") + "</li></ul>\n"
    + "<p>" + form("confirm", "Confirm") + form("block", "Block") + "</p>\n"
    + "<p><small>Confirm: pins of days still open go into the archive. Block: the partner key stops working "
    + "and the pins of open days are deleted.</small></p>";
  return htmlWithCookies(200, page("Review", inner), []);
}

// Confirm or block one partner. Shared by the signed link (reviewPost) and
// the admin area of the account (accountReview). Returns the page to show.
async function reviewAction(env, channelId, action) {
  const today = isoDay(nowDate(env));
  if (action === "confirm") {
    // The earliest day still open: D closes at D + 3 days, so today - 2.
    const from = addDays(today, -2);
    // Only a partner that waits: a replayed confirm changes nothing once the
    // partner is reviewed, and a blocked partner stays blocked.
    const result = await env.DB.prepare(
      "UPDATE channels SET archive_from = ? WHERE id = ? AND archive_from IS NULL AND blocked = 0",
    ).bind(from, channelId).run();
    const changed = result && result.meta ? Number(result.meta.changes) || 0 : 0;
    if (changed === 0) {
      return { status: 409, title: "Nothing changed", text: "The partner is already reviewed or blocked." };
    }
    return { status: 200, title: "Confirmed", text: "Pins from " + escapeHtml(from) + " on go into the archive." };
  }
  if (action === "block") {
    const openFrom = addDays(today, -2);
    await env.DB.batch([
      env.DB.prepare("UPDATE keys SET active = 0 WHERE channel = ?").bind(channelId),
      // archive_from stays: the pins already archived stay in the year files,
      // like they stay in the day files that never change.
      env.DB.prepare("UPDATE channels SET blocked = 1 WHERE id = ?").bind(channelId),
      env.DB.prepare("DELETE FROM pins WHERE channel = ? AND date >= ?").bind(channelId, openFrom),
      env.DB.prepare("DELETE FROM days WHERE channel = ? AND date >= ?").bind(channelId, openFrom),
    ]);
    return { status: 200, title: "Blocked", text: "The partner key stopped working, and the pins of open days are deleted." };
  }
  return { status: 400, title: "Unknown action", text: "Choose confirm or block." };
}

async function reviewPost(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch (problem) {
    return simplePage(400, "Not a form", "The request did not carry a form.");
  }
  const channelId = form.get("channel");
  if (!(await reviewAllowed(env, channelId, form.get("sig")))) {
    return simplePage(403, "Link not valid", "This review link is not valid.");
  }
  const done = await reviewAction(env, channelId, form.get("action"));
  return simplePage(done.status, done.title, done.text);
}

// --- admin area of the account ---------------------------------------------
//
// The GitHub ids in env.ADMIN_GITHUB_IDS (comma-separated, wrangler.toml
// [vars]) see every data partner in their account and confirm or block it
// there. The ids are public anyway; what protects the area is the GitHub
// login behind the session, as for every other form of the account.

function isAdmin(env, session) {
  const ids = String(env.ADMIN_GITHUB_IDS || "").split(",").map((id) => id.trim()).filter(Boolean);
  return session !== null && ids.includes(String(session.githubId));
}

async function adminSection(env, session) {
  const result = await env.DB.prepare(
    "SELECT c.id, c.name, c.website, c.login, c.created, c.archive_from, c.blocked, "
    + "(SELECT COUNT(DISTINCT d.grp) FROM days d WHERE d.channel = c.id) AS grounds, "
    + "(SELECT COUNT(DISTINCT d.date) FROM days d WHERE d.channel = c.id) AS days "
    + "FROM channels c ORDER BY (c.archive_from IS NOT NULL OR c.blocked = 1), c.created DESC",
  ).all();
  const rows = result.results || [];
  const waiting = rows.filter((row) => row.archive_from === null && Number(row.blocked) === 0).length;
  let out = "<section id=\"review\">\n<h2>Data partners <span class=\"small\">(admin)</span></h2>\n"
    + "<p>" + (waiting === 0 ? "Nobody is waiting for review." : waiting + (waiting === 1 ? " partner waits" : " partners wait") + " for review.")
    + "</p>\n";
  for (const row of rows) {
    const blocked = Number(row.blocked) === 1;
    const reviewed = row.archive_from !== null && row.archive_from !== undefined;
    const mark = blocked ? "<span class=\"marke gesperrt\">Blocked</span>"
      : reviewed ? "<span class=\"marke\">Reviewed</span>" : "<span class=\"marke warten\">Waiting for review</span>";
    const button = (action, label, primary) => "<form class=\"inline\" method=\"post\" action=\"" + ACCOUNT_PATH + "/review\">"
      + hiddenCsrf(session) + "<input type=\"hidden\" name=\"channel\" value=\"" + escapeHtml(row.id) + "\">"
      + "<input type=\"hidden\" name=\"action\" value=\"" + action + "\">"
      + "<button class=\"btn btn-klein" + (primary ? " btn-primary" : "") + "\">" + label + "</button></form>";
    out += "<div class=\"karte\">\n<div class=\"zeile\"><h3><a href=\"" + ACCOUNT_PATH + "/partners/"
      + encodeURIComponent(row.id) + "\">" + escapeHtml(row.name) + "</a></h3>" + mark
      + (blocked ? "" : "<span class=\"aktionen\">" + (reviewed ? "" : button("confirm", "Confirm", true) + " ")
        + button("block", "Block", false) + "</span>") + "</div>\n"
      + "<p class=\"small\">Channel <span class=\"wert\">" + escapeHtml(row.id) + "</span>"
      + (row.website ? " \u00b7 <a href=\"" + escapeHtml(row.website) + "\">" + escapeHtml(row.website) + "</a>" : "")
      + (row.login ? " \u00b7 GitHub <a href=\"https://github.com/" + escapeHtml(row.login) + "\">" + escapeHtml(row.login) + "</a>" : " \u00b7 set up by hand")
      + " \u00b7 since " + escapeHtml(String(row.created).slice(0, 10))
      + " \u00b7 " + Number(row.grounds || 0) + " grounds on " + Number(row.days || 0) + " days"
      + (reviewed && !blocked ? " \u00b7 archive from " + escapeHtml(row.archive_from) : "") + "</p>\n</div>\n";
  }
  return out + "</section>\n";
}

// GET /v1/account/partners/<channel>: the review statistics of one partner,
// for the admin. Five queries: session, channel, and the days, pins and keys
// of the last 365 days (partnerstats.js computes and renders them).
async function accountPartnerDetail(request, env, channelId) {
  const session = await sessionFor(env, request);
  if (!session) {
    return signInPage();
  }
  if (!isAdmin(env, session)) {
    return simplePage(403, "Not allowed", "This account may not review data partners.");
  }
  const channel = await env.DB.prepare(
    "SELECT id, name, website, login, created, archive_from, blocked FROM channels WHERE id = ?",
  ).bind(channelId).first();
  if (!channel) {
    return simplePage(404, "No such partner", "The partner does not exist.");
  }
  const today = isoDay(nowDate(env));
  const since = addDays(today, -365);
  const days = await env.DB.prepare(
    "SELECT grp, date FROM days WHERE channel = ? AND date >= ?",
  ).bind(channelId, since).all();
  const pins = await env.DB.prepare(
    "SELECT grp, date, hole, lat, lon, source, accuracy_m, missing FROM pins WHERE channel = ? AND date >= ?",
  ).bind(channelId, since).all();
  const keys = await env.DB.prepare(
    "SELECT prefix, created, active FROM keys WHERE channel = ?",
  ).bind(channelId).all();
  const stats = computePartnerStats({
    days: days.results || [], pins: pins.results || [], keys: keys.results || [], today,
  });

  const blocked = Number(channel.blocked) === 1;
  const reviewed = channel.archive_from !== null && channel.archive_from !== undefined;
  const mark = blocked ? "<span class=\"marke gesperrt\">Blocked</span>"
    : reviewed ? "<span class=\"marke\">Reviewed</span>" : "<span class=\"marke warten\">Waiting for review</span>";
  const button = (action, label, primary) => "<form class=\"inline\" method=\"post\" action=\"" + ACCOUNT_PATH + "/review\">"
    + hiddenCsrf(session) + "<input type=\"hidden\" name=\"channel\" value=\"" + escapeHtml(channel.id) + "\">"
    + "<input type=\"hidden\" name=\"action\" value=\"" + action + "\">"
    + "<button class=\"btn btn-klein" + (primary ? " btn-primary" : "") + "\">" + label + "</button></form>";
  const inner = "<p class=\"small zurueck\"><a href=\"" + ACCOUNT_PATH + "#review\">\u2190 All data partners</a></p>\n"
    + "<div class=\"zeile\"><h1>" + escapeHtml(channel.name) + "</h1>" + mark
    + (blocked ? "" : "<span class=\"aktionen\">" + (reviewed ? "" : button("confirm", "Confirm", true) + " ")
      + button("block", "Block", false) + "</span>") + "</div>\n"
    + "<p class=\"small\">Channel <span class=\"wert\">" + escapeHtml(channel.id) + "</span>"
    + (channel.website ? " \u00b7 <a href=\"" + escapeHtml(channel.website) + "\">" + escapeHtml(channel.website) + "</a>" : "")
    + (channel.login ? " \u00b7 GitHub <a href=\"https://github.com/" + escapeHtml(channel.login) + "\">" + escapeHtml(channel.login) + "</a>" : " \u00b7 set up by hand")
    + " \u00b7 since " + escapeHtml(String(channel.created).slice(0, 10))
    + (reviewed && !blocked ? " \u00b7 archive from " + escapeHtml(channel.archive_from) : "") + "</p>\n"
    + renderPartnerStats(stats, escapeHtml)
    + "<p class=\"small\">The last 365 days.</p>";
  return htmlWithCookies(200, page(channel.name, inner), []);
}

async function accountReview(request, env) {
  const got = await accountForm(request, env);
  if (got.refused) {
    return got.refused;
  }
  if (!isAdmin(env, got.session)) {
    return simplePage(403, "Not allowed", "This account may not review data partners.");
  }
  const done = await reviewAction(env, String(got.form.get("channel") || ""), got.form.get("action"));
  const cls = done.status === 200 ? "note" : "note bad";
  return accountResponse(env, got.session, "<div class=\"" + cls + "\"><h3>" + escapeHtml(done.title) + "</h3><p>"
    + done.text + "</p></div>\n");
}

async function route(request, env, method) {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/v1/auth/github") {
      if (method === "GET") {
        return authStart(env);
      }
      return notAllowed("GET, HEAD");
    }
    if (url.pathname === "/v1/auth/github/callback") {
      if (method === "GET") {
        return await authCallback(request, env, url);
      }
      return notAllowed("GET, HEAD");
    }
    if (url.pathname === ACCOUNT_PATH) {
      if (method === "GET") {
        return await accountGet(request, env);
      }
      return notAllowed("GET, HEAD");
    }
    const accountActions = {
      "/v1/account/reader-key": accountReaderKey,
      "/v1/account/partner": accountPartner,
      "/v1/account/partner-key": accountPartnerKey,
      "/v1/account/upload": accountUpload,
      "/v1/account/logout": accountLogout,
      "/v1/account/review": accountReview,
    };
    const partnerPage = /^\/v1\/account\/partners\/([a-z0-9-]{2,40})$/.exec(url.pathname);
    if (partnerPage) {
      if (method === "GET") {
        return await accountPartnerDetail(request, env, partnerPage[1]);
      }
      return notAllowed("GET, HEAD");
    }
    if (Object.prototype.hasOwnProperty.call(accountActions, url.pathname)) {
      if (method === "POST") {
        return await accountActions[url.pathname](request, env);
      }
      return notAllowed("POST");
    }
    if (url.pathname === "/v1/review") {
      if (method === "GET") {
        return await reviewGet(env, url);
      }
      if (method === "POST") {
        return await reviewPost(request, env);
      }
      return notAllowed("GET, HEAD, POST");
    }
    if (url.pathname === "/v1/submissions") {
      if (method === "POST") {
        return await submissions(request, env, url);
      }
      if (method === "DELETE") {
        return await deleteSubmission(request, env, url);
      }
      return notAllowed("POST, DELETE");
    }
    if (url.pathname === "/v1/live") {
      if (method === "GET") {
        return await live(request, env, url);
      }
      if (method === "OPTIONS") {
        return optionsLive();
      }
      return notAllowed("GET, HEAD, OPTIONS", CORS);
    }
    if (url.pathname === "/v1/pins") {
      if (method === "GET") {
        return await history(request, env, url);
      }
      if (method === "OPTIONS") {
        return optionsLive();
      }
      return notAllowed("GET, HEAD, OPTIONS", CORS);
    }
    return error(404, "not_found");
  } catch (problem) {
    return error(500, "internal_error");
  }
}

export default {
  // HEAD is GET without the body (RFC 9110, 9.3.2), so it runs the same route
  // and is counted like one; the body is dropped here.
  async fetch(request, env) {
    const head = request.method.toUpperCase() === "HEAD";
    const response = await route(request, env, head ? "GET" : request.method.toUpperCase());
    if (head) {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  },

  async scheduled(event, env) {
    return runScheduled(event, env);
  },
};
