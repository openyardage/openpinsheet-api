// Tests for api/src/worker.js against API.md 1 and 2. The D1 database and the
// R2 bucket come from api/test/fakes.mjs; nothing touches a network.
//
// Run from openpinsheet/ with a glob, because Node 24 no longer searches a
// directory argument to --test:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { addChannel, addKey, addReader, addReaderKey, createEnv } from "./fakes.mjs";

const DATE = "2027-04-12";
const YEAR = "2027";
const CLOSED = "2027-04-15";
const KEY = "test-key-openyardage";
const KEY_TWO = "test-key-greenkeeper";
const READER_KEY = "opr_test_reader_key";
const BASE = "https://api.openpinsheet.com";

function setup(now = "2027-04-12T12:00:00Z") {
  const env = createEnv(now);
  addChannel(env, "openyardage", "OpenYardage");
  addKey(env, "openyardage", KEY, 1);
  addChannel(env, "greenkeeper", "Greenkeeper");
  addKey(env, "greenkeeper", KEY_TWO, 1);
  const reader = addReader(env, 4242, "reader", 1);
  addReaderKey(env, reader, READER_KEY, 1, null);
  return env;
}

function located(hole, overrides) {
  return Object.assign({ hole, lat: 52.1234561, lon: 13.1234573, source: "mapped" }, overrides);
}

function submission(pins, date = DATE, group = "w620181682") {
  return { format: 1, group, date, pins };
}

function request(path, init) {
  return new Request(BASE + path, init);
}

function post(env, body, options = {}) {
  env.DB.startInvocation();
  const headers = { "Content-Type": "application/json" };
  if (options.key !== null) {
    headers.Authorization = "Bearer " + (options.key === undefined ? KEY : options.key);
  }
  Object.assign(headers, options.headers || {});
  const payload = options.raw === undefined ? JSON.stringify(body) : options.raw;
  return worker.fetch(request("/v1/submissions" + (options.query || ""), {
    method: "POST",
    headers,
    body: payload,
  }), env);
}

function remove(env, group, date, key = KEY) {
  env.DB.startInvocation();
  const headers = {};
  if (key !== null) {
    headers.Authorization = "Bearer " + key;
  }
  return worker.fetch(request("/v1/submissions?group=" + encodeURIComponent(group)
    + "&date=" + encodeURIComponent(date), { method: "DELETE", headers }), env);
}

function getLive(env, bbox) {
  env.DB.startInvocation();
  return worker.fetch(request("/v1/live?bbox=" + encodeURIComponent(bbox), {
    headers: { Authorization: "Bearer " + READER_KEY },
  }), env);
}

function count(env, table) {
  return env.DB.prepare("SELECT COUNT(*) AS n FROM " + table).first().n;
}

function fakeRequest(options) {
  const bytes = new TextEncoder().encode(options.body || "");
  return {
    method: options.method || "POST",
    url: BASE + (options.path || "/v1/submissions"),
    headers: new Headers(options.headers || {}),
    arrayBuffer: async () => bytes.buffer,
  };
}

test("unauthorized answers are 401 and the same text for missing, wrong and revoked keys", async () => {
  const env = setup();
  addKey(env, "openyardage", "revoked-key", 0);
  const answers = [];
  for (const key of [null, "wrong-key", "revoked-key"]) {
    const response = await post(env, submission([located("1")]), { key });
    assert.equal(response.status, 401);
    answers.push(await response.json());
  }
  assert.equal(answers[0].error, "unauthorized");
  assert.equal(typeof answers[0].detail, "string");
  assert.equal(answers[0].detail, answers[1].detail);
  assert.equal(answers[1].detail, answers[2].detail);
  assert.equal(count(env, "pins"), 0);
});

