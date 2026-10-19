// Tests for api/src/core.js against API.md 1 and FORMAT.md 2, 2.1 and 2.2.
//
// Run from openpinsheet/ with a glob, because Node 24 no longer searches a
// directory argument to --test:
//   mise exec node@24 -- node --test 'api/test/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";

import {
  checkSubmission,
  decimalsOf,
  formatNumber,
  isClosed,
  liveGeojson,
  selectLive,
  visibleFrom,
} from "../src/core.js";

const TODAY = "2027-04-12";

function one(pin) {
  return { format: 1, group: "w620181682", date: TODAY, pins: [pin] };
}

function validPin(overrides) {
  return Object.assign({ hole: "1", lat: 52.0, lon: 13.0, source: "mapped" }, overrides);
}

function hasField(problems, field) {
  return problems.some((problem) => problem.field === field);
}

test("the example of API.md 1 is valid", () => {
  const body = {
    format: 1,
    group: "w620181682",
    date: "2027-04-12",
    pins: [
      { hole: "7", lat: 52.1234561, lon: 13.1234573, source: "estimated",
        front_m: 12, left_m: 9.5,
        input: { front: 12, offset: 5, side: "right", unit: "m" } },
      { hole: "8", lat: 52.1241077, lon: 13.122915, source: "surveyed", accuracy_m: 0.03 },
      { hole: "9", missing: true },
    ],
  };
  const result = checkSubmission(body, "2027-04-12");
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins[0], {
    hole: "7", lat: 52.1234561, lon: 13.1234573, source: "estimated",
    front_m: 12, left_m: 9.5,
    input_front: 12, input_offset: 5, input_side: "right", input_unit: "m",
  });
  assert.deepEqual(result.pins[1], {
    hole: "8", lat: 52.1241077, lon: 13.122915, source: "surveyed", accuracy_m: 0.03,
  });
  assert.deepEqual(result.pins[2], { hole: "9", missing: true });
});

test("envelope format must be the integer 1", () => {
  const result = checkSubmission(Object.assign(one(validPin()), { format: 2 }), TODAY);
  assert.equal(result.ok, false);
  assert.equal(hasField(result.problems, "format"), true);
});

test("envelope group has the pattern of API.md 1.1", () => {
  for (const group of ["", "a b", "x".repeat(65), "ä"]) {
    const result = checkSubmission(Object.assign(one(validPin()), { group }), TODAY);
    assert.equal(hasField(result.problems, "group"), true, "group " + JSON.stringify(group));
  }
});

test("envelope date must be a real calendar date", () => {
  const result = checkSubmission(Object.assign(one(validPin()), { date: "2027-02-30" }), TODAY);
  assert.equal(hasField(result.problems, "date"), true);
});

test("envelope date lies within one day of today", () => {
  assert.equal(checkSubmission(Object.assign(one(validPin()), { date: "2027-04-11" }), TODAY).ok, true);
  assert.equal(checkSubmission(Object.assign(one(validPin()), { date: "2027-04-13" }), TODAY).ok, true);
  const far = checkSubmission(Object.assign(one(validPin()), { date: "2027-04-14" }), TODAY);
  assert.equal(hasField(far.problems, "date"), true);
  assert.equal(far.ok, false);
});

test("envelope pins holds 1 to 150 entries", () => {
  assert.equal(hasField(checkSubmission(Object.assign(one(validPin()), { pins: [] }), TODAY).problems, "pins"), true);
  assert.equal(hasField(checkSubmission(Object.assign(one(validPin()), { pins: "nope" }), TODAY).problems, "pins"), true);
  const many = [];
  for (let i = 0; i < 151; i += 1) {
    many.push({ hole: String(i + 1), lat: 52.0, lon: 13.0, source: "mapped" });
  }
  const result = checkSubmission(Object.assign(one(validPin()), { pins: many }), TODAY);
  assert.equal(hasField(result.problems, "pins"), true);
});

test("envelope pins may name a hole at most once", () => {
  const body = Object.assign(one(validPin()), {
    pins: [validPin({ hole: "3" }), validPin({ hole: "3" })],
  });
  const result = checkSubmission(body, TODAY);
  assert.equal(hasField(result.problems, "hole"), true);
  assert.equal(result.problems.find((problem) => problem.field === "hole").hole, "3");
});

