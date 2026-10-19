// OpenPinsheet upload parser.
//
// One uploaded file (CSV or KML, for example the export of an RTK GNSS app
// like Emlid Flow) is turned into the submission bodies of POST
// /v1/submissions (API.md 1) and into a list of problems, each with the line
// it came from. Pure text and regex parsing only: no Node API, no DOMParser
// and no import beyond ./core.js, so the module runs in a Cloudflare Worker.

import { parseDate } from "./core.js";

const MAX_PINS = 150;
// An upload carries at most 5 grounds (worker.js, accountUpload) of at most
// 150 pins, so 1000 points is more than any real file. Both limits are
// checked before the expensive steps: an upload of 1 MB must not cost
// seconds of CPU (found in a security review: 90,000 open <Placemark>
// tags took 37 s with the earlier regex parser).
const MAX_POINTS = 1000;
const MAX_GROUPS = 5;
const MAX_DISTANCE_M = 5000;
const EARTH_RADIUS_M = 6371000;
const HOLE_RE = /^[0-9A-Za-z]{1,8}$/;
const HOLE_PREFIX_RE = /^(pin|hole|loch|flag)[\s_-]*/i;
const SOURCES = ["estimated", "surveyed", "mapped", "detected"];
const SOURCE_LIST = SOURCES.join(", ");

// Column names of the upload forms of API.md 1, case-insensitive and trimmed.
const HOLE_COLUMNS = ["hole", "name", "pin"];
const LAT_COLUMNS = ["lat", "latitude"];
const LON_COLUMNS = ["lon", "lng", "long", "longitude"];
const ACCURACY_COLUMNS = ["accuracy_m", "accuracy", "horizontal accuracy"];
const DATE_COLUMNS = ["date", "averaging start"];
const SOURCE_COLUMNS = ["source"];
// An Emlid Flow export carries no 95 % radius, but the RMS per axis and a
// Lateral RMS; accuracyFromCells() converts them.
const RMS_EAST_COLUMNS = ["easting rms"];
const RMS_NORTH_COLUMNS = ["northing rms"];
const RMS_LATERAL_COLUMNS = ["lateral rms"];

// FORMAT.md 2.3: the 95 % radius is 1.7308 times sqrt(east² + north²) of the
// RMS per axis, and 2.4477 times the RMS of one axis. Emlid does not document
// whether Lateral RMS is the first or the quadratic mean of both axes, so it
// gets the larger factor: the radius may come out too large, never too small.
const R95_PER_RMSE_R = 1.7308;
const R95_PER_SIGMA = 2.4477;

// Round to a number of decimals; -0 becomes 0, because FORMAT.md 4.1 writes it
// that way and core.js reports -0 as a problem.
function round(value, decimals) {
  const factor = 10 ** decimals;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

// A decimal comma is only read when the delimiter is a semicolon, where a
// comma cannot be a field separator. Returns null for an empty cell and NaN
// for something that is not a plain number.
function number(raw, decimalComma) {
  let text = raw.trim();
  if (text === "") {
    return null;
  }
  if (decimalComma) {
    text = text.replace(",", ".");
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    return NaN;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : NaN;
}

// "Pin 7", "hole_7" and "Loch-7" all become "7".
function cleanHole(raw) {
  return raw.trim().replace(HOLE_PREFIX_RE, "").trim();
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// --- CSV -----------------------------------------------------------------

function firstNonEmptyLine(text) {
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== "") {
      return lines[i];
    }
  }
  return null;
}

function isEmptyRecord(record) {
  return record.fields.every((value) => value.trim() === "");
}

// Records of { fields, line } with double-quoted fields and "" escapes. A
// quoted field may hold the delimiter and a line break; line counts the first
// line of the record in the file.
function csvRecords(text, delimiter) {
  const records = [];
  let fields = [];
  let field = "";
  let inQuotes = false;
  let started = false;
  let line = 1;
  let startLine = 1;
  const begin = () => {
    if (!started) {
      started = true;
      startLine = line;
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === "\n") {
          line += 1;
        }
        field += c;
      }
      continue;
    }
    if (c === '"') {
      begin();
      inQuotes = true;
    } else if (c === delimiter) {
      begin();
      fields.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      if (started || field !== "" || fields.length > 0) {
        begin();
        fields.push(field);
        records.push({ fields, line: startLine });
      }
      fields = [];
      field = "";
      started = false;
      line += 1;
    } else {
      begin();
      field += c;
    }
  }
  if (started || field !== "" || fields.length > 0) {
    begin();
    fields.push(field);
    records.push({ fields, line: startLine });
  }
  return records;
}

