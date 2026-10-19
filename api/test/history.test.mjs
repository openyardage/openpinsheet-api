// Tests for GET /v1/pins, the closed days of a range (API.md 2.3): the same
// key, limits and box rule as /v1/live, but a fixed range of past days. The D1
// database comes from api/test/fakes.mjs; nothing touches a network.
//
// Run from openpinsheet/ with a glob:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { addChannel, addReader, addReaderKey, createEnv, hashKey, problemOf } from "./fakes.mjs";

const BASE = "https://api.openpinsheet.com";
const READER_KEY = "opr_test_reader_key";
const BBOX = "12.9,51.9,13.1,52.1";
// The clock of the tests. A day is closed from day + 3 days, so every day up
// to 2027-04-09 is closed, and 2027-04-10 is not.
const NOW = "2027-04-12T12:00:00Z";
const TODAY = "2027-04-12";
const RANGE = { bbox: BBOX, from: "2027-04-01", to: "2027-04-05" };

function setup() {
  const env = createEnv(NOW);
  const reader = addReader(env, 4242, "reader", 1);
  addReaderKey(env, reader, READER_KEY, 1, null);
  return env;
}

// The same cell rule as api/src/worker.js, so the box query finds the rows.
function cellFor(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") {
    return null;
  }
  const floor = (value) => Math.floor(value * 10 + 1e-9);
  return floor(lat) * 10000 + floor(lon) + 1800;
}

function addPin(env, pin) {
  env.DB.prepare(
    "INSERT INTO pins (channel, grp, date, hole, lat, lon, source, accuracy_m, "
    + "front_m, left_m, missing, cell) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    pin.channel, pin.grp, pin.date, pin.hole,
    pin.lat === undefined ? null : pin.lat,
    pin.lon === undefined ? null : pin.lon,
    pin.source === undefined ? null : pin.source,
    pin.accuracy_m === undefined ? null : pin.accuracy_m,
    pin.front_m === undefined ? null : pin.front_m,
    pin.left_m === undefined ? null : pin.left_m,
    pin.missing === true ? 1 : 0,
    cellFor(pin.lat, pin.lon),
  ).run();
}

// One ground inside the box on 2027-04-03: hole 1 with a position (finding the
// ground) and hole 2 without one (carried along by the ground rule). Hole 3 of
// the same ground lies a day earlier, still inside the range. Then the
// controls: a ground far outside the box, a ground without any coordinate, and
// a closed day after the range ends.
function seed(env) {
  for (const id of ["alpha", "beta", "delta", "gamma"]) {
    addChannel(env, id, id);
  }
  addPin(env, { channel: "alpha", grp: "g1", date: "2027-04-03", hole: "1",
    lat: 52.0, lon: 13.0, source: "surveyed", accuracy_m: 0.5 });
  addPin(env, { channel: "alpha", grp: "g1", date: "2027-04-03", hole: "2", missing: true });
  addPin(env, { channel: "alpha", grp: "g1", date: "2027-04-02", hole: "3",
    lat: 52.01, lon: 13.01, source: "mapped" });
  addPin(env, { channel: "beta", grp: "g2", date: "2027-04-03", hole: "1",
    lat: 10.0, lon: 10.0, source: "mapped" });
  addPin(env, { channel: "delta", grp: "g4", date: "2027-04-03", hole: "1", missing: true });
  addPin(env, { channel: "gamma", grp: "g3", date: "2027-04-08", hole: "1",
    lat: 52.0, lon: 13.0, source: "mapped" });
}

function pinsRequest(key, query, options = {}) {
  const headers = {};
  if (key !== undefined) {
    headers.Authorization = "Bearer " + key;
  }
  Object.assign(headers, options.headers || {});
  const params = new URLSearchParams(query === undefined ? RANGE : query);
  return new Request(BASE + "/v1/pins?" + params.toString(), { headers });
}

function getPins(env, key, query, options) {
  env.DB.startInvocation();
  return worker.fetch(pinsRequest(key, query, options), env);
}

test("pins without a key is 401 unauthorized and counts nothing", async () => {
  const env = setup();
  seed(env);
  const response = await getPins(env, undefined);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Content-Type"), "application/problem+json");
  assert.equal(response.headers.get("WWW-Authenticate"), "Bearer realm=\"openpinsheet\"");
  assert.deepEqual(await response.json(),
    problemOf(401, "Unauthorized", "unauthorized", "a valid key is required in the header Authorization: Bearer"));
  const usage = await env.DB.prepare("SELECT COUNT(*) AS n FROM reader_days").first();
  assert.equal(usage.n, 0);
});