test("pin hole has the pattern of FORMAT.md 2", () => {
  for (const hole of ["", "bad hole", "123456789"]) {
    const result = checkSubmission(one(validPin({ hole })), TODAY);
    assert.equal(hasField(result.problems, "hole"), true, "hole " + JSON.stringify(hole));
  }
});

test("pin coordinates stay in range", () => {
  assert.equal(hasField(checkSubmission(one(validPin({ lat: 91 })), TODAY).problems, "lat"), true);
  assert.equal(hasField(checkSubmission(one(validPin({ lat: -91 })), TODAY).problems, "lat"), true);
  assert.equal(hasField(checkSubmission(one(validPin({ lon: 181 })), TODAY).problems, "lon"), true);
  assert.equal(hasField(checkSubmission(one(validPin({ lon: -181 })), TODAY).problems, "lon"), true);
});

test("pin source is one of the four of FORMAT.md 3", () => {
  const result = checkSubmission(one(validPin({ source: "gps" })), TODAY);
  assert.equal(hasField(result.problems, "source"), true);
});

test("accuracy_m follows FORMAT.md 2.1 rule 5", () => {
  // required for surveyed and detected
  assert.equal(hasField(checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "surveyed" }), TODAY).problems, "accuracy_m"), true);
  assert.equal(hasField(checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "detected" }), TODAY).problems, "accuracy_m"), true);
  // greater than 0
  assert.equal(hasField(checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "surveyed", accuracy_m: 0 }), TODAY).problems, "accuracy_m"), true);
  // optional for mapped
  assert.equal(checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "mapped", accuracy_m: 0.5 }), TODAY).ok, true);
  // empty for estimated
  assert.equal(hasField(checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "estimated", accuracy_m: 0.5 }), TODAY).problems, "accuracy_m"), true);
});

test("front_m and left_m are not negative", () => {
  assert.equal(hasField(checkSubmission(one(validPin({ front_m: -1 })), TODAY).problems, "front_m"), true);
  assert.equal(hasField(checkSubmission(one(validPin({ left_m: -1 })), TODAY).problems, "left_m"), true);
});

test("lat and lon are given together", () => {
  assert.equal(hasField(checkSubmission(one({ hole: "1", lat: 52, source: "mapped" }), TODAY).problems, "lon"), true);
  assert.equal(hasField(checkSubmission(one({ hole: "1", lon: 13, source: "mapped" }), TODAY).problems, "lat"), true);
});

test("source is required when lat and lon are given", () => {
  const result = checkSubmission(one({ hole: "1", lat: 52, lon: 13, front_m: 1, left_m: 1 }), TODAY);
  assert.equal(hasField(result.problems, "source"), true);
});

test("front_m and left_m are given together or not at all", () => {
  const onlyFront = checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "mapped", front_m: 1 }), TODAY);
  assert.equal(hasField(onlyFront.problems, "left_m"), true);
  const onlyLeft = checkSubmission(one({ hole: "1", lat: 52, lon: 13, source: "mapped", left_m: 1 }), TODAY);
  assert.equal(hasField(onlyLeft.problems, "front_m"), true);
});

test("without source front_m and left_m are both required", () => {
  const result = checkSubmission(one({ hole: "1" }), TODAY);
  assert.equal(hasField(result.problems, "front_m"), true);
});

test("input is only allowed with source estimated and all four or none", () => {
  const partial = checkSubmission(one(validPin({
    source: "estimated", front_m: 1, left_m: 1, input: { front: 1 },
  })), TODAY);
  assert.equal(hasField(partial.problems, "input_offset"), true);

  const mapped = checkSubmission(one(validPin({
    input: { front: 1, offset: 2, side: "left", unit: "m" },
  })), TODAY);
  assert.equal(hasField(mapped.problems, "input_unit"), true);

  const complete = checkSubmission(one(validPin({
    source: "estimated", front_m: 1, left_m: 1,
    input: { front: 1, offset: 2, side: "left", unit: "yd" },
  })), TODAY);
  assert.equal(complete.ok, true);
  assert.equal(complete.pins[0].input_front, 1);
  assert.equal(complete.pins[0].input_offset, 2);
  assert.equal(complete.pins[0].input_side, "left");
  assert.equal(complete.pins[0].input_unit, "yd");
});

