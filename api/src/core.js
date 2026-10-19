// OpenPinsheet API core, version 1.
//
// Pure functions shared by the Worker and the tests. Standard JavaScript only,
// no imports and no platform API except `crypto`, which exists in Workers and
// in Node 24. A record is defined by FORMAT.md; the interface by API.md.
//
// This module is package 1: no HTTP, no database. It turns one submission into
// clean pins, decides when a day closes, computes `visible_from`, picks the
// live rows, and writes the files of FORMAT.md 4.1/4.2/4.3 byte for byte the
// way tools/publish.py and tools/index.py write them.

const encoder = new TextEncoder();

export const COLUMNS = Object.freeze([
  "date", "date_basis", "hole", "lat", "lon", "source", "accuracy_m",
  "front_m", "left_m", "input_front", "input_offset", "input_side",
  "input_unit", "channel", "missing", "play_bearing_deg", "correction",
]);

const NUMBER_COLUMNS = new Set([
  "lat", "lon", "accuracy_m", "front_m", "left_m", "input_front", "input_offset",
  "play_bearing_deg",
]);

const PROPERTY_COLUMNS = COLUMNS.filter((column) => column !== "lat" && column !== "lon");

const SOURCES = Object.freeze(["estimated", "surveyed", "mapped", "detected"]);
const CORRECTIONS = Object.freeze(["none", "ppp", "rtk", "ppk"]);
// FORMAT.md 2.1: a lost position keeps these empty. The channel is not a pin
// field here; it comes from the key.
const POSITION_FIELDS = Object.freeze([
  "lat", "lon", "source", "accuracy_m", "front_m", "left_m",
  "input_front", "input_offset", "input_side", "input_unit",
  "play_bearing_deg", "correction",
]);
const INPUT_FIELDS = Object.freeze([
  "input_front", "input_offset", "input_side", "input_unit",
]);

const ENVELOPE_FIELDS = new Set(["format", "group", "date", "pins"]);
const PIN_FIELDS = new Set([
  "hole", "missing", "lat", "lon", "source", "accuracy_m", "front_m",
  "left_m", "input", "play_bearing_deg", "correction",
]);
const INPUT_INPUT_FIELDS = new Set(["front", "offset", "side", "unit"]);

const GROUP_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const HOLE_RE = /^[0-9A-Za-z]{1,8}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DECIMALS = 7;
const BEARING_DECIMALS = 1;
const MAX_PINS = 150;
const MAX_DISTANCE_M = 5000;
const EARTH_RADIUS_M = 6371000;
const MS_PER_DAY = 86400000;

// The four sentences of FORMAT.md 4.1 and the attribution of section 6. They
// are the same texts tools/validate.py checks; a change here would break every
// published file.
const NOTE_LICENCE = "Licence: Open Database License 1.0 (ODbL) https://opendatacommons.org/licenses/odbl/1-0/";
const NOTE_ATTRIBUTION = "Attribution: Pin positions: OpenPinsheet and its data partners. Open Database License 1.0.";
const NOTE_ESTIMATED = "Estimated positions are computed against green outlines from OpenStreetMap: map data \u00a9 OpenStreetMap contributors (ODbL).";
export const ATTRIBUTION = "Pin positions: OpenPinsheet and its data partners, Open Database License 1.0. Estimated positions are computed against green outlines from OpenStreetMap: map data \u00a9 OpenStreetMap contributors (ODbL).";
const LICENSE = Object.freeze({
  name: "Open Database License 1.0",
  spdx: "ODbL-1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
});

function present(value) {
  return value !== undefined && value !== null;
}

function text(value) {
  return typeof value === "string" ? value : String(value);
}

// API.md 1.1: a field that is not named there is a problem, not ignored. The
// check is on the key, not on the value: a misspelt name stays visible even
// when its value happens to be null.
function unknownFields(object, allowed) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    return [];
  }
  return Object.keys(object).filter((key) => allowed.has(key) === false);
}