function findColumn(header, names) {
  for (let i = 0; i < header.length; i += 1) {
    if (names.includes(header[i].trim().toLowerCase())) {
      return i;
    }
  }
  return -1;
}

// --- pins ----------------------------------------------------------------

// The 95 % radius of FORMAT.md 2.3 from the accuracy cells of one row, in
// this order: accuracy_m as it stands, Easting and Northing RMS, Lateral RMS.
// Returns undefined when the row carries none, null when a cell is not a
// number (the problem is recorded).
function accuracyFromCells(line, raw, decimalComma, problems) {
  const read = (text, name, allowZero) => {
    const value = number(text, decimalComma);
    if (value === null || Number.isNaN(value)) {
      problems.push({ line, message: name + " is not a number" });
      return null;
    }
    if (value < 0 || (value === 0 && !allowZero)) {
      problems.push({ line, message: name + " must be greater than 0" });
      return null;
    }
    return value;
  };
  // Millimetres, as core.js stores them; below half a millimetre the radius
  // would round to 0, which core.js rejects without a line number.
  const radius = (value, name) => {
    const result = round(value, 3);
    if (result <= 0) {
      problems.push({ line, message: name + " gives an accuracy below 1 mm" });
      return null;
    }
    return result;
  };
  if (raw.accuracy !== "") {
    const value = read(raw.accuracy, "accuracy_m", false);
    return value === null ? null : radius(value, "accuracy_m");
  }
  if ((raw.rmsEast !== "") !== (raw.rmsNorth !== "") && raw.rmsLateral === "") {
    problems.push({ line, message: "Easting RMS and Northing RMS are needed together" });
    return null;
  }
  if (raw.rmsEast !== "" && raw.rmsNorth !== "") {
    // One axis may round to 0 in a good fix, both may not.
    const east = read(raw.rmsEast, "Easting RMS", true);
    const north = read(raw.rmsNorth, "Northing RMS", true);
    if (east === null || north === null) {
      return null;
    }
    if (east === 0 && north === 0) {
      problems.push({ line, message: "Easting RMS and Northing RMS are both 0" });
      return null;
    }
    return radius(R95_PER_RMSE_R * Math.hypot(east, north), "Easting and Northing RMS");
  }
  if (raw.rmsLateral !== "") {
    const value = read(raw.rmsLateral, "Lateral RMS", false);
    return value === null ? null : radius(R95_PER_SIGMA * value, "Lateral RMS");
  }
  return undefined;
}

// raw carries the cells as text, "" meaning absent. Builds one internal
// pin with { hole, lat, lon, source, accuracy_m, date, line } and records
// every problem against its line.
function buildPin(line, raw, decimalComma, formDate, formSource, formAccuracy, problems) {
  const hole = cleanHole(raw.hole);
  if (!HOLE_RE.test(hole)) {
    problems.push({ line, message: 'hole "' + hole + '" is not 1 to 8 letters or digits' });
  }

  const lat = number(raw.lat, decimalComma);
  if (raw.lat === "") {
    problems.push({ line, message: "lat is missing" });
  } else if (Number.isNaN(lat)) {
    problems.push({ line, message: "lat is not a number" });
  } else if (lat < -90 || lat > 90) {
    problems.push({ line, message: "lat must be between -90 and 90" });
  }

  const lon = number(raw.lon, decimalComma);
  if (raw.lon === "") {
    problems.push({ line, message: "lon is missing" });
  } else if (Number.isNaN(lon)) {
    problems.push({ line, message: "lon is not a number" });
  } else if (lon < -180 || lon > 180) {
    problems.push({ line, message: "lon must be between -180 and 180" });
  }

  let accuracy = accuracyFromCells(line, raw, decimalComma, problems);
  if (accuracy === undefined) {
    accuracy = formAccuracy !== null && formAccuracy > 0 ? round(formAccuracy, 3) : null;
  }

  const date = raw.date !== "" ? raw.date.slice(0, 10) : formDate;
  if (date === "") {
    problems.push({ line, message: "no date for this row; set one in the form" });
  } else if (parseDate(date) === null) {
    problems.push({ line, message: "date must be YYYY-MM-DD" });
  }

  let source = raw.source.trim().toLowerCase();
  if (source === "") {
    source = formSource === "" ? "surveyed" : formSource.trim().toLowerCase();
  }
  if (!SOURCES.includes(source)) {
    problems.push({ line, message: "source must be one of " + SOURCE_LIST });
  }
  if ((source === "surveyed" || source === "detected") && accuracy === null) {
    problems.push({ line, message: source + " needs an accuracy in metres" });
  }

  if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon)) {
    return null;
  }
  return { hole, lat: round(lat, 7), lon: round(lon, 7), source, accuracy_m: accuracy, date, line };
}

