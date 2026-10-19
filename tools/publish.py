#!/usr/bin/env python3
"""Build the public v1 files from club exports (FORMAT.md 4.3).

Standard library only, Python 3.10+.

Input are CSV files in the club export format (FORMAT.md 5: channel 'club').
Every input is validated first with validate_csv_text(..., club_export=True);
one problem stops everything and nothing is written. Comment lines of the
input are not carried over: they carry the club name, which does not belong in
the open data set.

A day D is published only from D + 3 days (FORMAT.md 4.3). Per published day
the tool writes days/D.csv and days/D.geojson with the rows of all inputs for
D. An existing day file is never overwritten: a different content aborts with
exit 1 before anything is written. Year files are rebuilt from all day CSV of
a year.

Every file to write, day and year, is built in memory and checked against
FORMAT.md first; only then does the first byte reach the disk. A file that
does not validate is a program error and aborts with exit 2, with nothing
written. Finally index.py runs on the directory.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import index as _index  # noqa: E402
import validate as _validate  # noqa: E402

DAY_NAME = _index.DAY_NAME
# The wording of the four comment lines (FORMAT.md 4.1) and of the attribution
# (section 6) lives in validate.py, the source against which they are checked.
# A second copy here could drift from it; only the "# " prefix is added.
ATTRIBUTION = _validate.ATTRIBUTION
LICENCE_LINE = "# " + _validate.NOTE_LICENCE
ATTRIBUTION_LINE = "# " + _validate.NOTE_ATTRIBUTION
ESTIMATED_LINE = "# " + _validate.NOTE_ESTIMATED


def _parse_date(value):
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def _read_records(text):
    """Read an export text into records of raw field text, one per row.

    The 17 columns of FORMAT.md 2 are read by position; an export that ends
    after `missing` (FORMAT.md 5) leaves the last two empty. Columns after the
    17 are allowed (FORMAT.md 4.1) and are ignored here, so they cannot
    overwrite a checked value.
    """
    raw = text[1:] if text.startswith("\ufeff") else text
    lines = [line[:-1] if line.endswith("\r") else line for line in raw.split("\n")]
    if lines and lines[-1] == "":
        lines = lines[:-1]
    body = []
    seen_header = False
    for line in lines:
        if not seen_header and line.startswith("# "):
            continue
        body.append(line)
        seen_header = True
    reader = csv.reader(io.StringIO("\n".join(body)))
    next(reader)
    records = []
    for fields in reader:
        record = {}
        for index, name in enumerate(_validate.COLUMNS):
            record[name] = fields[index] if index < len(fields) else ""
        records.append(record)
    return records


def _hole_key(record):
    hole = record.get("hole", "")
    if hole.isdigit():
        return (0, int(hole), "")
    return (1, 0, hole)


def _order_key(record):
    return (record.get("date", ""),) + _hole_key(record)


def _closed(day, today):
    return _parse_date(day) + dt.timedelta(days=3) <= today


def _comments(title):
    return [title, LICENCE_LINE, ATTRIBUTION_LINE, ESTIMATED_LINE]


def _write_csv(title, records):
    """Build a CSV file as in FORMAT.md 4.1: BOM, CRLF, comments, header, rows."""
    buffer = io.StringIO()
    for line in _comments(title):
        buffer.write(line + "\r\n")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(_validate.COLUMNS)
    for record in records:
        writer.writerow([record.get(column, "") for column in _validate.COLUMNS])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def _properties_json(record):
    parts = []
    for column in _validate.PROPERTY_COLUMNS:
        value = record.get(column, "")
        if value == "":
            continue
        if column == "missing":
            parts.append('"missing": true')
        elif column in _validate.NUMBER_COLUMNS:
            # The field text is already in the normal form of section 4.1, so
            # it is the same text in the CSV and here. Writing it raw keeps
            # 52.1234561 from turning into 52.123456099999.
            parts.append('"%s": %s' % (column, value))
        else:
            parts.append("%s: %s" % (json.dumps(column, ensure_ascii=False),
                                      json.dumps(value, ensure_ascii=False)))
    return "{ " + ", ".join(parts) + " }"


def _geometry_json(record):
    lon = record.get("lon", "")
    lat = record.get("lat", "")
    if lon == "" or lat == "":
        return "null"
    return '{ "type": "Point", "coordinates": [%s, %s] }' % (lon, lat)


def _write_geojson(day, records):
    """Build a GeoJSON file as in FORMAT.md 4.2 and the example."""
    comments = _comments("# OpenPinsheet day file %s. Format 1." % day)
    notes = [line[2:] for line in comments]
    lines = ["{",
             ' "type": "FeatureCollection",',
             ' "format": 1,',
             ' "as_of": %s,' % json.dumps(day, ensure_ascii=False),
             ' "license": { "name": "Open Database License 1.0", "spdx": "ODbL-1.0",'
             ' "url": "https://opendatacommons.org/licenses/odbl/1-0/" },',
             ' "attribution": %s,' % json.dumps(ATTRIBUTION, ensure_ascii=False),
             ' "notes": [']
    for index, note in enumerate(notes):
        comma = "," if index < len(notes) - 1 else ""
        lines.append("  %s%s" % (json.dumps(note, ensure_ascii=False), comma))
    lines.append(" ],")
    lines.append(' "features": [')
    for index, record in enumerate(records):
        comma = "," if index < len(records) - 1 else ""
        lines.append("  {")
        lines.append('   "type": "Feature",')
        lines.append('   "geometry": %s,' % _geometry_json(record))
        lines.append('   "properties": %s' % _properties_json(record))
        lines.append("  }%s" % comma)
    lines.append(" ]")
    lines.append("}")
    return ("\n".join(lines) + "\n").encode("utf-8")


def _check_content(path, content):
    """Check one planned file in memory, before anything is written."""
    text = content.decode("utf-8")
    if path.endswith(".csv"):
        return _validate.validate_csv_text(text, path)
    return _validate.validate_geojson_text(text, path)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Build the public v1 files from club exports (FORMAT.md 4.3)")
    parser.add_argument("--channel", required=True,
                        help="replaces channel 'club'; a channel id of FORMAT.md 5")
    parser.add_argument("--out", required=True, help="the v1 directory to write into")
    parser.add_argument("--today", required=True, help="YYYY-MM-DD, the day of the run")
    parser.add_argument("--generated", default=None, help="YYYY-MM-DD, default --today")
    parser.add_argument("exports", nargs="+", help="club export CSV files")
    args = parser.parse_args(argv)

    if _validate.CHANNEL_RE.fullmatch(args.channel) is None or args.channel == "club":
        parser.error("--channel must match the channel rule of FORMAT.md 5 and must not be 'club'")
    today = _parse_date(args.today)
    if today is None:
        parser.error("--today must be a calendar date YYYY-MM-DD")
    generated = args.generated or args.today
    if _parse_date(generated) is None:
        parser.error("--generated must be a calendar date YYYY-MM-DD")

    # Validate every input first. One problem stops everything.
    records = []
    failed = False
    for path in args.exports:
        try:
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
        except OSError as exc:
            print("%s: %s" % (path, exc))
            failed = True
            continue
        found = _validate.validate_csv_text(text, path, club_export=True)
        if found:
            for problem in found:
                print("%s:%s: %s: %s" % (path, problem.where, problem.column, problem.message))
            failed = True
            continue
        records.extend(_read_records(text))
    if failed:
        print("validation failed, nothing written")
        return 1

    # Partner rows do not belong in the open set: only 'club' or a lost
    # position (empty channel) may enter.
    for record in records:
        channel = record.get("channel", "")
        if channel not in ("", "club"):
            print("%s hole %s carries channel '%s'; only 'club' or a lost position may enter"
                  % (record.get("date", "?"), record.get("hole", "?"), channel))
            return 1

    # Replace channel 'club' with the public channel.
    for record in records:
        if record.get("channel") == "club":
            record["channel"] = args.channel

    # A record carries no course id; the coordinate locates itself (FORMAT.md
    # 1). Two courses never share one coordinate, so two rows with a
    # coordinate that are equal in all 17 columns mean the same export was
    # read twice. Rows without a coordinate (a lost position, or a position
    # with only front_m and left_m) may be equal: the same hole can be lost on
    # two courses. Checked within this run only, before anything is written.
    seen_coordinates = set()
    for record in records:
        if not record.get("lat") or not record.get("lon"):
            continue
        key = tuple(record.get(column, "") for column in _validate.COLUMNS)
        if key in seen_coordinates:
            print("%s hole %s carries the same coordinate twice; "
                  "the same export was probably read twice, nothing written"
                  % (record.get("date", "?"), record.get("hole", "?")))
            return 1
        seen_coordinates.add(key)

    # Only closed days are published; younger rows are skipped.
    days = {}
    skipped = 0
    for record in records:
        day = record.get("date", "")
        if day and _closed(day, today):
            days.setdefault(day, []).append(record)
        else:
            skipped += 1

    plans = {}
    for day in sorted(days):
        rows = sorted(days[day], key=_order_key)
        plans[day] = (_write_csv("# OpenPinsheet day file %s. Format 1." % day, rows),
                      _write_geojson(day, rows))

    directory = args.out
    days_dir = os.path.join(directory, "days")
    years_dir = os.path.join(directory, "years")

    # Nothing is written until every existing day file is checked (4.3: a day
    # file does not change once published).
    for day in sorted(plans):
        csv_bytes, geo_bytes = plans[day]
        for path, content in ((os.path.join(days_dir, day + ".csv"), csv_bytes),
                              (os.path.join(days_dir, day + ".geojson"), geo_bytes)):
            if os.path.exists(path):
                with open(path, "rb") as handle:
                    if handle.read() != content:
                        print("%s already exists with different content, nothing written" % path)
                        return 1

    # Rebuild every year in memory from all day CSV of that year, both the
    # files already on disk and the day files planned in this run. Year files
    # may change as days are added.
    day_csv = {}
    if os.path.isdir(days_dir):
        for name in sorted(os.listdir(days_dir)):
            if name.endswith(".csv") and DAY_NAME.match(name):
                with open(os.path.join(days_dir, name), "rb") as handle:
                    day_csv[name] = handle.read()
    for day, (csv_bytes, _geo_bytes) in plans.items():
        day_csv[day + ".csv"] = csv_bytes
    years = {}
    for name in sorted(day_csv):
        years.setdefault(name[:4], []).extend(_read_records(day_csv[name].decode("utf-8")))
    year_contents = {}
    for year in sorted(years):
        rows = sorted(years[year], key=_order_key)
        year_contents[year] = _write_csv("# OpenPinsheet year file %s. Format 1." % year, rows)

    # Every file to write is checked in memory first. A problem here is a
    # program error, and nothing at all reaches the disk (FORMAT.md 4.3).
    planned = []
    for day in sorted(plans):
        csv_bytes, geo_bytes = plans[day]
        planned.append((os.path.join(days_dir, day + ".csv"), csv_bytes))
        planned.append((os.path.join(days_dir, day + ".geojson"), geo_bytes))
    for year in sorted(year_contents):
        planned.append((os.path.join(years_dir, year + ".csv"), year_contents[year]))

    failed = False
    for path, content in planned:
        problems = _check_content(path, content)
        for problem in problems:
            print("%s:%s: %s: %s" % (path, problem.where, problem.column, problem.message))
        failed = failed or bool(problems)
    if failed:
        print("a file to write does not validate, this is a program error")
        return 2

    written_days = 0
    unchanged_days = 0
    os.makedirs(days_dir, exist_ok=True)
    for day in sorted(plans):
        csv_bytes, geo_bytes = plans[day]
        pairs = ((os.path.join(days_dir, day + ".csv"), csv_bytes),
                 (os.path.join(days_dir, day + ".geojson"), geo_bytes))
        if all(os.path.exists(path) for path, _ in pairs):
            unchanged_days += 1
            continue
        for path, content in pairs:
            if not os.path.exists(path):
                with open(path, "wb") as handle:
                    handle.write(content)
        written_days += 1

    os.makedirs(years_dir, exist_ok=True)
    for year in sorted(year_contents):
        path = os.path.join(years_dir, year + ".csv")
        with open(path, "wb") as handle:
            handle.write(year_contents[year])

    code = _index.main([directory, "--generated", generated])
    if code != 0:
        print("index failed, this is a program error")
        return 2

    print("%d day(s) written, %d day(s) unchanged, %d row(s) skipped (not closed)"
          % (written_days, unchanged_days, skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
