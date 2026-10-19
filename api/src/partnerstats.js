// Review statistics of one data partner (API.md 3, admin area).
//
// Pure functions only: computePartnerStats turns D1 rows (days, pins, keys)
// into a plain object, renderPartnerStats turns that object into HTML with the
// escapeHtml function the caller passes in. No Node API and no import, so the
// module runs in a Cloudflare Worker. The clock is the caller's `today`.

const DAY_MS = 86400000;

// Round to a number of decimals; -0 becomes 0, as in upload.js.
function round(value, decimals) {
  const factor = 10 ** decimals;
  const result = Math.round(value * factor) / factor;
  return Object.is(result, -0) ? 0 : result;
}

// "YYYY-MM-DD" to milliseconds since the epoch in UTC.
function utcMs(day) {
  const parts = String(day).split("-");
  return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

// Shift a "YYYY-MM-DD" day by whole days, in UTC and never in local time.
function shiftDay(day, delta) {
  return new Date(utcMs(day) + delta * DAY_MS).toISOString().slice(0, 10);
}

// The lower middle of an even count, as written in the brief.
function lowerMedian(sorted) {
  if (sorted.length === 0) {
    return 0;
  }
  return sorted[(sorted.length - 1) >> 1];
}

// The usual median; an even count averages its two middle values.
function median(sorted) {
  if (sorted.length === 0) {
    return null;
  }
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function computePartnerStats(input) {
  const source = input || {};
  const days = Array.isArray(source.days) ? source.days : [];
  const pins = Array.isArray(source.pins) ? source.pins : [];
  const keys = Array.isArray(source.keys) ? source.keys : [];
  const today = typeof source.today === "string" ? source.today : "";

  // Days per ground: the distinct dates and the latest date.
  const dayInfo = new Map();
  let lastDate = null;
  for (const row of days) {
    let info = dayInfo.get(row.grp);
    if (info === undefined) {
      info = { dates: new Set(), lastDate: null };
      dayInfo.set(row.grp, info);
    }
    info.dates.add(row.date);
    if (info.lastDate === null || row.date > info.lastDate) {
      info.lastDate = row.date;
    }
    if (lastDate === null || row.date > lastDate) {
      lastDate = row.date;
    }
  }

  // Pins per ground: the coordinate mean and the pin count per date.
  const pinInfo = new Map();
  for (const pin of pins) {
    let info = pinInfo.get(pin.grp);
    if (info === undefined) {
      info = { latSum: 0, lonSum: 0, coordCount: 0, perDate: new Map() };
      pinInfo.set(pin.grp, info);
    }
    if (typeof pin.lat === "number" && Number.isFinite(pin.lat)
      && typeof pin.lon === "number" && Number.isFinite(pin.lon)) {
      info.latSum += pin.lat;
      info.lonSum += pin.lon;
      info.coordCount += 1;
    }
    info.perDate.set(pin.date, (info.perDate.get(pin.date) || 0) + 1);
  }

  const groups = new Set([...dayInfo.keys(), ...pinInfo.keys()]);
  const grounds = [];
  for (const group of groups) {
    const info = pinInfo.get(group);
    let lat = null;
    let lon = null;
    if (info !== undefined && info.coordCount > 0) {
      lat = round(info.latSum / info.coordCount, 5);
      lon = round(info.lonSum / info.coordCount, 5);
    }
    let holes = 0;
    if (info !== undefined && info.perDate.size > 0) {
      const counts = [...info.perDate.values()].sort((a, b) => a - b);
      holes = Math.round(lowerMedian(counts));
    }
    const day = dayInfo.get(group);
    grounds.push({
      group,
      lat,
      lon,
      days: day === undefined ? 0 : day.dates.size,
      lastDate: day === undefined ? null : day.lastDate,
      holes,
    });
  }
  grounds.sort((a, b) => {
    const left = a.lastDate === null ? "" : a.lastDate;
    const right = b.lastDate === null ? "" : b.lastDate;
    if (left !== right) {
      return left < right ? 1 : -1;
    }
    if (a.group === b.group) {
      return 0;
    }
    return a.group < b.group ? -1 : 1;
  });

  // The last 30 days, ascending, with the number of distinct grounds of a date.
  const groundsByDate = new Map();
  for (const row of days) {
    let set = groundsByDate.get(row.date);
    if (set === undefined) {
      set = new Set();
      groundsByDate.set(row.date, set);
    }
    set.add(row.grp);
  }
  const last30 = [];
  for (let i = 29; i >= 0; i -= 1) {
    const date = shiftDay(today, -i);
    const set = groundsByDate.get(date);
    last30.push({ date, grounds: set === undefined ? 0 : set.size });
  }

  // Sources and accuracy over the pins that were not reported missing.
  const sources = { estimated: 0, surveyed: 0, mapped: 0, detected: 0, none: 0 };
  const accuracies = [];
  let missing = 0;
  for (const pin of pins) {
    if (Number(pin.missing) === 1) {
      missing += 1;
      continue;
    }
    if (pin.source === "estimated" || pin.source === "surveyed"
      || pin.source === "mapped" || pin.source === "detected") {
      sources[pin.source] += 1;
    } else {
      sources.none += 1;
    }
    if (typeof pin.accuracy_m === "number" && Number.isFinite(pin.accuracy_m)) {
      accuracies.push(pin.accuracy_m);
    }
  }
  accuracies.sort((a, b) => a - b);
  const pinsTotal = pins.length;
  const missingShare = pinsTotal === 0 ? 0 : round(missing / pinsTotal, 3);
  const medianAccuracy = accuracies.length === 0 ? null : round(median(accuracies), 3);

  // Keys: the newest active row and how often the key was replaced.
  let active = null;
  let rotations = 0;
  for (const key of keys) {
    if (Number(key.active) === 1) {
      if (active === null || String(key.created) > String(active.created)) {
        active = { prefix: key.prefix === undefined ? null : key.prefix, created: key.created };
      }
    } else {
      rotations += 1;
    }
  }

  return {
    grounds,
    lastDate,
    last30,
    pinsTotal,
    sources,
    missingShare,
    medianAccuracy,
    keys: { active, rotations },
  };
}

const SOURCE_LABELS = [
  ["estimated", "paced from the edges"],
  ["surveyed", "measured with GNSS"],
  ["mapped", "placed on a map"],
  ["detected", "detected by a sensor"],
  ["none", "no source"],
];

function section(title, body) {
  return "<section>\n<h2>" + title + "</h2>\n<div class=\"karte\">\n" + body + "</div>\n</section>\n";
}

export function renderPartnerStats(stats, escapeHtml) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value);

  // 1. Where it delivers.
  let grounds = "";
  if (stats.grounds.length === 0) {
    grounds = "<p class=\"small\">No deliveries yet.</p>\n";
  } else {
    grounds = "<ul>\n";
    for (const ground of stats.grounds) {
      let line = "<li><span class=\"wert\">" + esc(ground.group) + "</span>";
      if (ground.lat !== null && ground.lon !== null) {
        // The URL is built from the rounded numbers only, never from text.
        const url = "https://www.openstreetmap.org/?mlat=" + ground.lat
          + "&amp;mlon=" + ground.lon + "#map=17/" + ground.lat + "/" + ground.lon;
        line += " <a href=\"" + url + "\">map</a>";
      }
      line += " " + ground.days + " days";
      if (ground.lastDate !== null) {
        line += ", last " + esc(ground.lastDate);
      }
      line += ", usually " + ground.holes + " holes</li>\n";
      grounds += line;
    }
    grounds += "</ul>\n";
  }

  // 2. Last 30 days.
  let maxGrounds = 0;
  for (const day of stats.last30) {
    if (day.grounds > maxGrounds) {
      maxGrounds = day.grounds;
    }
  }
  let bars = "<div style=\"display:flex;align-items:flex-end;gap:2px;height:50px\">";
  for (const day of stats.last30) {
    let height = 1;
    if (day.grounds > 0) {
      height = maxGrounds > 0
        ? Math.max(2, Math.round((day.grounds / maxGrounds) * 48))
        : 2;
    }
    // Green for a day with deliveries, the rule colour of the site for none.
    const colour = day.grounds > 0 ? "var(--green)" : "var(--rule-strong)";
    bars += "<div style=\"flex:1;height:" + height + "px;background:" + colour + ";border-radius:1px\" title=\""
      + esc(day.date) + ": " + day.grounds + " grounds\"></div>";
  }
  bars += "</div>\n<p class=\"small\">"
    + (stats.lastDate === null ? "No delivery yet" : "Last delivery: " + esc(stats.lastDate))
    + "</p>\n";

  // 3. Data.
  let sourceTotal = 0;
  for (const key of ["estimated", "surveyed", "mapped", "detected", "none"]) {
    sourceTotal += stats.sources[key];
  }
  let data = "<ul>\n<li>pins total <span class=\"wert\">" + stats.pinsTotal + "</span></li>\n";
  for (const [key, label] of SOURCE_LABELS) {
    if (stats.sources[key] > 0 && sourceTotal > 0) {
      data += "<li>" + label + " " + Math.round((stats.sources[key] / sourceTotal) * 100) + "%</li>\n";
    }
  }
  if (stats.medianAccuracy !== null) {
    data += "<li>median accuracy " + stats.medianAccuracy + " m</li>\n";
  }
  data += "<li>missing " + Math.round(stats.missingShare * 100) + "%</li>\n</ul>\n";

  // 4. Keys.
  let keyLine;
  if (stats.keys.active === null) {
    keyLine = "No active key";
  } else {
    const prefix = stats.keys.active.prefix === null ? "" : String(stats.keys.active.prefix);
    keyLine = "active <span class=\"wert\">" + esc(prefix) + "\u2026</span> created "
      + esc(String(stats.keys.active.created).slice(0, 10));
  }
  const keyBody = "<div class=\"zeile\"><span class=\"small\">" + keyLine + "</span></div>\n"
    + "<p class=\"small\">replaced " + stats.keys.rotations + " times</p>\n";

  return section("Where it delivers", grounds)
    + section("Last 30 days", bars)
    + section("Data", data)
    + section("Keys", keyBody);
}