test("input_side and input_unit take the values of FORMAT.md 2", () => {
  const side = checkSubmission(one(validPin({
    source: "estimated", front_m: 1, left_m: 1,
    input: { front: 1, offset: 2, side: "middle", unit: "m" },
  })), TODAY);
  assert.equal(hasField(side.problems, "input_side"), true);

  const unit = checkSubmission(one(validPin({
    source: "estimated", front_m: 1, left_m: 1,
    input: { front: 1, offset: 2, side: "left", unit: "ft" },
  })), TODAY);
  assert.equal(hasField(unit.problems, "input_unit"), true);
});

test("input must be an object", () => {
  const result = checkSubmission(one(validPin({ source: "estimated", front_m: 1, left_m: 1, input: 5 })), TODAY);
  assert.equal(hasField(result.problems, "input"), true);
});

test("a lost position carries nothing but hole and missing", () => {
  const lost = checkSubmission(one({ hole: "9", missing: true }), TODAY);
  assert.equal(lost.ok, true);
  assert.deepEqual(lost.pins[0], { hole: "9", missing: true });

  const withLat = checkSubmission(one({ hole: "9", missing: true, lat: 52 }), TODAY);
  assert.equal(hasField(withLat.problems, "lat"), true);
  assert.equal(withLat.problems.find((problem) => problem.field === "lat").message,
    "must be empty when missing is set");
});

// FORMAT.md 2 columns 16 and 17, rules 7 and 8 of 2.1. The same cases as
// TestBearingAndCorrection in tests/test_validate.py.
function estimatedPin(overrides) {
  return validPin(Object.assign({
    source: "estimated", front_m: 12, left_m: 9.5,
    input: { front: 12, offset: 5, side: "right", unit: "m" },
  }, overrides));
}

function surveyedPin(overrides) {
  return validPin(Object.assign({ source: "surveyed", accuracy_m: 0.03 }, overrides));
}

function onlyProblem(result, field) {
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((problem) => problem.field), [field],
    JSON.stringify(result.problems));
}

test("play_bearing_deg is kept with input, 0 or more and less than 360", () => {
  for (const value of [0, 90, 274.5, 359.9]) {
    const result = checkSubmission(one(estimatedPin({ play_bearing_deg: value })), TODAY);
    assert.deepEqual(result.problems, [], String(value));
    assert.equal(result.pins[0].play_bearing_deg, value);
  }
  onlyProblem(checkSubmission(one(estimatedPin({ play_bearing_deg: 360 })), TODAY), "play_bearing_deg");
  onlyProblem(checkSubmission(one(estimatedPin({ play_bearing_deg: -0.5 })), TODAY), "play_bearing_deg");
  onlyProblem(checkSubmission(one(estimatedPin({ play_bearing_deg: 274.25 })), TODAY), "play_bearing_deg");
  onlyProblem(checkSubmission(one(estimatedPin({ play_bearing_deg: "274.5" })), TODAY), "play_bearing_deg");
});

test("play_bearing_deg is optional and only allowed with input", () => {
  const without = checkSubmission(one(estimatedPin()), TODAY);
  assert.equal(without.ok, true);
  assert.equal("play_bearing_deg" in without.pins[0], false);

  onlyProblem(checkSubmission(one(estimatedPin({ input: null, play_bearing_deg: 274.5 })), TODAY),
    "play_bearing_deg");
  onlyProblem(checkSubmission(one(validPin({ play_bearing_deg: 274.5 })), TODAY), "play_bearing_deg");
  onlyProblem(checkSubmission(one({ hole: "9", missing: true, play_bearing_deg: 274.5 }), TODAY),
    "play_bearing_deg");
});

test("correction takes the four values and only with source surveyed", () => {
  for (const value of ["none", "ppp", "rtk", "ppk"]) {
    const result = checkSubmission(one(surveyedPin({ correction: value })), TODAY);
    assert.deepEqual(result.problems, [], value);
    assert.equal(result.pins[0].correction, value);
  }
  onlyProblem(checkSubmission(one(surveyedPin({ correction: "dgps" })), TODAY), "correction");
  onlyProblem(checkSubmission(one(validPin({ correction: "rtk" })), TODAY), "correction");
  onlyProblem(checkSubmission(one(estimatedPin({ correction: "rtk" })), TODAY), "correction");
  onlyProblem(checkSubmission(one({ hole: "9", missing: true, correction: "rtk" }), TODAY), "correction");
  const empty = checkSubmission(one(surveyedPin({ correction: null })), TODAY);
  assert.equal(empty.ok, true);
  assert.equal("correction" in empty.pins[0], false);
});