// --- numbers -------------------------------------------------------------

// The number of decimals of the shortest text of a JavaScript number. A number
// is not text, so the shortest form is taken from String(n); an exponent such
// as `5e-7` (0.0000005) is turned back into decimals (7). This is the rule of
// FORMAT.md 4.1, at most 7 decimals, on a number and not on a string.
export function decimalsOf(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    return Infinity;
  }
  if (n === 0) {
    return 0;
  }
  const s = String(n);
  const exponent = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (exponent) {
    const fraction = exponent[3] ? exponent[3].length : 0;
    const power = Number(exponent[4]);
    return Math.max(0, fraction - power);
  }
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

// The plain decimal form of FORMAT.md 4.1: shortest, no exponent, no trailing
// zeros, no -0. Used by the writers, so a number becomes the same text
// tools/publish.py passes through from an export.
export function formatNumber(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("not a finite number: " + value);
  }
  if (value === 0) {
    return "0";
  }
  const s = String(value);
  if (!/[eE]/.test(s)) {
    return s;
  }
  let sign = "";
  let body = s;
  if (body[0] === "-") {
    sign = "-";
    body = body.slice(1);
  }
  const at = body.search(/[eE]/);
  const mantissa = body.slice(0, at);
  const power = Number(body.slice(at + 1));
  const dot = mantissa.indexOf(".");
  const intPart = dot < 0 ? mantissa : mantissa.slice(0, dot);
  const fracPart = dot < 0 ? "" : mantissa.slice(dot + 1);
  const digits = intPart + fracPart;
  const point = intPart.length + power;
  let out;
  if (point <= 0) {
    out = "0." + "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    out = digits + "0".repeat(point - digits.length);
  } else {
    out = digits.slice(0, point) + "." + digits.slice(point);
  }
  if (out.includes(".")) {
    out = out.replace(/0+$/, "").replace(/\.$/, "");
  }
  return sign + out;
}

function isNegativeZero(value) {
  return value === 0 && Object.is(value, -0);
}

// --- dates ---------------------------------------------------------------

