// Tests for api/src/partnerstats.js against API.md 3 (admin review page).
//
// Run from openpinsheet/ with:
//   mise exec node@24 -- node --test api/test/partnerstats.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { computePartnerStats, renderPartnerStats } from "../src/partnerstats.js";

const TODAY = "2027-03-02";

// Two grounds over several days. Ground "a" delivers on 20 and 21 February and
// on 1 March, ground "b" on 28 February and 1 March. The odd pin counts of "a"
// and the even counts of "b" cover both medians.
function sample() {
  const days = [
    { grp: "a", date: "2027-02-20" },
    { grp: "a", date: "2027-02-21" },
    { grp: "a", date: "2027-03-01" },
    { grp: "b", date: "2027-02-28" },
    { grp: "b", date: "2027-03-01" },
  ];
  const pins = [
    { grp: "a", date: "2027-02-20", hole: "1", lat: 10.0000011, lon: 20.0000031, source: "surveyed", accuracy_m: 0.03, missing: 0 },
    { grp: "a", date: "2027-02-20", hole: "2", lat: 10.0000021, lon: 20.0000031, source: "surveyed", accuracy_m: 0.05, missing: 0 },
    { grp: "a", date: "2027-02-20", hole: "3", lat: null, lon: null, source: null, accuracy_m: null, missing: 1 },
    { grp: "a", date: "2027-02-21", hole: "1", lat: 10.0000091, lon: 20.0000061, source: "mapped", accuracy_m: null, missing: 0 },
    { grp: "a", date: "2027-03-01", hole: "1", lat: null, lon: null, source: "estimated", accuracy_m: null, missing: 0 },
    { grp: "a", date: "2027-03-01", hole: "2", lat: null, lon: null, source: "detected", accuracy_m: null, missing: 0 },
    { grp: "b", date: "2027-02-28", hole: "1", lat: 30.0000151, lon: 40.0000151, source: "mapped", accuracy_m: null, missing: 0 },
    { grp: "b", date: "2027-02-28", hole: "2", lat: 30.0000171, lon: 40.0000171, source: "surveyed", accuracy_m: 0.01, missing: 0 },
    { grp: "b", date: "2027-03-01", hole: "1", lat: null, lon: null, source: "surveyed", accuracy_m: 0.07, missing: 0 },
    { grp: "b", date: "2027-03-01", hole: "2", lat: null, lon: null, source: null, accuracy_m: null, missing: 0 },
    { grp: "b", date: "2027-03-01", hole: "3", lat: null, lon: null, source: "detected", accuracy_m: null, missing: 0 },
    { grp: "b", date: "2027-03-01", hole: "4", lat: null, lon: null, source: null, accuracy_m: null, missing: 1 },
  ];
  const keys = [
    { prefix: "opp_old1", created: "2027-01-01T10:00:00Z", active: 0 },
    { prefix: "opp_old2", created: "2027-01-15T10:00:00Z", active: 0 },
    { prefix: "opp_older", created: "2027-01-20T10:00:00Z", active: 1 },
    { prefix: "opp_current", created: "2027-02-01T09:30:00Z", active: 1 },
  ];
  return { days, pins, keys, today: TODAY };
}

test("every field of the sample is exact", () => {
  const stats = computePartnerStats(sample());

  assert.deepEqual(stats.grounds, [
    { group: "a", lat: 10, lon: 20, days: 3, lastDate: "2027-03-01", holes: 2 },
    { group: "b", lat: 30.00002, lon: 40.00002, days: 2, lastDate: "2027-03-01", holes: 2 },
  ]);

  assert.equal(stats.lastDate, "2027-03-01");
  assert.equal(stats.pinsTotal, 12);
  assert.deepEqual(stats.sources, { estimated: 1, surveyed: 4, mapped: 2, detected: 2, none: 1 });
  assert.equal(stats.missingShare, 0.167);
  assert.equal(stats.medianAccuracy, 0.04);
  assert.deepEqual(stats.keys, {
    active: { prefix: "opp_current", created: "2027-02-01T09:30:00Z" },
    rotations: 2,
  });
});

test("last 30 days around a month boundary have the right dates and counts", () => {
  const { last30 } = computePartnerStats(sample());

  assert.equal(last30.length, 30);
  assert.equal(last30[0].date, "2027-02-01");
  assert.equal(last30[0].grounds, 0);
  assert.equal(last30[27].date, "2027-02-28");
  assert.equal(last30[27].grounds, 1);
  assert.equal(last30[28].date, "2027-03-01");
  assert.equal(last30[28].grounds, 2);
  assert.equal(last30[29].date, "2027-03-02");
  assert.equal(last30[29].grounds, 0);
});

test("empty inputs give an empty picture, not an error", () => {
  const stats = computePartnerStats({ days: [], pins: [], keys: [], today: TODAY });

  assert.deepEqual(stats.grounds, []);
  assert.equal(stats.lastDate, null);
  assert.equal(stats.last30.length, 30);
  assert.equal(stats.last30[0].date, "2027-02-01");
  assert.equal(stats.last30[29].date, "2027-03-02");
  assert.ok(stats.last30.every((day) => day.grounds === 0));
  assert.equal(stats.pinsTotal, 0);
  assert.deepEqual(stats.sources, { estimated: 0, surveyed: 0, mapped: 0, detected: 0, none: 0 });
  assert.equal(stats.missingShare, 0);
  assert.equal(stats.medianAccuracy, null);
  assert.deepEqual(stats.keys, { active: null, rotations: 0 });
});

// The stub the caller passes in, exactly as worker.js escapes.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

test("render escapes data, links only a ground with coordinates and draws 30 bars", () => {
  const stats = computePartnerStats({
    days: [
      { grp: "<b>x", date: "2027-03-01" },
      { grp: "plain", date: "2027-03-01" },
    ],
    pins: [
      { grp: "<b>x", date: "2027-03-01", hole: "1", lat: 52.1, lon: 13.1, source: "mapped", accuracy_m: null, missing: 0 },
      { grp: "plain", date: "2027-03-01", hole: "1", lat: null, lon: null, source: null, accuracy_m: null, missing: 1 },
    ],
    keys: [],
    today: TODAY,
  });

  const html = renderPartnerStats(stats, escapeHtml);

  assert.ok(html.includes("&lt;b&gt;x"), "the group is not escaped");
  assert.equal(html.includes("<b>x"), false, "the raw group leaked into the HTML");

  const links = html.match(/openstreetmap\.org/g) || [];
  assert.equal(links.length, 1, "not exactly one map link");
  assert.ok(html.includes("https://www.openstreetmap.org/?mlat=52.1&amp;mlon=13.1#map=17/52.1/13.1"), "wrong map URL");

  const bars = html.match(/<div style="[^"]*height:[0-9]+px;background:[^"]*"[^>]*title="[^"]*"><\/div>/g) || [];
  assert.equal(bars.length, 30, "not 30 bars");

  assert.ok(html.includes("Where it delivers"));
  assert.ok(html.includes("Last 30 days"));
  assert.ok(html.includes("Data"));
  assert.ok(html.includes("Keys"));
  assert.ok(html.includes("Last delivery: 2027-03-01"));
  assert.ok(html.includes("No active key"));
  assert.ok(html.includes("replaced 0 times"));
});

test("render of empty stats says so in plain words", () => {
  const stats = computePartnerStats({ days: [], pins: [], keys: [], today: TODAY });
  const html = renderPartnerStats(stats, escapeHtml);

  assert.ok(html.includes("No deliveries yet."));
  assert.ok(html.includes("No delivery yet"));
  assert.ok(html.includes("missing 0%"));
});