test("missing is true or left out", () => {
  assert.equal(hasField(checkSubmission(one({ hole: "9", missing: false }), TODAY).problems, "missing"), true);
  assert.equal(hasField(checkSubmission(one({ hole: "9", missing: 1 }), TODAY).problems, "missing"), true);
});

test("numbers carry at most 7 decimals", () => {
  assert.equal(checkSubmission(one(validPin({ lat: 0.0000005, lon: 0.0000005 })), TODAY).ok, true);
  const eight = checkSubmission(one(validPin({ lat: 0.00000005, lon: 0.00000005 })), TODAY);
  assert.equal(hasField(eight.problems, "lat"), true);
  assert.equal(hasField(eight.problems, "lon"), true);
  const front = checkSubmission(one(validPin({ front_m: 0.00000005, left_m: 1 })), TODAY);
  assert.equal(hasField(front.problems, "front_m"), true);
});

test("negative zero is written 0", () => {
  const result = checkSubmission(one(validPin({ lat: -0, lon: 13 })), TODAY);
  assert.equal(hasField(result.problems, "lat"), true);
  assert.equal(result.problems.find((problem) => problem.field === "lat").message, "-0 is written 0");
});

test("all pins with a coordinate lie within 5 km of each other", () => {
  const close = checkSubmission({
    format: 1, group: "g", date: TODAY,
    pins: [
      { hole: "1", lat: 52.0, lon: 13.0, source: "mapped" },
      { hole: "2", lat: 52.0005, lon: 13.0, source: "mapped" },
    ],
  }, TODAY);
  assert.equal(close.ok, true);

  const far = checkSubmission({
    format: 1, group: "g", date: TODAY,
    pins: [
      { hole: "1", lat: 52.0, lon: 13.0, source: "mapped" },
      { hole: "2", lat: 52.1, lon: 13.0, source: "mapped" },
    ],
  }, TODAY);
  assert.equal(far.ok, false);
  assert.equal(hasField(far.problems, "lat"), true);
  assert.equal(far.problems.find((problem) => problem.field === "lat").hole, "2");
});

test("decimalsOf reads the shortest text, also in exponent form", () => {
  assert.equal(decimalsOf(0.0000005), 7);
  assert.equal(decimalsOf(0.00000005), 8);
  assert.equal(decimalsOf(5e-7), 7);
  assert.equal(decimalsOf(1.5e-7), 8);
  assert.equal(decimalsOf(52.1234561), 7);
  assert.equal(decimalsOf(9.5), 1);
  assert.equal(decimalsOf(12), 0);
  assert.equal(decimalsOf(1e21), 0);
  assert.equal(decimalsOf(1.2e-3), 4);
  assert.equal(decimalsOf(-0), 0);
});

test("formatNumber writes the plain form of FORMAT.md 4.1", () => {
  assert.equal(formatNumber(12), "12");
  assert.equal(formatNumber(9.5), "9.5");
  assert.equal(formatNumber(52.1234561), "52.1234561");
  assert.equal(formatNumber(0.0000005), "0.0000005");
  assert.equal(formatNumber(-0), "0");
  assert.equal(formatNumber(1e21), "1000000000000000000000");
});

test("isClosed at the boundary D + 2 and D + 3", () => {
  assert.equal(isClosed("2027-04-10", "2027-04-12"), false);
  assert.equal(isClosed("2027-04-10", "2027-04-13"), true);
});

test("visibleFrom subtracts round(lon / 15) hours from 07:00Z", () => {
  assert.equal(visibleFrom("2027-04-12", [{ lat: 52, lon: 13 }]), "2027-04-12T06:00:00Z");
  assert.equal(visibleFrom("2027-04-12", [{ lat: 37, lon: -122 }]), "2027-04-12T15:00:00Z");
  assert.equal(visibleFrom("2027-04-12", [{ hole: "9", missing: true }]), "2027-04-12T07:00:00Z");
  // the mean longitude of the pins with a coordinate
  assert.equal(visibleFrom("2027-04-12", [{ lat: 52, lon: 30 }, { lat: 52, lon: 0 }]), "2027-04-12T06:00:00Z");
});