// Parse a 'YYYY-MM-DD' text into its parts, or null when it is not a real
// calendar date. Exported for the tests and package 2.
export function parseDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = DATE_RE.exec(value);
  if (!match) {
    return null;
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const time = new Date(Date.UTC(y, m - 1, d));
  if (time.getUTCFullYear() !== y || time.getUTCMonth() !== m - 1 || time.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function dayNumber(value) {
  const parts = parseDate(value);
  return Date.UTC(parts.y, parts.m - 1, parts.d);
}

function isoZ(time) {
  const date = new Date(time);
  const pad = (n, width) => String(n).padStart(width, "0");
  return pad(date.getUTCFullYear(), 4) + "-" + pad(date.getUTCMonth() + 1, 2) + "-"
    + pad(date.getUTCDate(), 2) + "T" + pad(date.getUTCHours(), 2) + ":"
    + pad(date.getUTCMinutes(), 2) + ":" + pad(date.getUTCSeconds(), 2) + "Z";
}

// FORMAT.md 4.3: a day D is published from D + 3 days, 00:00 UTC.
export function isClosed(date, todayUtc) {
  const day = parseDate(date);
  const today = parseDate(todayUtc);
  if (day === null || today === null) {
    return false;
  }
  return Date.UTC(day.y, day.m - 1, day.d) + 3 * MS_PER_DAY <= Date.UTC(today.y, today.m - 1, today.d);
}

// API.md 2.1: day D becomes visible at 07:00 UTC minus round(mean lon / 15)
// hours. A day without a coordinate uses lon 0.
export function visibleFrom(date, pins) {
  let sum = 0;
  let count = 0;
  for (const pin of pins || []) {
    if (pin && typeof pin.lat === "number" && typeof pin.lon === "number"
        && Number.isFinite(pin.lat) && Number.isFinite(pin.lon)) {
      sum += pin.lon;
      count += 1;
    }
  }
  const lon = count > 0 ? sum / count : 0;
  // Halves round up, also for negative longitudes: -7.5 becomes -7, not -8.
  // Math.floor(x + 0.5) is that rule for every sign (Math.round differs only
  // at -0, which has no effect on the hour).
  const shift = Math.floor(lon / 15 + 0.5);
  const day = parseDate(date);
  const time = Date.UTC(day.y, day.m - 1, day.d, 7, 0, 0) - shift * 3600000;
  return isoZ(time);
}

// --- submissions ---------------------------------------------------------

function checkNumber(value, field, bounds, add) {
  if (!present(value)) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    add(field, "must be a number");
    return;
  }
  if (decimalsOf(value) > MAX_DECIMALS) {
    add(field, "has more than " + MAX_DECIMALS + " decimals");
  }
  if (isNegativeZero(value)) {
    add(field, "-0 is written 0");
  }
  if (bounds.lo !== undefined && value < bounds.lo) {
    add(field, "is below " + bounds.lo);
  }
  if (bounds.hi !== undefined && value > bounds.hi) {
    add(field, "is above " + bounds.hi);
  }
  if (bounds.gt !== undefined && value <= bounds.gt) {
    add(field, "must be greater than " + bounds.gt);
  }
  if (bounds.ge !== undefined && value < bounds.ge) {
    add(field, "must be " + bounds.ge + " or more");
  }
}

function readInput(pin) {
  if (!present(pin.input)) {
    return { given: false, values: {}, problem: null };
  }
  const raw = pin.input;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      given: false,
      values: {},
      problem: { field: "input", message: "input must be an object with front, offset, side and unit" },
    };
  }
  return {
    given: true,
    values: {
      input_front: raw.front,
      input_offset: raw.offset,
      input_side: raw.side,
      input_unit: raw.unit,
    },
    problem: null,
  };
}

