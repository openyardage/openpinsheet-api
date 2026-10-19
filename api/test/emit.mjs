// Helper for tests/test_api_core.py: read a fixed row set and write a v1
// directory with api/src/core.js. No HTTP, no database, no network.
//
//   mise exec node@24 -- node api/test/emit.mjs <v1dir> <rows.json>
//
// rows.json carries the rows of FORMAT.md 2 as JSON: one object per hole and
// day, with `date`, `date_basis`, `hole`, the columns and `channel`. The same
// rows go into the Python tools in the cross-check.
//
// A directory named `test` is treated by the Node test runner as a test file
// when no path is given (and Node 24 imports a directory argument instead of
// searching it), so without our two arguments this file does nothing and
// exits 0.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dayCsv, dayGeojson, indexJson, yearCsv } from "../src/core.js";

const [, , outDir, rowsPath] = process.argv;
if (!outDir || !rowsPath) {
  console.error("emit.mjs: usage: node emit.mjs <v1dir> <rows.json>");
  process.exit(0);
}

const rows = JSON.parse(readFileSync(rowsPath, "utf8"));
if (!Array.isArray(rows) || rows.length === 0) {
  console.error("emit.mjs: rows.json must hold a non-empty list");
  process.exit(1);
}

const date = rows[0].date;
const year = date.slice(0, 4);
const daysDir = join(outDir, "days");
const yearsDir = join(outDir, "years");
mkdirSync(daysDir, { recursive: true });
mkdirSync(yearsDir, { recursive: true });

const dayCsvBytes = dayCsv(date, rows);
const dayGeoBytes = dayGeojson(date, rows);
const yearBytes = yearCsv(year, rows);

writeFileSync(join(daysDir, date + ".csv"), dayCsvBytes);
writeFileSync(join(daysDir, date + ".geojson"), dayGeoBytes);
writeFileSync(join(yearsDir, year + ".csv"), yearBytes);

const files = [
  { path: "days/" + date + ".csv", kind: "day", date, rows: rows.length, content: dayCsvBytes },
  { path: "days/" + date + ".geojson", kind: "day", date, rows: rows.length, content: dayGeoBytes },
  { path: "years/" + year + ".csv", kind: "year", year, rows: rows.length, content: yearBytes },
];
const index = await indexJson(files, date);
writeFileSync(join(outDir, "index.json"), index);
