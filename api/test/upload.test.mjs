// Tests for api/src/upload.js against API.md 1 and FORMAT.md 2.
//
// Run from openpinsheet/ with:
//   mise exec node@24 -- node --test api/test/upload.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { parseUpload } from "../src/upload.js";
import { checkSubmission } from "../src/core.js";

// Every submission of a valid upload passes the same check the API runs.
function assertPassesCore(submissions) {
  for (const submission of submissions) {
    const result = checkSubmission(submission, submission.date);
    assert.deepEqual(result.problems, [], "checkSubmission found a problem");
    assert.equal(result.ok, true);
  }
}

function problemNamed(problems, text) {
  return problems.find((problem) => problem.message.includes(text));
}

test("an OpenPinsheet-style CSV becomes one submission", () => {
  const csv = [
    "date,hole,lat,lon,source,accuracy_m",
    "2027-04-12,7,52.1234561,13.1234573,mapped,",
    "2027-04-12,8,52.1241077,13.122915,surveyed,0.03",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "export.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].format, 1);
  assert.equal(submissions[0].date, "2027-04-12");
  assert.deepEqual(submissions[0].pins.map((pin) => pin.hole), ["7", "8"]);
  assert.equal(submissions[0].pins[1].accuracy_m, 0.03);
  assertPassesCore(submissions);
});

test("an Emlid Flow CSV with Pin names, Lateral RMS and Averaging start", () => {
  const csv = [
    "Name,Latitude,Longitude,Ellipsoidal height,Lateral RMS,Averaging start",
    "Pin 7,52.12345610,13.12345730,34.5,0.03,2026-06-14 08:11:33",
    "Pin 8,52.12410770,13.12291500,35.1,0.025,2026-06-14 08:12:10",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "emlid.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].date, "2026-06-14");
  assert.deepEqual(submissions[0].pins.map((pin) => pin.hole), ["7", "8"]);
  assert.deepEqual(submissions[0].pins.map((pin) => pin.source), ["surveyed", "surveyed"]);
  // Lateral RMS alone gets the larger factor, 2.4477 (FORMAT.md 2.3).
  assert.deepEqual(submissions[0].pins.map((pin) => pin.accuracy_m), [0.073, 0.061]);
  assertPassesCore(submissions);
});

test("Easting and Northing RMS become the 95 % radius, before Lateral RMS", () => {
  const csv = [
    "Name,Latitude,Longitude,Easting RMS,Northing RMS,Lateral RMS,Averaging start",
    "Pin 7,52.12345610,13.12345730,0.01,0.02,0.022,2026-06-14 08:11:33",
    "Pin 8,52.12410770,13.12291500,0,0.012,0.012,2026-06-14 08:12:10",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "emlid.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  // 1.7308 * sqrt(0.01² + 0.02²) = 0.0387; 1.7308 * 0.012 = 0.0208.
  assert.deepEqual(submissions[0].pins.map((pin) => pin.accuracy_m), [0.039, 0.021]);
  assertPassesCore(submissions);
});

test("an accuracy_m column is taken as it stands, also next to Lateral RMS", () => {
  const csv = [
    "hole,lat,lon,accuracy_m,Lateral RMS",
    "7,52.1234561,13.1234573,0.05,0.03",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "beides.csv", text: csv, date: "2027-04-12", source: "surveyed", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  assert.equal(submissions[0].pins[0].accuracy_m, 0.05);
});

test("Easting and Northing RMS both 0 is a problem", () => {
  const csv = [
    "hole,lat,lon,Easting RMS,Northing RMS",
    "7,52.1234561,13.1234573,0,0",
  ].join("\n");

  const { problems } = parseUpload({
    filename: "null.csv", text: csv, date: "2027-04-12", source: "surveyed", accuracy_m: null,
  });

  assert.ok(problemNamed(problems, "Easting RMS and Northing RMS are both 0"), "no RMS problem");
});

test("one RMS axis without the other is a problem, also with a form value", () => {
  const csv = [
    "hole,lat,lon,Easting RMS,Northing RMS",
    "7,52.1234561,13.1234573,0.01,",
  ].join("\n");

  const { problems } = parseUpload({
    filename: "halb.csv", text: csv, date: "2027-04-12", source: "surveyed", accuracy_m: 0.05,
  });

  assert.ok(problemNamed(problems, "are needed together"), "no half-pair problem");
});

test("an accuracy that rounds to 0 mm is a problem with its line", () => {
  const csv = [
    "hole,lat,lon,Lateral RMS",
    "7,52.1234561,13.1234573,0.0001",
  ].join("\n");

  const { problems } = parseUpload({
    filename: "winzig.csv", text: csv, date: "2027-04-12", source: "surveyed", accuracy_m: null,
  });

  const problem = problemNamed(problems, "below 1 mm");
  assert.ok(problem, "no rounding problem");
  assert.equal(problem.line, 2);
});

test("a semicolon CSV reads decimal commas", () => {
  const csv = [
    "Name;Latitude;Longitude;Lateral RMS;Averaging start",
    "Pin 1;52,1234561;13,1234573;0,03;2026-06-14 08:11:33",
    "Pin 2;52,1241077;13,1229150;0,025;2026-06-14 08:12:10",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "menschen.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].pins[0].lat, 52.1234561);
  assert.equal(submissions[0].pins[0].lon, 13.1234573);
  assertPassesCore(submissions);
});

test("a KML keeps the point placemarks and ignores a LineString", () => {
  const kml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "<Document>",
    "  <Placemark>",
    "    <name>Pin 7</name>",
    "    <Point><coordinates>13.1234573,52.1234561,0</coordinates></Point>",
    "  </Placemark>",
    "  <Placemark>",
    "    <name><![CDATA[Pin 8]]></name>",
    "    <Point><coordinates>13.1229150,52.1241077</coordinates></Point>",
    "  </Placemark>",
    "  <Placemark>",
    "    <name>Fairway</name>",
    "    <LineString><coordinates>13.1,52.1,0 13.2,52.2,0</coordinates></LineString>",
    "  </Placemark>",
    "</Document>",
    "</kml>",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "pins.kml", text: kml, date: "2027-04-12", source: "mapped", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].pins.map((pin) => pin.hole), ["7", "8"]);
  assert.equal(submissions[0].pins[0].lat, 52.1234561);
  assert.equal(submissions[0].pins[0].lon, 13.1234573);
  assertPassesCore(submissions);
});

test("two courses 30 km apart give two submissions with different groups", () => {
  const csv = [
    "date,hole,lat,lon,source",
    "2027-04-12,1,52.0,13.0,mapped",
    "2027-04-12,1,52.27,13.0,mapped",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "zweimal.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(problems, []);
  assert.equal(submissions.length, 2);
  assert.notEqual(submissions[0].group, submissions[1].group);
  assertPassesCore(submissions);
});

test("a missing date gives a problem with the line", () => {
  const csv = [
    "hole,lat,lon,source",
    "7,52.0,13.0,mapped",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "ohne_datum.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(submissions, []);
  const problem = problemNamed(problems, "no date for this row; set one in the form");
  assert.ok(problem, "no problem for the missing date");
  assert.equal(problem.line, 2);
});

test("a duplicate hole gives a problem with the line of the second", () => {
  const csv = [
    "date,hole,lat,lon,source",
    "2027-04-12,7,52.0,13.0,mapped",
    "2027-04-12,7,52.0001,13.0,mapped",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "doppelt.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(submissions, []);
  const problem = problemNamed(problems, "hole 7 appears twice");
  assert.ok(problem, "no problem for the duplicate hole");
  assert.equal(problem.line, 3);
});

test("surveyed without an accuracy is a problem", () => {
  const csv = [
    "date,hole,lat,lon,source,accuracy_m",
    "2027-04-12,1,52.0,13.0,surveyed,",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "surveyed.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(submissions, []);
  assert.ok(problemNamed(problems, "surveyed needs an accuracy in metres"), "no accuracy problem");
});

test("a wrong extension is a problem", () => {
  const { submissions, problems } = parseUpload({
    filename: "pins.txt", text: "hole,lat,lon\n7,52.0,13.0\n", date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(submissions, []);
  assert.ok(problemNamed(problems, "only .csv and .kml files"), "no extension problem");
});

test("a missing required column names the column", () => {
  const csv = [
    "date,hole,lon,source",
    "2027-04-12,7,13.0,mapped",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "ohne_breite.csv", text: csv, date: "", source: "", accuracy_m: null,
  });

  assert.deepEqual(submissions, []);
  assert.ok(problemNamed(problems, "missing column lat"), "no problem for the missing lat column");
});

test("a KML without a point is a problem", () => {
  const kml = [
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    "<Document>",
    "  <Placemark>",
    "    <name>Fairway</name>",
    "    <LineString><coordinates>13.1,52.1,0 13.2,52.2,0</coordinates></LineString>",
    "  </Placemark>",
    "</Document>",
    "</kml>",
  ].join("\n");

  const { submissions, problems } = parseUpload({
    filename: "nur_linien.kml", text: kml, date: "2027-04-12", source: "mapped", accuracy_m: null,
  });

  assert.deepEqual(submissions, []);
  assert.ok(problemNamed(problems, "no points in the file"), "no points problem");
});

// The security review of 18.10.2026 measured 37 s for 90,000 open
// <Placemark> tags with the earlier regex parser. Each hostile file of about
// 1 MB must now end in a problem, without throwing, within half a second.
function quick(label, upload) {
  const started = Date.now();
  const result = parseUpload(upload);
  const took = Date.now() - started;
  assert.ok(took < 500, label + " took " + took + " ms");
  assert.equal(result.submissions.length, 0, label + " gave submissions");
  assert.ok(result.problems.length > 0, label + " gave no problem");
}

test("hostile files of about 1 MB end in a problem within half a second", () => {
  const base = { date: "2027-04-12", source: "mapped", accuracy_m: null };
  quick("open placemarks", Object.assign({ filename: "a.kml", text: "<Placemark>".repeat(90000) }, base));
  quick("names in one placemark", Object.assign({ filename: "a.kml",
    text: "<Placemark>" + "<name>".repeat(170000) + "</Placemark>" }, base));
  quick("points in one placemark", Object.assign({ filename: "a.kml",
    text: "<Placemark><name>1</name>" + "<Point>".repeat(140000) + "</Placemark>" }, base));
  const valid = "<Placemark><name>1</name><Point><coordinates>13.1,52.1</coordinates></Point></Placemark>\n";
  quick("many valid placemarks", Object.assign({ filename: "a.kml", text: valid.repeat(13000) }, base));
  let csv = "hole,lat,lon\n";
  for (let i = 0; i < 80000; i += 1) {
    csv += "1," + (10 + (i % 70)) + "," + (i % 170) + "\n";
  }
  quick("rows far apart", Object.assign({ filename: "a.csv", text: csv }, base));
});

test("a sixth ground in one file is a problem", () => {
  let csv = "hole,lat,lon\n";
  for (let i = 0; i < 6; i += 1) {
    csv += "1," + (40 + i) + ",10\n";
  }
  const result = parseUpload({ filename: "a.csv", text: csv, date: "2027-04-12", source: "mapped", accuracy_m: null });
  assert.equal(result.submissions.length, 0);
  assert.match(result.problems[0].message, /more than 5 courses or days/);
});