function checkPin(pin) {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
    add("pin", "a pin must be an object");
    return problems;
  }

  for (const key of unknownFields(pin, PIN_FIELDS)) {
    add(key, "is not a field of a pin");
  }
  if (pin.input !== null && typeof pin.input === "object" && !Array.isArray(pin.input)) {
    for (const key of unknownFields(pin.input, INPUT_INPUT_FIELDS)) {
      add(key, "is not a field of input");
    }
  }

  if (!present(pin.hole)) {
    add("hole", "is required");
  } else if (typeof pin.hole !== "string") {
    add("hole", "must be text");
  } else if (HOLE_RE.test(pin.hole) === false) {
    add("hole", "has the wrong form");
  }

  const input = readInput(pin);
  if (input.problem) {
    add(input.problem.field, input.problem.message);
  }
  const input_column = (column) => (column in input.values ? input.values[column] : undefined);

  const source = pin.source;
  const sourceGiven = present(source);
  if (sourceGiven) {
    if (typeof source !== "string") {
      add("source", "must be text");
    } else if (!SOURCES.includes(source)) {
      add("source", "must be one of " + SOURCES.join(", "));
    }
  }

  const side = input_column("input_side");
  if (present(side)) {
    if (typeof side !== "string") {
      add("input_side", "must be text");
    } else if (side !== "left" && side !== "right") {
      add("input_side", "must be one of left, right");
    }
  }
  const unit = input_column("input_unit");
  if (present(unit)) {
    if (typeof unit !== "string") {
      add("input_unit", "must be text");
    } else if (unit !== "m" && unit !== "yd") {
      add("input_unit", "must be one of m, yd");
    }
  }

  checkNumber(pin.lat, "lat", { lo: -90, hi: 90 }, add);
  checkNumber(pin.lon, "lon", { lo: -180, hi: 180 }, add);
  checkNumber(pin.accuracy_m, "accuracy_m", { gt: 0 }, add);
  checkNumber(pin.front_m, "front_m", { ge: 0 }, add);
  checkNumber(pin.left_m, "left_m", { ge: 0 }, add);
  checkNumber(input_column("input_front"), "input_front", { ge: 0 }, add);
  checkNumber(input_column("input_offset"), "input_offset", { ge: 0 }, add);
  checkNumber(pin.play_bearing_deg, "play_bearing_deg", { ge: 0 }, add);
  if (typeof pin.play_bearing_deg === "number" && Number.isFinite(pin.play_bearing_deg)) {
    if (pin.play_bearing_deg >= 360) {
      add("play_bearing_deg", "must be less than 360");
    }
    if (decimalsOf(pin.play_bearing_deg) > BEARING_DECIMALS) {
      add("play_bearing_deg", "has more than " + BEARING_DECIMALS + " decimal");
    }
  }

  const correction = pin.correction;
  if (present(correction)) {
    if (typeof correction !== "string") {
      add("correction", "must be text");
    } else if (!CORRECTIONS.includes(correction)) {
      add("correction", "must be one of " + CORRECTIONS.join(", "));
    }
  }

  const valueOf = (field) => (field in input.values ? input.values[field] : pin[field]);

  if (pin.missing === true) {
    for (const field of POSITION_FIELDS) {
      if (present(valueOf(field))) {
        add(field, "must be empty when missing is set");
      }
    }
    return problems;
  }
  if (present(pin.missing)) {
    add("missing", "must be true or left out");
  }

  const hasLat = present(pin.lat);
  const hasLon = present(pin.lon);
  if (hasLat !== hasLon) {
    add(hasLat ? "lon" : "lat", "lat and lon are given together or not at all");
  }
  if (hasLat && hasLon && !sourceGiven) {
    add("source", "is required when lat and lon are given");
  }

  const hasFront = present(pin.front_m);
  const hasLeft = present(pin.left_m);
  if (!sourceGiven) {
    if (!hasFront || !hasLeft) {
      add(!hasFront ? "front_m" : "left_m",
        "front_m and left_m are both required when source is empty");
    }
  } else if (hasFront !== hasLeft) {
    add(hasFront ? "left_m" : "front_m", "front_m and left_m are given together or not at all");
  }

  const hasAccuracy = present(pin.accuracy_m);
  if (source === "surveyed" || source === "detected") {
    if (!hasAccuracy) {
      add("accuracy_m", "is required for source surveyed and detected");
    }
  } else if (source === "estimated" || !sourceGiven) {
    if (hasAccuracy) {
      add("accuracy_m", "must be empty for estimated and for rows without source");
    }
  }

  const inputPresent = INPUT_FIELDS.map((field) => present(input_column(field)));
  if (inputPresent.some(Boolean) && !inputPresent.every(Boolean)) {
    add(INPUT_FIELDS[inputPresent.indexOf(false)],
      "input_front, input_offset, input_side and input_unit are given all four or none");
  } else if (inputPresent.every(Boolean) && source !== "estimated") {
    add("input_unit", "input_* is only allowed with source estimated");
  }

  if (present(pin.play_bearing_deg) && !inputPresent.every(Boolean)) {
    add("play_bearing_deg", "is only allowed together with the four input_*");
  }

  if (present(correction) && source !== "surveyed") {
    add("correction", "is only allowed with source surveyed");
  }

  return problems;
}