test("a body above 64 KiB is 413, also when only Content-Length says so", async () => {
  const env = setup();
  env.DB.startInvocation();
  const declared = await worker.fetch(fakeRequest({
    headers: { Authorization: "Bearer " + KEY, "Content-Length": "70000" },
    body: "{}",
  }), env);
  assert.equal(declared.status, 413);
  assert.equal((await declared.json()).error, "body_too_large");

  env.DB.startInvocation();
  const actual = await worker.fetch(fakeRequest({
    headers: { Authorization: "Bearer " + KEY },
    body: "x".repeat(70000),
  }), env);
  assert.equal(actual.status, 413);
  assert.equal((await actual.json()).error, "body_too_large");
  assert.equal(count(env, "pins"), 0);
});

test("a body that is not JSON is 400 invalid_json", async () => {
  const env = setup();
  const response = await post(env, null, { raw: "{not json" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_json");
});

test("a failed check is 422 with the problems", async () => {
  const env = setup();
  const response = await post(env, submission([located("1", { source: "gps" })]));
  assert.equal(response.status, 422);
  const answer = await response.json();
  assert.equal(answer.error, "invalid_submission");
  assert.equal(Array.isArray(answer.problems), true);
  assert.equal(answer.problems.some((problem) => problem.field === "source"), true);
  assert.equal(count(env, "pins"), 0);
});

test("dry_run checks and stores nothing", async () => {
  const env = setup();
  const response = await post(env, submission([located("1")]), { query: "?dry_run=1" });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(answer.stored, 0);
  assert.equal(answer.dry_run, true);
  assert.equal(answer.replaced, false);
  assert.equal(answer.visible_from, "2027-04-12T06:00:00Z");
  assert.equal(count(env, "pins"), 0);
  assert.equal(count(env, "days"), 0);
});

test("a second submission replaces the day and reports replaced", async () => {
  const env = setup();
  const first = await post(env, submission([located("1"), located("2")]));
  assert.equal(first.status, 200);
  const firstAnswer = await first.json();
  assert.equal(firstAnswer.stored, 2);
  assert.equal(firstAnswer.replaced, false);
  assert.equal(firstAnswer.visible_from, "2027-04-12T06:00:00Z");

  const second = await post(env, submission([located("1")]));
  assert.equal(second.status, 200);
  const secondAnswer = await second.json();
  assert.equal(secondAnswer.stored, 1);
  assert.equal(secondAnswer.replaced, true);

  const holes = await env.DB.prepare("SELECT hole FROM pins ORDER BY hole").all();
  assert.deepEqual(holes.results.map((row) => row.hole), ["1"]);
  const days = await env.DB.prepare("SELECT visible_from FROM days").all();
  assert.equal(days.results.length, 1);
  assert.equal(days.results[0].visible_from, "2027-04-12T06:00:00Z");
});

test("DELETE removes the pins of the group and day and answers deleted", async () => {
  const env = setup();
  await post(env, submission([located("1"), located("2")]));
  const first = await remove(env, "w620181682", DATE);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { deleted: 2 });
  assert.equal(count(env, "pins"), 0);
  assert.equal(count(env, "days"), 0);

  const again = await remove(env, "w620181682", DATE);
  assert.deepEqual(await again.json(), { deleted: 0 });
});

test("DELETE on a closed day is 409 day_closed", async () => {
  const env = setup(CLOSED + "T00:00:00Z");
  const response = await remove(env, "w620181682", DATE);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "day_closed");
});

test("live is empty before visible_from and shows the pin after it", async () => {
  const env = setup("2027-04-12T05:30:00Z");
  await post(env, submission([located("1", { lat: 52, lon: 13 })]));

  const before = await getLive(env, "12.9,51.9,13.1,52.1");
  assert.equal(before.status, 200);
  assert.equal((await before.json()).features.length, 0);

  env.NOW_ISO = "2027-04-12T06:30:00Z";
  const after = await getLive(env, "12.9,51.9,13.1,52.1");
  const data = await after.json();
  assert.equal(data.features.length, 1);
  assert.deepEqual(data.features[0].geometry.coordinates, [13, 52]);
  assert.equal(data.as_of, DATE);
});