function parseCsv(text, formDate, formSource, formAccuracy, problems) {
  const clean = text.replace(/^\uFEFF/, "");
  const headerLine = firstNonEmptyLine(clean);
  if (headerLine === null) {
    problems.push({ line: null, message: "no header row" });
    return [];
  }
  const decimalComma = headerLine.includes(";") && !headerLine.includes(",");
  const delimiter = decimalComma ? ";" : ",";
  const records = csvRecords(clean, delimiter);

  let headerIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    if (!isEmptyRecord(records[i])) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) {
    problems.push({ line: null, message: "no header row" });
    return [];
  }

  if (records.length - headerIndex - 1 > MAX_POINTS) {
    problems.push({ line: null, message: "more than " + MAX_POINTS + " rows" });
    return [];
  }
  const header = records[headerIndex].fields;
  const columns = {
    hole: findColumn(header, HOLE_COLUMNS),
    lat: findColumn(header, LAT_COLUMNS),
    lon: findColumn(header, LON_COLUMNS),
    accuracy: findColumn(header, ACCURACY_COLUMNS),
    rmsEast: findColumn(header, RMS_EAST_COLUMNS),
    rmsNorth: findColumn(header, RMS_NORTH_COLUMNS),
    rmsLateral: findColumn(header, RMS_LATERAL_COLUMNS),
    date: findColumn(header, DATE_COLUMNS),
    source: findColumn(header, SOURCE_COLUMNS),
  };
  for (const name of ["hole", "lat", "lon"]) {
    if (columns[name] < 0) {
      problems.push({ line: null, message: "missing column " + name });
    }
  }
  if (columns.hole < 0 || columns.lat < 0 || columns.lon < 0) {
    return [];
  }

  const pins = [];
  for (let i = headerIndex + 1; i < records.length; i += 1) {
    const record = records[i];
    if (isEmptyRecord(record)) {
      continue;
    }
    const cell = (index) => (index >= 0 && index < record.fields.length
      ? record.fields[index].trim()
      : "");
    const pin = buildPin(record.line, {
      hole: cell(columns.hole),
      lat: cell(columns.lat),
      lon: cell(columns.lon),
      accuracy: cell(columns.accuracy),
      rmsEast: cell(columns.rmsEast),
      rmsNorth: cell(columns.rmsNorth),
      rmsLateral: cell(columns.rmsLateral),
      date: cell(columns.date),
      source: cell(columns.source),
    }, decimalComma, formDate, formSource, formAccuracy, problems);
    if (pin !== null) {
      pins.push(pin);
    }
  }
  return pins;
}

// --- KML -----------------------------------------------------------------

function decodeXml(raw) {
  const text = raw.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text);
  if (cdata !== null) {
    return cdata[1];
  }
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// One linear pass with indexOf over a lower-case copy: every placemark is
// read once, its parts are searched only inside it, and the line number grows
// with the position instead of being counted from the start each time.
function parseKml(text, formDate, formSource, formAccuracy, problems) {
  const lower = text.toLowerCase();
  const pins = [];
  let points = 0;
  let placemarks = 0;
  let at = 0;
  let line = 1;
  let counted = 0;
  const between = (body, bodyLower, open, close, from) => {
    const tag = bodyLower.indexOf(open, from);
    if (tag < 0) {
      return null;
    }
    const contentStart = bodyLower.indexOf(">", tag);
    if (contentStart < 0) {
      return null;
    }
    const contentEnd = bodyLower.indexOf(close, contentStart + 1);
    if (contentEnd < 0) {
      return null;
    }
    return { value: body.slice(contentStart + 1, contentEnd), end: contentEnd };
  };
  for (;;) {
    const open = lower.indexOf("<placemark", at);
    if (open < 0) {
      break;
    }
    const close = lower.indexOf("</placemark>", open);
    if (close < 0) {
      break;
    }
    placemarks += 1;
    if (placemarks > MAX_POINTS) {
      problems.push({ line: null, message: "more than " + MAX_POINTS + " placemarks" });
      return [];
    }
    for (let i = counted; i < open; i += 1) {
      if (text.charCodeAt(i) === 10) {
        line += 1;
      }
    }
    counted = open;
    at = close + 12;
    const body = text.slice(open, close);
    const bodyLower = lower.slice(open, close);
    const name = between(body, bodyLower, "<name", "</name>", 0);
    if (name === null) {
      continue;
    }
    const point = bodyLower.indexOf("<point");
    if (point < 0) {
      continue;
    }
    const coordinates = between(body, bodyLower, "<coordinates", "</coordinates>", point);
    if (coordinates === null) {
      continue;
    }
    points += 1;
    const tuple = coordinates.value.trim().split(/\s+/)[0];
    const parts = tuple.split(",");
    if (parts.length < 2) {
      problems.push({ line, message: "coordinates are not lon,lat" });
      continue;
    }
    const pin = buildPin(line, {
      hole: decodeXml(name.value),
      lat: parts[1],
      lon: parts[0],
      accuracy: "",
      rmsEast: "",
      rmsNorth: "",
      rmsLateral: "",
      date: "",
      source: "",
    }, false, formDate, formSource, formAccuracy, problems);
    if (pin !== null) {
      pins.push(pin);
    }
  }
  if (points === 0) {
    problems.push({ line: null, message: "no points in the file" });
  }
  return pins;
}