function cleanPin(pin) {
  const out = {};
  if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
    return out;
  }
  if (present(pin.hole)) {
    out.hole = pin.hole;
  }
  if (pin.missing === true) {
    out.missing = true;
    return out;
  }
  if (present(pin.lat)) {
    out.lat = pin.lat;
  }
  if (present(pin.lon)) {
    out.lon = pin.lon;
  }
  if (present(pin.source)) {
    out.source = pin.source;
  }
  if (present(pin.accuracy_m)) {
    out.accuracy_m = pin.accuracy_m;
  }
  if (present(pin.front_m)) {
    out.front_m = pin.front_m;
  }
  if (present(pin.left_m)) {
    out.left_m = pin.left_m;
  }
  const raw = pin.input;
  if (raw && typeof raw === "object" && !Array.isArray(raw)
      && present(raw.front) && present(raw.offset) && present(raw.side) && present(raw.unit)) {
    out.input_front = raw.front;
    out.input_offset = raw.offset;
    out.input_side = raw.side;
    out.input_unit = raw.unit;
  }
  if (present(pin.play_bearing_deg)) {
    out.play_bearing_deg = pin.play_bearing_deg;
  }
  if (present(pin.correction)) {
    out.correction = pin.correction;
  }
  return out;
}

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function farthestPin(pins) {
  const located = pins.filter((pin) => pin && typeof pin === "object" && !Array.isArray(pin)
    && typeof pin.lat === "number" && typeof pin.lon === "number"
    && Number.isFinite(pin.lat) && Number.isFinite(pin.lon));
  let worst = null;
  for (let i = 0; i < located.length; i += 1) {
    for (let j = i + 1; j < located.length; j += 1) {
      const distance = haversine(located[i].lat, located[i].lon, located[j].lat, located[j].lon);
      if (worst === null || distance > worst.distance) {
        worst = { distance, pin: located[j] };
      }
    }
  }
  if (worst !== null && worst.distance > MAX_DISTANCE_M) {
    return worst.pin;
  }
  return null;
}

// API.md 1.1 and 1.2. Checks the envelope and every pin. Returns the problems
// as { hole, field, message } and the cleaned pins in the columns of
// FORMAT.md 2 (input resolved into input_front, input_offset, input_side and
// input_unit; missing as true or left out).
export function checkSubmission(body, todayUtc) {
  const problems = [];
  const pins = [];
  const add = (hole, field, message) => problems.push({ hole, field, message });

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    add(null, "body", "the body must be a JSON object");
    return { ok: false, problems, pins };
  }

  for (const key of unknownFields(body, ENVELOPE_FIELDS)) {
    add(null, key, "is not a field of the submission");
  }

  if (typeof body.format !== "number" || !Number.isInteger(body.format) || body.format !== 1) {
    add(null, "format", "format must be the integer 1");
  }

  if (typeof body.group !== "string" || GROUP_RE.test(body.group) === false) {
    add(null, "group", "group must be 1 to 64 characters A-Z a-z 0-9 . _ : -");
  }

  if (typeof body.date !== "string" || parseDate(body.date) === null) {
    add(null, "date", "date must be a valid calendar date YYYY-MM-DD");
  } else if (parseDate(todayUtc) !== null) {
    const difference = (dayNumber(body.date) - dayNumber(todayUtc)) / MS_PER_DAY;
    if (difference < -1 || difference > 1) {
      add(null, "date", "date must lie within one day of today's UTC date");
    }
  }

  if (!Array.isArray(body.pins)) {
    add(null, "pins", "pins must be a list of 1 to 150 entries");
    return { ok: false, problems, pins };
  }

  if (body.pins.length < 1 || body.pins.length > MAX_PINS) {
    add(null, "pins", "pins must hold 1 to 150 entries");
  }

  const seen = new Set();
  for (const pin of body.pins) {
    const object = pin !== null && typeof pin === "object" && !Array.isArray(pin);
    const hole = object && present(pin.hole) ? pin.hole : null;
    for (const problem of checkPin(pin)) {
      add(hole, problem.field, problem.message);
    }
    if (hole !== null) {
      const key = text(hole);
      if (seen.has(key)) {
        add(hole, "hole", "each hole may appear at most once");
      }
      seen.add(key);
    }
    pins.push(cleanPin(pin));
  }

  const far = farthestPin(body.pins);
  if (far !== null) {
    add(present(far.hole) ? far.hole : null, "lat",
      "all pins with a coordinate must lie within 5 km of each other");
  }

  return { ok: problems.length === 0, problems, pins };
}