test("live uses longitude 13 and -122 with the hours of API.md 2.1", async () => {
  const env = setup("2027-04-12T15:30:00Z");
  await post(env, submission([located("1", { lat: 52, lon: 13 })], DATE, "east"));
  await post(env, submission([located("1", { lat: 37, lon: -122 })], DATE, "west"));

  const east = await getLive(env, "12.9,51.9,13.1,52.1");
  const eastData = await east.json();
  assert.deepEqual(eastData.features[0].geometry.coordinates, [13, 52]);

  const west = await getLive(env, "-122.1,36.9,-121.9,37.1");
  const westData = await west.json();
  assert.deepEqual(westData.features[0].geometry.coordinates, [-122, 37]);
});

test("live keeps only the newest visible day per group", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  await post(env, submission([located("1")], "2027-04-11"));
  await post(env, submission([located("2")], DATE));

  const response = await getLive(env, "12.9,51.9,13.2,52.2");
  const data = await response.json();
  assert.equal(data.features.length, 1);
  assert.equal(data.features[0].properties.date, DATE);
  assert.equal(data.features[0].properties.hole, "2");
});

test("live carries the lost position of the same group and day", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  await post(env, submission([located("1"), { hole: "9", missing: true }]));

  const response = await getLive(env, "12.9,51.9,13.2,52.2");
  const data = await response.json();
  assert.equal(data.features.length, 2);
  const lost = data.features.find((feature) => feature.properties.hole === "9");
  assert.ok(lost, "the lost position is missing from the live answer");
  assert.equal(lost.geometry, null);
  assert.equal("channel" in lost.properties, false);
});

test("live rejects a large or malformed box and sends the CORS header", async () => {
  const env = setup();
  const large = await getLive(env, "12,52,13,52.1");
  assert.equal(large.status, 400);
  const largeAnswer = await large.json();
  assert.equal(largeAnswer.error, "bbox_too_large");
  assert.equal(large.headers.get("Access-Control-Allow-Origin"), "*");

  const malformed = await getLive(env, "a,b,c,d");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, "invalid_bbox");

  env.DB.startInvocation();
  const options = await worker.fetch(request("/v1/live", { method: "OPTIONS" }), env);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(options.headers.get("Access-Control-Allow-Methods"), /GET/);

  const good = await getLive(env, "12.9,51.9,13.1,52.1");
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("Content-Type"), "application/geo+json");
  assert.equal(good.headers.get("Cache-Control"), "private, max-age=300");
  assert.equal(good.headers.get("Access-Control-Allow-Origin"), "*");
});

test("a 401 is a problem document and names the Bearer scheme (RFC 9110, 15.5.2)", async () => {
  const env = setup();
  const response = await post(env, submission([located("1")]), { key: null });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("Content-Type"), "application/problem+json");
  assert.equal(response.headers.get("WWW-Authenticate"), "Bearer realm=\"openpinsheet\"");
  assert.deepEqual(await response.json(), {
    type: "about:blank", title: "Unauthorized", status: 401,
    detail: "a valid key is required in the header Authorization: Bearer", error: "unauthorized",
  });
});

test("a rejected submission is a 422 problem document with its problems", async () => {
  const env = setup();
  const response = await post(env, Object.assign(submission([located("1")]), { format: 2 }));
  assert.equal(response.status, 422);
  assert.equal(response.headers.get("Content-Type"), "application/problem+json");
  const body = await response.json();
  assert.equal(body.type, "about:blank");
  assert.equal(body.title, "Unprocessable Content");
  assert.equal(body.status, 422);
  assert.equal(body.error, "invalid_submission");
  assert.equal(body.problems[0].field, "format");
});