test("visibleFrom rounds halves up, also for negative longitudes", () => {
  // -112.5 / 15 = -7.5, which becomes -7, not -8: 07:00Z + 7 hours.
  assert.equal(visibleFrom("2027-04-12", [{ lat: 52, lon: -112.5 }]), "2027-04-12T14:00:00Z");
  // 112.5 / 15 = 7.5, which becomes 8: 07:00Z - 8 hours, the day before.
  assert.equal(visibleFrom("2027-04-12", [{ lat: 52, lon: 112.5 }]), "2027-04-11T23:00:00Z");
  // -7.5 / 15 = -0.5, which becomes 0.
  assert.equal(visibleFrom("2027-04-12", [{ lat: 52, lon: -7.5 }]), "2027-04-12T07:00:00Z");
});

test("an unknown field in the envelope is a problem", () => {
  const body = Object.assign(one(validPin()), { extra: 1 });
  const result = checkSubmission(body, TODAY);
  assert.equal(result.ok, false);
  const problem = result.problems.find((item) => item.field === "extra");
  assert.ok(problem, "no problem for the unknown envelope field");
  assert.equal(problem.hole, null);
});

test("an unknown field in a pin is a problem, also a misspelt one", () => {
  const result = checkSubmission(one(validPin({ accuracy: 0.5 })), TODAY);
  assert.equal(result.ok, false);
  const problem = result.problems.find((item) => item.field === "accuracy");
  assert.ok(problem, "no problem for the unknown pin field");
  assert.equal(problem.hole, "1");
});

test("an unknown field in input is a problem", () => {
  const result = checkSubmission(one(validPin({
    source: "estimated", front_m: 1, left_m: 1,
    input: { front: 1, offset: 2, side: "left", unit: "m", accuracy: 1 },
  })), TODAY);
  assert.equal(result.ok, false);
  assert.equal(hasField(result.problems, "accuracy"), true);
});

test("a null value counts as absent", () => {
  const result = checkSubmission(one({
    hole: "9", missing: true, lat: null, lon: null, source: null,
  }), TODAY);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins[0], { hole: "9", missing: true });
});

function liveRow(overrides) {
  return Object.assign({
    channel: "openyardage", grp: "g1", date: "2027-04-12", hole: "1",
    visible_from: "2027-04-12T06:00:00Z", lat: 52, lon: 13,
  }, overrides);
}

test("selectLive drops rows not visible yet", () => {
  const rows = [liveRow({ hole: "1", visible_from: "2027-04-12T08:00:00Z" })];
  assert.deepEqual(selectLive(rows, "2027-04-12T07:00:00Z", "2027-04-12"), []);
});

test("selectLive drops a closed day", () => {
  const rows = [liveRow({ date: "2027-04-08" })];
  assert.deepEqual(selectLive(rows, "2027-04-12T07:00:00Z", "2027-04-12"), []);
});

test("selectLive keeps only the newest visible day per channel and group", () => {
  const rows = [
    liveRow({ date: "2027-04-11", hole: "1" }),
    liveRow({ date: "2027-04-12", hole: "1" }),
  ];
  const selected = selectLive(rows, "2027-04-12T07:00:00Z", "2027-04-12");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].date, "2027-04-12");
});

test("selectLive keeps two groups apart", () => {
  const rows = [
    liveRow({ grp: "g1", hole: "1" }),
    liveRow({ grp: "g2", hole: "2" }),
  ];
  const selected = selectLive(rows, "2027-04-12T07:00:00Z", "2027-04-12");
  assert.equal(selected.length, 2);
});

test("selectLive sorts by FORMAT.md 2.2", () => {
  const rows = [
    liveRow({ hole: "B3" }),
    liveRow({ hole: "10" }),
    liveRow({ hole: "2" }),
  ];
  const selected = selectLive(rows, "2027-04-12T07:00:00Z", "2027-04-12");
  assert.deepEqual(selected.map((row) => row.hole), ["2", "10", "B3"]);
});

test("liveGeojson carries the live title in notes and the columns of FORMAT.md 2", () => {
  const bytes = liveGeojson("2027-04-12", [{ date: "2027-04-12", date_basis: "local", hole: "7", lat: 52.1234561, lon: 13.1234573, source: "estimated", channel: "openyardage" }]);
  const data = JSON.parse(new TextDecoder().decode(bytes));
  assert.equal(data.type, "FeatureCollection");
  assert.equal(data.format, 1);
  assert.equal(data.as_of, "2027-04-12");
  assert.equal(data.notes[0], "OpenPinsheet live pins as of 2027-04-12. Format 1.");
  assert.equal(data.features.length, 1);
  assert.deepEqual(data.features[0].geometry.coordinates, [13.1234573, 52.1234561]);
  assert.equal(data.features[0].properties.hole, "7");
});