// --- live rows -----------------------------------------------------------

function holeKey(hole) {
  if (typeof hole === "string" && /^[0-9]+$/.test(hole)) {
    return [0, Number.parseInt(hole, 10), ""];
  }
  return [1, 0, typeof hole === "string" ? hole : ""];
}

function compareRows(a, b) {
  const dateA = typeof a.date === "string" ? a.date : "";
  const dateB = typeof b.date === "string" ? b.date : "";
  if (dateA !== dateB) {
    return dateA < dateB ? -1 : 1;
  }
  const keyA = holeKey(a.hole);
  const keyB = holeKey(b.hole);
  if (keyA[0] !== keyB[0]) {
    return keyA[0] - keyB[0];
  }
  if (keyA[1] !== keyB[1]) {
    return keyA[1] - keyB[1];
  }
  if (keyA[2] !== keyB[2]) {
    return keyA[2] < keyB[2] ? -1 : 1;
  }
  return 0;
}

// API.md 2: only open days, only rows already visible, and per (channel, grp)
// only the most recent visible day. Sorted by FORMAT.md 2.2.
export function selectLive(rows, nowIso, todayUtc) {
  const now = Date.parse(nowIso);
  const visible = rows.filter((row) => {
    if (isClosed(row.date, todayUtc)) {
      return false;
    }
    const from = Date.parse(row.visible_from);
    return !Number.isNaN(from) && from <= now;
  });
  const newest = new Map();
  for (const row of visible) {
    const key = text(row.channel) + "\u0000" + text(row.grp);
    const current = newest.get(key);
    if (current === undefined || row.date > current) {
      newest.set(key, row.date);
    }
  }
  const selected = visible.filter((row) => newest.get(text(row.channel) + "\u0000" + text(row.grp)) === row.date);
  return selected.sort(compareRows);
}

// --- writers -------------------------------------------------------------

function sortRows(rows) {
  return rows.slice().sort(compareRows);
}

function commentLines(title) {
  return [title, "# " + NOTE_LICENCE, "# " + NOTE_ATTRIBUTION, "# " + NOTE_ESTIMATED];
}