test("dry_run takes true and 1, false and 0 store, anything else is 400", async () => {
  for (const flag of ["true", "1"]) {
    const env = setup();
    const response = await post(env, submission([located("1")]), { query: "?dry_run=" + flag });
    assert.equal(response.status, 200, flag);
    assert.equal((await response.json()).dry_run, true, flag);
    assert.equal(count(env, "pins"), 0, flag);
  }
  for (const flag of ["false", "0"]) {
    const env = setup();
    const response = await post(env, submission([located("1")]), { query: "?dry_run=" + flag });
    assert.equal(response.status, 200, flag);
    assert.equal(count(env, "pins"), 1, flag);
  }
  // Until 19.10.2026 these stored for real.
  for (const flag of ["yes", "TRUE", "on", ""]) {
    const env = setup();
    const response = await post(env, submission([located("1")]), { query: "?dry_run=" + flag });
    assert.equal(response.status, 400, flag);
    assert.equal((await response.json()).error, "invalid_dry_run", flag);
    assert.equal(count(env, "pins"), 0, flag);
  }
});

test("a 405 lists the methods the path takes (RFC 9110, 15.5.6)", async () => {
  const env = setup();
  const cases = [
    ["/v1/submissions", "GET", "POST, DELETE"],
    ["/v1/live", "PUT", "GET, HEAD, OPTIONS"],
    ["/v1/pins", "POST", "GET, HEAD, OPTIONS"],
    ["/v1/auth/github", "POST", "GET, HEAD"],
    ["/v1/account/partner", "GET", "POST"],
  ];
  for (const [path, method, allow] of cases) {
    env.DB.startInvocation();
    const response = await worker.fetch(request(path, { method }), env);
    assert.equal(response.status, 405, method + " " + path);
    assert.equal(response.headers.get("Allow"), allow, method + " " + path);
  }
});

