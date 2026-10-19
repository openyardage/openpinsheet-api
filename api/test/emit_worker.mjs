// Helper for tests/test_api_worker.py: deliver two data partners for the same
// day through the worker, run scheduled three days later, and write the fake
// bucket to a v1 directory. No network, no real D1, no real R2.
//
//   mise exec node@24 -- node api/test/emit_worker.mjs <v1dir>
//
// The directory name `test` makes the Node test runner import a file without
// arguments, so without our argument this helper does nothing and exits 0.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import worker from "../src/worker.js";
import { addChannel, addKey, createEnv } from "./fakes.mjs";

const [, , outDir] = process.argv;
if (!outDir) {
  console.error("emit_worker.mjs: usage: node emit_worker.mjs <v1dir>");
  process.exit(0);
}

const DATE = "2027-04-12";
const CLOSED = "2027-04-15";
const BASE = "https://api.openpinsheet.com";

const env = createEnv("2027-04-12T12:00:00Z");
addChannel(env, "openyardage", "OpenYardage");
addKey(env, "openyardage", "openyardage-key", 1);
addChannel(env, "greenkeeper", "Greenkeeper");
addKey(env, "greenkeeper", "greenkeeper-key", 1);

async function submit(key, group, pins) {
  const response = await worker.fetch(new Request(BASE + "/v1/submissions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body: JSON.stringify({ format: 1, group, date: DATE, pins }),
  }), env);
  if (response.status !== 200) {
    console.error("emit_worker.mjs: submission answered " + response.status);
    console.error(await response.text());
    process.exit(1);
  }
}

await submit("openyardage-key", "north-course", [
  {
    hole: "2", lat: 52.1234561, lon: 13.1234573, source: "estimated",
    front_m: 12, left_m: 9.5,
    input: { front: 12, offset: 5, side: "right", unit: "m" },
    play_bearing_deg: 274.5,
  },
  { hole: "10", lat: 52.1240001, lon: 13.1240002, source: "surveyed", accuracy_m: 0.03,
    correction: "rtk" },
  { hole: "11", missing: true },
]);

await submit("greenkeeper-key", "south-course", [
  { hole: "1", lat: 52.1250003, lon: 13.1250004, source: "mapped" },
  { hole: "B3", lat: 52.1255003, lon: 13.1255004, source: "surveyed", accuracy_m: 0.05 },
  { hole: "12", missing: true },
]);

env.NOW_ISO = CLOSED + "T00:00:00Z";
const report = await worker.scheduled({}, env);
if (report.errors.length > 0 || report.written.length === 0) {
  console.error("emit_worker.mjs: scheduled reported " + JSON.stringify(report));
  process.exit(1);
}

for (const key of Array.from(env.BUCKET.objects.keys()).sort()) {
  if (!key.startsWith("v1/")) {
    continue;
  }
  const relative = key.slice(3);
  const target = join(outDir, relative);
  mkdirSync(dirname(target), { recursive: true });
  const object = await env.BUCKET.get(key);
  writeFileSync(target, Buffer.from(await object.arrayBuffer()));
}