function csvQuote(value) {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function cellText(row, column) {
  if (column === "missing") {
    return row.missing === true ? "1" : "";
  }
  const value = row[column];
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (NUMBER_COLUMNS.has(column) && typeof value === "number") {
    return formatNumber(value);
  }
  return text(value);
}

function csvBytes(title, rows) {
  const lines = commentLines(title);
  lines.push(COLUMNS.join(","));
  for (const row of sortRows(rows)) {
    lines.push(COLUMNS.map((column) => csvQuote(cellText(row, column))).join(","));
  }
  return encoder.encode("\ufeff" + lines.join("\r\n") + "\r\n");
}

// tools/publish.py `_write_csv`: BOM, CRLF, the four comment lines, header, rows.
export function dayCsv(date, rows) {
  return csvBytes("# OpenPinsheet day file " + date + ". Format 1.", rows);
}

export function yearCsv(year, rows) {
  return csvBytes("# OpenPinsheet year file " + year + ". Format 1.", rows);
}

function jsonNumber(value) {
  return typeof value === "number" ? formatNumber(value) : text(value);
}

function propertiesJson(row) {
  const parts = [];
  for (const column of PROPERTY_COLUMNS) {
    if (column === "missing") {
      if (row.missing === true) {
        parts.push('"missing": true');
      }
      continue;
    }
    const value = row[column];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (NUMBER_COLUMNS.has(column)) {
      parts.push('"' + column + '": ' + jsonNumber(value));
    } else {
      parts.push(JSON.stringify(column) + ": " + JSON.stringify(text(value)));
    }
  }
  return "{ " + parts.join(", ") + " }";
}

function geometryJson(row) {
  const lat = row.lat;
  const lon = row.lon;
  if (lat === undefined || lat === null || lat === "" || lon === undefined || lon === null || lon === "") {
    return "null";
  }
  return '{ "type": "Point", "coordinates": [' + jsonNumber(lon) + ", " + jsonNumber(lat) + "] }";
}

function geojsonBytes(title, asOf, rows) {
  const notes = [title, NOTE_LICENCE, NOTE_ATTRIBUTION, NOTE_ESTIMATED];
  const lines = [
    "{",
    ' "type": "FeatureCollection",',
    ' "format": 1,',
    ' "as_of": ' + JSON.stringify(asOf) + ",",
    ' "license": { "name": "Open Database License 1.0", "spdx": "ODbL-1.0", "url": "https://opendatacommons.org/licenses/odbl/1-0/" },',
    ' "attribution": ' + JSON.stringify(ATTRIBUTION) + ",",
    ' "notes": [',
  ];
  notes.forEach((note, index) => {
    lines.push("  " + JSON.stringify(note) + (index < notes.length - 1 ? "," : ""));
  });
  lines.push(" ],");
  lines.push(' "features": [');
  const sorted = sortRows(rows);
  sorted.forEach((row, index) => {
    lines.push("  {");
    lines.push('   "type": "Feature",');
    lines.push('   "geometry": ' + geometryJson(row) + ",");
    lines.push('   "properties": ' + propertiesJson(row));
    lines.push("  }" + (index < sorted.length - 1 ? "," : ""));
  });
  lines.push(" ]");
  lines.push("}");
  return encoder.encode(lines.join("\n") + "\n");
}

export function dayGeojson(date, rows) {
  return geojsonBytes("OpenPinsheet day file " + date + ". Format 1.", date, rows);
}

// The live answer of API.md 2 reads like a published file, with the live title
// in `notes`.
export function liveGeojson(asOf, rows) {
  return geojsonBytes("OpenPinsheet live pins as of " + asOf + ". Format 1.", asOf, rows);
}

// The history answer of API.md 2.3 reads like the day files of its range, with
// the range in the title; `as_of` is the last day of the range.
export function historyGeojson(from, to, rows) {
  return geojsonBytes(
    "OpenPinsheet pins from " + from + " to " + to + ". Format 1.",
    to,
    rows,
  );
}

function hex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

// tools/index.py `build_index`: one entry per file with path, kind, date or
// year, bytes, sha256 and rows, sorted by path. `files` carries
// { path, kind, date | year, rows, content } with content the file bytes.
// A file that is already in the bucket and only known from the database may
// carry { sha256, bytes } instead of content; the two forms are the same
// index entry. sha256 comes from crypto.subtle, so this is async.
export async function indexJson(files, generated) {
  const entries = [];
  for (const file of files) {
    let bytes;
    let sha256;
    if (file.content !== undefined) {
      const content = file.content instanceof Uint8Array ? file.content : encoder.encode(String(file.content));
      const digest = await crypto.subtle.digest("SHA-256", content);
      bytes = content.length;
      sha256 = hex(new Uint8Array(digest));
    } else if (typeof file.sha256 === "string" && Number.isInteger(file.bytes)) {
      bytes = file.bytes;
      sha256 = file.sha256;
    } else {
      throw new TypeError("index entry needs content or bytes and sha256: " + file.path);
    }
    const entry = { path: file.path, kind: file.kind };
    if (file.kind === "day") {
      entry.date = file.date;
    } else {
      entry.year = file.year;
    }
    entry.bytes = bytes;
    entry.sha256 = sha256;
    entry.rows = file.rows;
    entries.push(entry);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const index = { format: 1, generated, license: LICENSE, files: entries };
  return JSON.stringify(index, null, 1) + "\n";
}