test("HEAD on /v1/live is GET without the body", async () => {
  const env = setup();
  env.DB.startInvocation();
  const response = await worker.fetch(request("/v1/live?bbox=" + encodeURIComponent("12.9,51.9,13.1,52.1"), {
    method: "HEAD",
    headers: { Authorization: "Bearer " + READER_KEY },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/geo+json");
  assert.match(response.headers.get("ETag"), /^"[0-9a-f]{32}"$/);
  assert.equal(await response.text(), "");
});

test("unknown paths are 404 and wrong methods are 405", async () => {
  const env = setup();
  env.DB.startInvocation();
  const missing = await worker.fetch(request("/v1/nothing"), env);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "not_found");

  env.DB.startInvocation();
  const wrong = await worker.fetch(request("/v1/submissions"), env);
  assert.equal(wrong.status, 405);
  assert.equal((await wrong.json()).error, "method_not_allowed");
});

test("play_bearing_deg and correction go through D1 into live, pins and the day file", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  const submitted = await post(env, submission([
    located("2", {
      source: "estimated", front_m: 12, left_m: 9.5,
      input: { front: 12, offset: 5, side: "right", unit: "m" },
      play_bearing_deg: 274.5,
    }),
    located("3", { source: "surveyed", accuracy_m: 0.03, correction: "ppk" }),
    { hole: "9", missing: true },
  ]));
  assert.equal(submitted.status, 200);

  const byHole = (data) => Object.fromEntries(
    data.features.map((feature) => [feature.properties.hole, feature.properties]));

  const live = byHole(await (await getLive(env, "12.9,51.9,13.2,52.2")).json());
  assert.equal(live["2"].play_bearing_deg, 274.5);
  assert.equal(live["3"].correction, "ppk");
  assert.equal("correction" in live["2"], false);
  assert.deepEqual(live["9"], { date: DATE, date_basis: "local", hole: "9", missing: true });

  env.NOW_ISO = CLOSED + "T12:00:00Z";
  env.DB.startInvocation();
  const history = await worker.fetch(request("/v1/pins?bbox=12.9,51.9,13.2,52.2&from=" + DATE
    + "&to=" + DATE, { headers: { Authorization: "Bearer " + READER_KEY } }), env);
  assert.equal(history.status, 200);
  const pins = byHole(await history.json());
  assert.equal(pins["2"].play_bearing_deg, 274.5);
  assert.equal(pins["3"].correction, "ppk");

  env.DB.startInvocation();
  const report = await worker.scheduled({}, env);
  assert.deepEqual(report.written, [DATE]);
  const csv = await (await env.BUCKET.get("v1/days/" + DATE + ".csv")).text();
  const lines = csv.split("\r\n");
  assert.ok(lines.includes(
    "date,date_basis,hole,lat,lon,source,accuracy_m,front_m,left_m,input_front,input_offset,"
    + "input_side,input_unit,channel,missing,play_bearing_deg,correction"));
  assert.ok(lines.includes(DATE + ",local,2,52.1234561,13.1234573,estimated,,12,9.5,12,5,right,m,openyardage,,274.5,"));
  assert.ok(lines.includes(DATE + ",local,3,52.1234561,13.1234573,surveyed,0.03,,,,,,,openyardage,,,ppk"));
  assert.ok(lines.includes(DATE + ",local,9,,,,,,,,,,,,1,,"));
});

test("scheduled writes only closed days, then years and the index", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  const submitted = await post(env, submission([
    located("2", {
      source: "estimated", front_m: 12, left_m: 9.5,
      input: { front: 12, offset: 5, side: "right", unit: "m" },
    }),
    located("10", { source: "surveyed", accuracy_m: 0.03 }),
    { hole: "11", missing: true },
  ]));
  assert.equal(submitted.status, 200);

  env.NOW_ISO = "2027-04-14T00:00:00Z";
  env.DB.startInvocation();
  const early = await worker.scheduled({}, env);
  assert.deepEqual(early.written, []);
  assert.equal(env.BUCKET.objects.size, 0);

  env.NOW_ISO = CLOSED + "T00:00:00Z";
  env.DB.startInvocation();
  const report = await worker.scheduled({}, env);
  assert.equal(report.ok, true);
  assert.deepEqual(report.written, [DATE]);
  assert.deepEqual(report.years, [YEAR]);
  assert.equal(report.errors.length, 0);

  const dayCsvFile = await env.BUCKET.get("v1/days/" + DATE + ".csv");
  const dayGeoFile = await env.BUCKET.get("v1/days/" + DATE + ".geojson");
  const yearFile = await env.BUCKET.get("v1/years/" + YEAR + ".csv");
  const indexFile = await env.BUCKET.get("v1/index.json");
  assert.ok(dayCsvFile);
  assert.ok(dayGeoFile);
  assert.ok(yearFile);
  assert.ok(indexFile);
  assert.equal(dayCsvFile.httpMetadata.contentType, "text/csv; charset=utf-8; header=present");
  assert.equal(dayCsvFile.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  assert.equal(dayGeoFile.httpMetadata.contentType, "application/geo+json");
  assert.equal(indexFile.httpMetadata.contentType, "application/json");
  assert.equal(indexFile.httpMetadata.cacheControl, "public, max-age=300");

  const index = JSON.parse(await indexFile.text());
  const paths = index.files.map((file) => file.path);
  assert.deepEqual(paths, [
    "days/" + DATE + ".csv",
    "days/" + DATE + ".geojson",
    "years/" + YEAR + ".csv",
  ]);
  const dayEntry = index.files.find((file) => file.path === "days/" + DATE + ".csv");
  assert.equal(dayEntry.rows, 3);
});

test("a second scheduled run writes nothing new", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  await post(env, submission([located("1")]));
  env.NOW_ISO = CLOSED + "T00:00:00Z";
  env.DB.startInvocation();
  await worker.scheduled({}, env);
  const keys = Array.from(env.BUCKET.objects.keys()).sort();
  const before = await env.BUCKET.get("v1/index.json").then((object) => object.text());

  env.DB.startInvocation();
  const second = await worker.scheduled({}, env);
  assert.deepEqual(second.written, []);
  assert.deepEqual(Array.from(env.BUCKET.objects.keys()).sort(), keys);
  const after = await env.BUCKET.get("v1/index.json").then((object) => object.text());
  assert.equal(after, before);
});