// --- grouping ------------------------------------------------------------

function submissionPin(pin) {
  const out = { hole: pin.hole, lat: pin.lat, lon: pin.lon, source: pin.source };
  if (pin.accuracy_m !== null && pin.accuracy_m !== undefined) {
    out.accuracy_m = pin.accuracy_m;
  }
  return out;
}

// First by date, then clusters within a date: a pin joins the first cluster
// whose first pin is within 5 km, otherwise it starts one. The group is the
// centroid in hundredths of a degree, a minus sign written as "m" so the
// pattern of API.md 1.1 holds and an upload replaces the earlier one.
function groupPins(pins, problems) {
  const dates = [];
  const byDate = new Map();
  for (const pin of pins) {
    if (!byDate.has(pin.date)) {
      byDate.set(pin.date, []);
      dates.push(pin.date);
    }
    byDate.get(pin.date).push(pin);
  }

  const submissions = [];
  let groups = 0;
  for (const date of dates) {
    const clusters = [];
    for (const pin of byDate.get(date)) {
      let cluster = null;
      for (const candidate of clusters) {
        const first = candidate[0];
        if (haversine(first.lat, first.lon, pin.lat, pin.lon) <= MAX_DISTANCE_M) {
          cluster = candidate;
          break;
        }
      }
      if (cluster === null) {
        // Stop at the sixth ground: with at most five clusters every pin is
        // compared at most five times, so grouping stays linear.
        groups += 1;
        if (groups > MAX_GROUPS) {
          problems.push({ line: pin.line, message: "more than " + MAX_GROUPS + " courses or days in one upload" });
          return [];
        }
        cluster = [];
        clusters.push(cluster);
      }
      cluster.push(pin);
    }

    for (const cluster of clusters) {
      const seen = new Set();
      for (const pin of cluster) {
        if (seen.has(pin.hole)) {
          problems.push({ line: pin.line, message: "hole " + pin.hole + " appears twice" });
        }
        seen.add(pin.hole);
      }
      if (cluster.length > MAX_PINS) {
        problems.push({ line: cluster[MAX_PINS].line, message: "more than " + MAX_PINS + " pins in one group" });
      }

      let sumLat = 0;
      let sumLon = 0;
      for (const pin of cluster) {
        sumLat += pin.lat;
        sumLon += pin.lon;
      }
      const group = ("u" + Math.round((sumLat / cluster.length) * 100)
        + "_" + Math.round((sumLon / cluster.length) * 100)).replace(/-/g, "m");
      submissions.push({ format: 1, group, date, pins: cluster.map(submissionPin) });
    }
  }
  return submissions;
}

// --- entry ---------------------------------------------------------------

// parseUpload({ filename, text, date, source, accuracy_m }) returns
// { submissions, problems }. If there is any problem, submissions is empty.
export function parseUpload(upload) {
  const input = upload || {};
  const filename = typeof input.filename === "string" ? input.filename : "";
  const text = typeof input.text === "string" ? input.text : "";
  const formDate = typeof input.date === "string" ? input.date : "";
  const formSource = typeof input.source === "string" ? input.source : "";
  const formAccuracy = typeof input.accuracy_m === "number" && Number.isFinite(input.accuracy_m)
    ? input.accuracy_m
    : null;
  const problems = [];

  const lower = filename.toLowerCase();
  let kind = null;
  if (lower.endsWith(".csv")) {
    kind = "csv";
  } else if (lower.endsWith(".kml")) {
    kind = "kml";
  }
  if (kind === null) {
    problems.push({ line: null, message: "only .csv and .kml files" });
    return { submissions: [], problems };
  }

  const pins = kind === "csv"
    ? parseCsv(text, formDate, formSource, formAccuracy, problems)
    : parseKml(text, formDate, formSource, formAccuracy, problems);

  let submissions = [];
  if (problems.length === 0) {
    submissions = groupPins(pins, problems);
  }
  if (problems.length > 0) {
    submissions = [];
  }
  return { submissions, problems };
}