test("a closed range returns only the rows inside the range and the box", async () => {
  const env = setup();
  seed(env);
  const response = await getPins(env, READER_KEY);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/geo+json");
  assert.equal(response.headers.get("Cache-Control"), "private, max-age=86400");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Authorization");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "1000");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "999");

  const data = await response.json();
  assert.equal(data.type, "FeatureCollection");
  assert.equal(data.format, 1);
  assert.equal(data.as_of, "2027-04-05");
  assert.equal(data.notes[0], "OpenPinsheet pins from 2027-04-01 to 2027-04-05. Format 1.");

  // Sorted by FORMAT.md 2.2: date, then hole.
  assert.deepEqual(
    data.features.map((feature) => feature.properties.date),
    ["2027-04-02", "2027-04-03", "2027-04-03"],
  );
  assert.deepEqual(
    data.features.map((feature) => feature.properties.hole),
    ["3", "1", "2"],
  );
  // The control rows are gone: beta lies outside the box, gamma outside the
  // range, delta has no coordinate at all. A lost position carries no channel.
  const channels = new Set(data.features.map((feature) => feature.properties.channel)
    .filter((channel) => channel !== undefined));
  assert.deepEqual([...channels].sort(), ["alpha"]);
});

test("a row without a coordinate comes with a ground that is in the box", async () => {
  const env = setup();
  seed(env);
  const response = await getPins(env, READER_KEY);
  const data = await response.json();
  const byHole = new Map(data.features.map((feature) => [feature.properties.hole, feature]));

  const missing = byHole.get("2");
  assert.ok(missing, "the lost position of the ground in the box is missing");
  assert.equal(missing.geometry, null);
  assert.equal(missing.properties.missing, true);
  assert.equal("channel" in missing.properties, false);

  // The rows with a coordinate read exactly like a published day file.
  assert.deepEqual(byHole.get("1").geometry, { type: "Point", coordinates: [13, 52] });
  assert.equal(byHole.get("1").properties.channel, "alpha");
});

test("from after to is invalid_range", async () => {
  const env = setup();
  const response = await getPins(env, READER_KEY, { bbox: BBOX, from: "2027-04-05", to: "2027-04-01" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), problemOf(400, "Bad Request", "invalid_range",
    "from and to must be dates, from not after to, at most 31 days"));
});

test("a span of 32 days is invalid_range", async () => {
  const env = setup();
  // 2027-03-05 to 2027-04-05 is 31 days apart, so 32 days including both ends.
  const response = await getPins(env, READER_KEY, { bbox: BBOX, from: "2027-03-05", to: "2027-04-05" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_range");
});

test("a to that is not closed is range_not_closed", async () => {
  const env = setup();
  seed(env);
  // 2027-04-10 + 3 days is 2027-04-13, still after today.
  const response = await getPins(env, READER_KEY, { bbox: BBOX, from: "2027-04-09", to: "2027-04-10" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), problemOf(400, "Bad Request", "range_not_closed",
    "to must be a closed day; today's pins come from /v1/live"));
});

test("a box larger than 0.5 by 0.5 degrees is bbox_too_large", async () => {
  const env = setup();
  const response = await getPins(env, READER_KEY, { bbox: "12,51,13,52", from: "2027-04-01", to: "2027-04-05" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), problemOf(400, "Bad Request", "bbox_too_large",
    "bbox is larger than 0.5 by 0.5 degrees"));
});

test("the day counter is shared with /v1/live", async () => {
  const env = setup();
  env.DB.startInvocation();
  const liveResponse = await worker.fetch(
    new Request(BASE + "/v1/live?bbox=" + encodeURIComponent(BBOX), {
      headers: { Authorization: "Bearer " + READER_KEY },
    }),
    env,
  );
  assert.equal(liveResponse.status, 200);
  const pinsResponse = await getPins(env, READER_KEY);
  assert.equal(pinsResponse.status, 200);
  assert.equal(pinsResponse.headers.get("X-RateLimit-Remaining"), "998");

  const usage = await env.DB.prepare(
    "SELECT d.count FROM reader_days d JOIN reader_keys k ON k.reader_id = d.reader_id "
    + "WHERE k.key_sha256 = ? AND d.day = ?",
  ).bind(hashKey(READER_KEY), TODAY).first();
  assert.equal(usage.count, 2);
});

test("OPTIONS /v1/pins answers 204 with the CORS headers", async () => {
  const env = setup();
  env.DB.startInvocation();
  const response = await worker.fetch(new Request(BASE + "/v1/pins", { method: "OPTIONS" }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, OPTIONS");
  assert.equal(response.headers.get("Access-Control-Allow-Headers"), "Authorization");
  assert.equal(response.headers.get("Access-Control-Max-Age"), "7200");
});

test("pins of a data partner waiting for review stay out, like in the files", async () => {
  const env = setup();
  seed(env);
  addChannel(env, "omega", "Omega", null);
  addPin(env, { channel: "omega", grp: "g9", date: "2027-04-03", hole: "1",
    lat: 52.0, lon: 13.0, source: "mapped" });
  const response = await getPins(env, READER_KEY, "bbox=" + BBOX + "&from=2027-04-01&to=2027-04-05");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.features.some((f) => f.properties.channel === "omega"), false);
  assert.equal(body.features.some((f) => f.properties.channel === "alpha"), true);
});