test("scheduled reports an existing bucket object and does not overwrite it", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  await post(env, submission([located("1")]));
  await env.BUCKET.put("v1/days/" + DATE + ".csv", "sentinel");
  env.NOW_ISO = CLOSED + "T00:00:00Z";

  env.DB.startInvocation();
  const report = await worker.scheduled({}, env);
  assert.equal(report.ok, false);
  assert.equal(report.written.length, 0);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].path, "v1/days/" + DATE + ".csv");
  assert.equal(await env.BUCKET.get("v1/days/" + DATE + ".csv").then((object) => object.text()), "sentinel");
  assert.equal(await env.BUCKET.head("v1/days/" + DATE + ".geojson"), null);
});

// D1 limits of 17.10.2026: 50 statements and at most 100 bound parameters per
// statement. The old worker sent one INSERT per pin (152 statements for 150
// pins); the fake turns that red, so the test below proves the json_each form.
test("a submission with 150 pins passes and needs at most 5 queries", async () => {
  const env = setup();
  const pins = [];
  for (let index = 0; index < 150; index += 1) {
    pins.push(located(String(index + 1), { lat: 52.1234561, lon: 13.1234573 }));
  }
  const response = await post(env, submission(pins));
  assert.equal(response.status, 200);
  const statements = env.DB.statements;
  assert.ok(statements <= 5, "the submission used " + statements + " statements");
  assert.equal((await response.json()).stored, 150);
  assert.equal(count(env, "pins"), 150);
});

test("the D1 fake enforces the platform limits of one invocation", async () => {
  const env = setup();
  assert.throws(() => {
    env.DB.prepare("SELECT ?").bind(...new Array(101).fill(1)).all();
  }, /bound parameters/);
  assert.throws(() => {
    env.DB.prepare("SELECT 1 -- " + "x".repeat(100000)).all();
  }, /characters of SQL/);
  env.DB.startInvocation();
  for (let index = 0; index < 50; index += 1) {
    env.DB.prepare("SELECT 1 AS n").all();
  }
  assert.throws(() => env.DB.prepare("SELECT 1 AS n").all(), /statements/);
});

test("scheduled writes at most five days per run and stays within 40 queries", async () => {
  const env = setup("2027-04-01T12:00:00Z");
  const dates = [
    "2027-04-01", "2027-04-02", "2027-04-03", "2027-04-04",
    "2027-04-05", "2027-04-06", "2027-04-07",
  ];
  for (const date of dates) {
    env.NOW_ISO = date + "T12:00:00Z";
    const response = await post(env, submission([located("1")], date, "cap"));
    assert.equal(response.status, 200);
  }

  env.NOW_ISO = "2027-05-01T00:00:00Z";
  env.DB.startInvocation();
  const first = await worker.scheduled({}, env);
  const used = env.DB.statements;
  assert.equal(first.errors.length, 0);
  assert.equal(first.written.length, 5, "the first run wrote " + first.written.length + " days");
  assert.ok(used <= 40, "the run used " + used + " statements");

  env.DB.startInvocation();
  const second = await worker.scheduled({}, env);
  assert.equal(second.errors.length, 0);
  assert.equal(second.written.length, 2, "the second run wrote " + second.written.length + " days");
});

test("an object written before an abort is taken over when its content matches", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  assert.equal((await post(env, submission([located("1")]))).status, 200);
  env.NOW_ISO = CLOSED + "T00:00:00Z";

  const base = env.BUCKET;
  let puts = 0;
  env.BUCKET = {
    put(key, body, options) {
      if (key === "v1/days/" + DATE + ".csv") {
        puts += 1;
      }
      return base.put(key, body, options).then((value) => {
        if (puts === 1) {
          throw new Error("abort after the first put");
        }
        return value;
      });
    },
    get: (key) => base.get(key),
    head: (key) => base.head(key),
    list: (prefix) => base.list(prefix),
  };

  env.DB.startInvocation();
  await assert.rejects(worker.scheduled({}, env));
  assert.equal(count(env, "files"), 0);

  env.BUCKET = base;
  env.DB.startInvocation();
  const second = await worker.scheduled({}, env);
  assert.equal(second.errors.length, 0);
  assert.deepEqual(second.written, [DATE]);
  assert.equal(count(env, "files"), 3);
  assert.ok(await base.head("v1/days/" + DATE + ".geojson"));
  assert.ok(await base.head("v1/index.json"));
});

test("a run that stops before the index is completed by the next run", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  assert.equal((await post(env, submission([located("1")]))).status, 200);
  env.NOW_ISO = CLOSED + "T00:00:00Z";

  const base = env.BUCKET;
  let fail = true;
  env.BUCKET = {
    put(key, body, options) {
      if (fail && key === "v1/index.json") {
        fail = false;
        return Promise.reject(new Error("abort before the index"));
      }
      return base.put(key, body, options);
    },
    get: (key) => base.get(key),
    head: (key) => base.head(key),
    list: (prefix) => base.list(prefix),
  };

  env.DB.startInvocation();
  await assert.rejects(worker.scheduled({}, env));
  const dirty = await env.DB.prepare("SELECT value FROM state WHERE key = 'dirty'").first();
  assert.equal(dirty && dirty.value, "1");
  assert.equal(await base.head("v1/index.json"), null);

  env.BUCKET = base;
  env.DB.startInvocation();
  const second = await worker.scheduled({}, env);
  assert.deepEqual(second.written, []);
  assert.ok(await base.head("v1/index.json"));
  const after = await env.DB.prepare("SELECT value FROM state WHERE key = 'dirty'").first();
  assert.equal(after && after.value, "0");
});

test("live carries a row without coordinate once its ground has one in the box", async () => {
  const env = setup("2027-04-12T12:00:00Z");
  const response = await post(env, submission([
    located("1", { lat: 52, lon: 13 }),
    { hole: "2", front_m: 12, left_m: 9.5 },
  ]));
  assert.equal(response.status, 200);

  const live = await getLive(env, "12.9,51.9,13.1,52.1");
  const data = await live.json();
  assert.equal(data.features.length, 2);
  const without = data.features.find((feature) => feature.properties.hole === "2");
  assert.ok(without, "the row without a coordinate is missing from the live answer");
  assert.equal(without.geometry, null);
  assert.equal(without.properties.front_m, 12);
  assert.equal(without.properties.left_m, 9.5);
});

test("a streamed body without Content-Length is stopped at 64 KiB", async () => {
  const env = setup();
  let sent = false;
  let readPast = false;
  // highWaterMark 0 keeps the stream from pulling the next chunk while the
  // first one is still being read, so the read past the limit is the worker's
  // and not the stream's own prefetching.
  const stream = new ReadableStream({
    pull(controller) {
      if (sent === false) {
        sent = true;
        controller.enqueue(new Uint8Array(70000));
        return;
      }
      if (readPast === false) {
        readPast = true;
        controller.error(new Error("read past the limit"));
      }
    },
  }, { highWaterMark: 0 });
  const streamed = new Request(BASE + "/v1/submissions", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  });
  assert.equal(streamed.headers.get("Content-Length"), null);

  env.DB.startInvocation();
  const response = await worker.fetch(streamed, env);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "body_too_large");
  assert.equal(readPast, false, "the worker read past the 64 KiB limit");
});

test("a missing key comes before size and JSON", async () => {
  const env = setup();
  const response = await post(env, null, { key: null, raw: "{not json" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "unauthorized");
});
