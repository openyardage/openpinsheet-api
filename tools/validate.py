#!/usr/bin/env python3
"""Check CSV and GeoJSON files against FORMAT.md, version 1.

Standard library only, Python 3.10+.

The rules between columns (FORMAT.md 2.1) live in one function, check_row.
Both readers build the same dict, one key per column with a value or None, and
hand it to that function. Rules that exist in only one container (the number
text of CSV, the geometry of GeoJSON) are checked next to their reader.

Importable:
    validate_csv_text(text, filename=None, club_export=False) -> list[Problem]
    validate_geojson_text(text, filename=None, club_export=False) -> list[Problem]
    check_row(row, where, club_export=False) -> list[Problem]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import decimal
import io
import json
import os
import re
import sys
from collections import namedtuple
from decimal import Decimal

Problem = namedtuple("Problem", "where column message")

COLUMNS = (
    "date", "date_basis", "hole", "lat", "lon", "source", "accuracy_m",
    "front_m", "left_m", "input_front", "input_offset", "input_side",
    "input_unit", "channel", "missing", "play_bearing_deg", "correction",
)
# FORMAT.md 7: play_bearing_deg and correction came after missing within
# format 1. A club export may still end after missing (FORMAT.md 5), because
# the first producers wrote 15 columns; a published file carries all 17.
REQUIRED_COLUMNS = COLUMNS[:15]
NUMBER_COLUMNS = frozenset(
    ("lat", "lon", "accuracy_m", "front_m", "left_m", "input_front", "input_offset",
     "play_bearing_deg")
)
PROPERTY_COLUMNS = tuple(c for c in COLUMNS if c not in ("lat", "lon"))
# FORMAT.md 2.1: a lost position keeps lat through channel empty, and the two
# columns after missing as well.
POSITION_COLUMNS = COLUMNS[3:14] + ("play_bearing_deg", "correction")
SOURCES = ("estimated", "surveyed", "mapped", "detected")
CORRECTIONS = ("none", "ppp", "rtk", "ppk")
INPUT_COLUMNS = ("input_front", "input_offset", "input_side", "input_unit")
BEARING_DECIMALS = 1

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NUMBER_RE = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$")
HOLE_RE = re.compile(r"^[0-9A-Za-z]{1,8}$")
# FORMAT.md 5. The "-" came in on 19.10.2026: the account page of the API
# builds a channel id from a partner name with "-" between the words, and
# until then the first such partner would have failed this check.
CHANNEL_RE = re.compile(r"^(?=.{2,40}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
DAY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.(csv|geojson)$", re.IGNORECASE)
YEAR_RE = re.compile(r"^(\d{4})\.csv$", re.IGNORECASE)
DAY_TITLE_RE = re.compile(r"^OpenPinsheet day file \d{4}-\d{2}-\d{2}\. Format 1\.$")
YEAR_TITLE_RE = re.compile(r"^OpenPinsheet year file \d{4}\. Format 1\.$")
MAX_DECIMALS = 7
LICENSE_NAME = "Open Database License 1.0"
LICENSE_SPDX = "ODbL-1.0"
LICENSE_URL = "https://opendatacommons.org/licenses/odbl/1-0/"

# The wording of FORMAT.md 4.1 and section 6. A published CSV carries the four
# as comment lines prefixed with "# "; the GeoJSON carries the same four as
# notes without the prefix, and its "attribution" is the text of section 6.
NOTE_LICENCE = ("Licence: Open Database License 1.0 (ODbL) "
                "https://opendatacommons.org/licenses/odbl/1-0/")
NOTE_ATTRIBUTION = ("Attribution: Pin positions: OpenPinsheet and its data partners. "
                    "Open Database License 1.0.")
NOTE_ESTIMATED = ("Estimated positions are computed against green outlines from "
                  "OpenStreetMap: map data \u00a9 OpenStreetMap contributors (ODbL).")
ATTRIBUTION = ("Pin positions: OpenPinsheet and its data partners, Open Database License 1.0. "
               "Estimated positions are computed against green outlines from OpenStreetMap: "
               "map data \u00a9 OpenStreetMap contributors (ODbL).")

# A value that is present but could not be parsed. It counts as present for the
# rules between columns, so one broken field does not also look empty.
_INVALID = object()


def _valid_date(value):
    if not isinstance(value, str) or DATE_RE.match(value) is None:
        return False
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _decimals(value):
    exponent = value.as_tuple().exponent
    if isinstance(exponent, int) and exponent < 0:
        return -exponent
    return 0


def _title_sentence_ok(sentence, filename):
    """The title names the file: a day carries its date, a year its year.

    Without a file name that tells which, either form is accepted. The title
    is the same sentence in the CSV comment lines and in the GeoJSON notes.
    """
    name = os.path.basename(filename) if filename else ""
    match = DAY_RE.match(name)
    if match:
        return sentence == "OpenPinsheet day file %s. Format 1." % match.group(1)
    match = YEAR_RE.match(name)
    if match:
        return sentence == "OpenPinsheet year file %s. Format 1." % match.group(1)
    return (DAY_TITLE_RE.fullmatch(sentence) is not None
            or YEAR_TITLE_RE.fullmatch(sentence) is not None)


def _tail_ok(sentences, filename):
    """FORMAT.md 4.1: the last four sentences are the four of the format."""
    if len(sentences) < 4:
        return False
    tail = sentences[-4:]
    if tail[1:] != [NOTE_LICENCE, NOTE_ATTRIBUTION, NOTE_ESTIMATED]:
        return False
    return _title_sentence_ok(tail[0], filename)


def check_row(row, where, club_export=False):
    """Check one record against FORMAT.md 2 and 2.1.

    row maps every column to a value or None. Text columns carry str, number
    columns Decimal or int, missing carries True. The same function serves the
    CSV reader and the GeoJSON reader.
    """
    problems = []

    def add(column, message):
        problems.append(Problem(where, column, message))

    def text(value, column, allowed=None, pattern=None):
        if value is None or value is _INVALID:
            return
        if not isinstance(value, str):
            add(column, "must be text")
        elif allowed is not None and value not in allowed:
            add(column, "must be one of " + ", ".join(allowed))
        elif pattern is not None and pattern.fullmatch(value) is None:
            add(column, "has the wrong form")

    def number(value, column, lo=None, hi=None, gt=None, ge=None):
        if value is None or value is _INVALID:
            return
        if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
            add(column, "must be a number")
            return
        # FORMAT.md 4.1: every number carries at most 7 decimals, not only lat
        # and lon.
        if isinstance(value, Decimal) and _decimals(value) > MAX_DECIMALS:
            add(column, "has more than %d decimals" % MAX_DECIMALS)
        if lo is not None and value < lo:
            add(column, "is below %s" % lo)
        if hi is not None and value > hi:
            add(column, "is above %s" % hi)
        if gt is not None and value <= gt:
            add(column, "must be greater than %s" % gt)
        if ge is not None and value < ge:
            add(column, "must be %s or more" % ge)

    # One value per column, section 2.
    date = row.get("date")
    if date is None:
        add("date", "is required")
    elif date is not _INVALID:
        if not isinstance(date, str):
            add("date", "must be text")
        elif not _valid_date(date):
            add("date", "is not a valid calendar date YYYY-MM-DD")
    if row.get("date_basis") is None:
        add("date_basis", "is required")
    else:
        text(row.get("date_basis"), "date_basis", allowed=("local", "utc"))
    if row.get("hole") is None:
        add("hole", "is required")
    else:
        text(row.get("hole"), "hole", pattern=HOLE_RE)
    text(row.get("source"), "source", allowed=SOURCES)
    text(row.get("input_side"), "input_side", allowed=("left", "right"))
    text(row.get("input_unit"), "input_unit", allowed=("m", "yd"))
    text(row.get("correction"), "correction", allowed=CORRECTIONS)

    channel = row.get("channel")
    if channel is not None and channel is not _INVALID:
        if not isinstance(channel, str):
            add("channel", "must be text")
        elif CHANNEL_RE.fullmatch(channel) is None:
            add("channel", "must be 2 to 40 characters, lowercase letters and digits joined by single '-', starting with a letter")
        elif channel == "club" and not club_export:
            add("channel", "'club' is only allowed in a club export")

    number(row.get("lat"), "lat", lo=-90, hi=90)
    number(row.get("lon"), "lon", lo=-180, hi=180)
    number(row.get("accuracy_m"), "accuracy_m", gt=0)
    number(row.get("front_m"), "front_m", ge=0)
    number(row.get("left_m"), "left_m", ge=0)
    number(row.get("input_front"), "input_front", ge=0)
    number(row.get("input_offset"), "input_offset", ge=0)
    bearing = row.get("play_bearing_deg")
    number(bearing, "play_bearing_deg", ge=0)
    if isinstance(bearing, (int, Decimal)) and not isinstance(bearing, bool):
        if bearing >= 360:
            add("play_bearing_deg", "must be less than 360")
        # Normalised first: a trailing zero (274.50) is already reported as
        # the wrong number form and is not a second decimal.
        if isinstance(bearing, Decimal) and _decimals(bearing.normalize()) > BEARING_DECIMALS:
            add("play_bearing_deg", "has more than %d decimal" % BEARING_DECIMALS)

    # Rules between columns, section 2.1.
    missing = row.get("missing")
    if missing is True:
        for column in POSITION_COLUMNS:
            if row.get(column) is not None:
                add(column, "must be empty when missing is set")
        return problems
    if missing is not None and missing is not _INVALID:
        add("missing", "must be 1 (GeoJSON: true) or empty")
    if missing is _INVALID:
        return problems

    source = row.get("source")
    source_given = source is not None and source is not _INVALID
    has_lat = row.get("lat") is not None
    has_lon = row.get("lon") is not None

    if channel is None:
        add("channel", "is required for a position")
    if has_lat != has_lon:
        add("lon" if has_lat else "lat", "lat and lon are given together or not at all")
    if has_lat and has_lon and not source_given:
        add("source", "is required when lat and lon are given")

    front = row.get("front_m")
    left = row.get("left_m")
    if not source_given:
        if front is None or left is None:
            add("front_m" if front is None else "left_m",
                "front_m and left_m are both required when source is empty")
    elif (front is None) != (left is None):
        add("left_m" if front is not None else "front_m",
            "front_m and left_m are given together or not at all")

    accuracy = row.get("accuracy_m")
    if source in ("surveyed", "detected"):
        if accuracy is None:
            add("accuracy_m", "is required for source surveyed and detected")
    elif source == "estimated" or not source_given:
        if accuracy is not None:
            add("accuracy_m", "must be empty for estimated and for rows without source")

    present = [row.get(c) is not None for c in INPUT_COLUMNS]
    if any(present) and not all(present):
        add(INPUT_COLUMNS[present.index(False)],
            "input_front, input_offset, input_side and input_unit are given all four or none")
    elif all(present) and source != "estimated":
        add("input_unit", "input_* is only allowed with source estimated")

    if row.get("play_bearing_deg") is not None and not all(present):
        add("play_bearing_deg", "is only allowed together with the four input_*")

    if row.get("correction") is not None and source != "surveyed":
        add("correction", "is only allowed with source surveyed")

    return problems


# CSV ---------------------------------------------------------------------

def _csv_flag(field, where, problems):
    if field == "":
        return None
    if field == "1":
        return True
    problems.append(Problem(where, "missing", "missing must be '1' or empty"))
    return _INVALID


def _csv_number(field, column, where, problems):
    if field == "":
        return None
    if NUMBER_RE.fullmatch(field) is None:
        problems.append(Problem(where, column, "not the number form of section 4.1"))
        try:
            value = Decimal(field)
        except decimal.InvalidOperation:
            return _INVALID
        return value if value.is_finite() else _INVALID
    if field == "-0":
        problems.append(Problem(where, column, "-0 is written 0"))
    return Decimal(field)


def _csv_row(fields, where, problems):
    row = {}
    for index, name in enumerate(COLUMNS):
        field = fields[index] if index < len(fields) else ""
        if name == "missing":
            row[name] = _csv_flag(field, where, problems)
        elif name in NUMBER_COLUMNS:
            row[name] = _csv_number(field, name, where, problems)
        else:
            row[name] = field if field != "" else None
    return row


def _read_csv_records(content, problems):
    body = "\n".join(line for _, line in content)
    reader = csv.reader(io.StringIO(body))
    header = None
    rows = []
    while True:
        start = reader.line_num
        try:
            fields = next(reader)
        except StopIteration:
            break
        except csv.Error as exc:
            where = content[start][0] if start < len(content) else content[-1][0]
            problems.append(Problem(where, "csv", str(exc)))
            return rows, header
        where = content[start][0] if start < len(content) else content[-1][0]
        if header is None:
            header = fields
        else:
            rows.append((where, fields))
    return rows, header


def _check_comments(comments, filename, problems):
    """FORMAT.md 4.1: a published file ends its comment lines with the four.

    Further comment lines before them are allowed (the example files carry the
    EXAMPLE line before the four).
    """
    sentences = [line[2:] if line.startswith("# ") else line for _, line in comments]
    if _tail_ok(sentences, filename):
        return
    if comments:
        where = comments[-4][0] if len(comments) >= 4 else comments[0][0]
    else:
        where = 1
    problems.append(Problem(where, "#",
                            "the last four comment lines must be the four lines of FORMAT.md 4.1"))


def validate_csv_text(text, filename=None, club_export=False):
    problems = []
    raw = text[1:] if text.startswith("\ufeff") else text
    lines = raw.split("\n")
    if raw.endswith("\n"):
        lines = lines[:-1]
    lines = [line[:-1] if line.endswith("\r") else line for line in lines]

    content = []
    comments = []
    header_line = 1
    seen_header = False
    for physical, line in enumerate(lines, start=1):
        if line.startswith("# "):
            if seen_header:
                problems.append(Problem(physical, "#", "a comment line is only allowed before the header"))
            else:
                if "," in line:
                    problems.append(Problem(physical, "#", "a comment line must not contain a comma"))
                comments.append((physical, line))
            continue
        if not seen_header:
            seen_header = True
            header_line = physical
        content.append((physical, line))

    if not content:
        problems.append(Problem(header_line, "date", "no header row"))
        return problems

    rows, header = _read_csv_records(content, problems)
    if header is None:
        return problems

    # A header names every column once. A repeated name would make a later
    # column overwrite the checked value of an earlier one in a reader that
    # maps fields by name (FORMAT.md 4.1).
    seen_names = set()
    reported = set()
    for name in header:
        if name in seen_names and name not in reported:
            problems.append(Problem(header_line, name,
                                    "column '%s' appears more than once in the header" % name))
            reported.add(name)
        seen_names.add(name)

    required = REQUIRED_COLUMNS if club_export else COLUMNS
    if len(header) < len(required):
        problems.append(Problem(header_line, COLUMNS[len(header)],
                                "the %d columns of section 2 are required in this order"
                                % len(required)))
    for index, name in enumerate(COLUMNS):
        if index < len(header) and header[index] != name:
            problems.append(Problem(header_line, name,
                                    "expected column '%s', got '%s'" % (name, header[index])))

    if not club_export:
        _check_comments(comments, filename, problems)

    width = len(header)
    data = []
    for where, fields in rows:
        if len(fields) != width:
            problems.append(Problem(where, "fields",
                                    "expected %d fields, got %d" % (width, len(fields))))
            continue
        row = _csv_row(fields, where, problems)
        problems.extend(check_row(row, where, club_export))
        data.append((where, row))

    _check_order(data, problems)
    _check_day_file(data, filename, club_export, problems)
    _check_year_file(data, filename, club_export, problems)
    return problems


# GeoJSON -----------------------------------------------------------------

def validate_geojson_text(text, filename=None, club_export=False):
    try:
        root = json.loads(text, parse_float=Decimal)
    except json.JSONDecodeError as exc:
        return [Problem(exc.lineno, "json", exc.msg)]
    if not isinstance(root, dict):
        return [Problem(0, "type", "the top level must be an object")]

    problems = []
    if root.get("type") != "FeatureCollection":
        problems.append(Problem(0, "type", "type must be 'FeatureCollection'"))
    fmt = root.get("format")
    if isinstance(fmt, bool) or not isinstance(fmt, int) or fmt != 1:
        problems.append(Problem(0, "format", "format must be the integer 1"))
    if not _valid_date(root.get("as_of")):
        problems.append(Problem(0, "as_of", "as_of must be a calendar date YYYY-MM-DD"))
    license_ = root.get("license")
    expected_license = {"name": LICENSE_NAME, "spdx": LICENSE_SPDX, "url": LICENSE_URL}
    if not isinstance(license_, dict) or any(
            license_.get(key) != value for key, value in expected_license.items()):
        problems.append(Problem(0, "license",
                                "license must carry name, spdx and url as in FORMAT.md 4.2"))
    if not club_export:
        attribution = root.get("attribution")
        if not isinstance(attribution, str):
            problems.append(Problem(0, "attribution", "attribution must be text"))
        elif attribution != ATTRIBUTION:
            problems.append(Problem(0, "attribution",
                                    "attribution must be the text of FORMAT.md section 6"))
        notes = root.get("notes")
        if not isinstance(notes, list) or not all(isinstance(note, str) for note in notes):
            problems.append(Problem(0, "notes", "notes must be a list of texts"))
        elif not _tail_ok(notes, filename):
            problems.append(Problem(0, "notes",
                                    "notes must end with the four sentences of FORMAT.md 4.1"))

    features = root.get("features")
    if not isinstance(features, list):
        problems.append(Problem(0, "features", "features must be a list"))
        return problems

    data = []
    for index, feature in enumerate(features, start=1):
        where = "feature %d" % index
        row_problems, row = _geojson_feature(feature, where, club_export)
        problems.extend(row_problems)
        if row is not None:
            data.append((where, row))

    _check_order(data, problems)
    _check_day_file(data, filename, club_export, problems)
    _check_year_file(data, filename, club_export, problems)
    return problems


def _geojson_number_form(value, column, where, problems):
    """Check a Decimal against the number form of FORMAT.md 4.1.

    JSON carries 12.0 and 1e2 as Decimals when read with parse_float=Decimal,
    and both are the same value as 12 for a reader. The format does not allow
    that: the number must be the plain decimal form. The rule is read off the
    Decimal itself and not off str(value): Python writes a small value such as
    Decimal("0.0000005") as "5E-7", which is scientific notation in the text
    only and still the plain decimal 0.0000005 of 4.1. An int is always fine,
    and JSON never writes one as 12.0.
    """
    if not isinstance(value, Decimal):
        return
    if not value.is_finite():
        problems.append(Problem(where, column, "not the number form of section 4.1"))
        return
    sign, digits, exponent = value.as_tuple()
    # Negative zero in any spelling (-0, -0.0) is not written that way.
    if sign and not any(digits):
        problems.append(Problem(where, column, "not the number form of section 4.1"))
        return
    # An exponent above zero is scientific notation (1E+2).
    if exponent > 0:
        problems.append(Problem(where, column, "not the number form of section 4.1"))
        return
    # A trailing zero after the decimal point (12.0, 0.0) is not written that way.
    if exponent < 0 and digits[-1] == 0:
        problems.append(Problem(where, column, "not the number form of section 4.1"))


def _geojson_coordinate(value, where, problems):
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        problems.append(Problem(where, "geometry", "coordinates must be [lon, lat] numbers"))
        return _INVALID
    _geojson_number_form(value, "geometry", where, problems)
    return value


def _geojson_feature(feature, where, club_export):
    problems = []
    row = {name: None for name in COLUMNS}

    if not isinstance(feature, dict):
        problems.append(Problem(where, "-", "a feature must be an object"))
        return problems, None
    if feature.get("type") != "Feature":
        problems.append(Problem(where, "type", "type must be 'Feature'"))

    if "geometry" not in feature:
        problems.append(Problem(where, "geometry", "geometry is required, a Point or null"))
    else:
        geometry = feature["geometry"]
        if geometry is None:
            pass
        elif not isinstance(geometry, dict):
            problems.append(Problem(where, "geometry", "geometry must be a Point or null"))
        else:
            if geometry.get("type") != "Point":
                problems.append(Problem(where, "geometry", "geometry.type must be 'Point'"))
            coordinates = geometry.get("coordinates")
            if not isinstance(coordinates, list) or len(coordinates) != 2:
                problems.append(Problem(where, "geometry", "coordinates must be [lon, lat]"))
            else:
                row["lon"] = _geojson_coordinate(coordinates[0], where, problems)
                row["lat"] = _geojson_coordinate(coordinates[1], where, problems)

    properties = feature.get("properties")
    if not isinstance(properties, dict):
        problems.append(Problem(where, "properties", "properties must be an object"))
    else:
        for key, value in properties.items():
            if key not in PROPERTY_COLUMNS:
                problems.append(Problem(where, "properties", "unknown property '%s'" % key))
                continue
            if value is None:
                # Present but unreadable: counts as present for the rules
                # between columns, so it does not also look empty.
                problems.append(Problem(where, key, "a value must not be null"))
                row[key] = _INVALID
                continue
            if key == "missing":
                if value is True:
                    row["missing"] = True
                else:
                    problems.append(Problem(where, "missing", "missing must be true or left out"))
                    row["missing"] = _INVALID
            else:
                if key in NUMBER_COLUMNS:
                    _geojson_number_form(value, key, where, problems)
                row[key] = value

    # FORMAT.md 4.2: a lost position always has geometry null. The coordinate
    # is cleared so the column rules do not report lat and lon a second time.
    if row.get("missing") is True and feature.get("geometry") is not None:
        problems.append(Problem(where, "geometry", "a lost position needs geometry null"))
        row["lon"] = None
        row["lat"] = None

    problems.extend(check_row(row, where, club_export))
    return problems, row


# Order (2.2) and day files ----------------------------------------------

def _order_key(row):
    date = row.get("date")
    hole = row.get("hole")
    if not isinstance(date, str) or DATE_RE.match(date) is None:
        return None
    if not isinstance(hole, str) or HOLE_RE.fullmatch(hole) is None:
        return None
    if hole.isdigit():
        return (date, 0, int(hole), "")
    return (date, 1, 0, hole)


def _check_order(data, problems):
    previous = None
    for where, row in data:
        key = _order_key(row)
        if key is None:
            continue
        if previous is not None and key < previous[1]:
            column = "date" if key[0] != previous[1][0] else "hole"
            problems.append(Problem(where, column, "rows must be sorted by date, then hole"))
        previous = (where, key)


def _check_day_file(data, filename, club_export, problems):
    if not filename or club_export:
        return
    match = DAY_RE.match(os.path.basename(filename))
    if match is None:
        return
    day = match.group(1)
    for where, row in data:
        if row.get("date") != day:
            problems.append(Problem(where, "date", "every row in this day file must carry date %s" % day))


def _check_year_file(data, filename, club_export, problems):
    # FORMAT.md 4.3: a year file holds all days of a year. A row of another
    # year cannot be in it. Only a well-formed date is judged here; a broken
    # date is reported by the date rule itself.
    if not filename or club_export:
        return
    match = YEAR_RE.match(os.path.basename(filename))
    if match is None:
        return
    year = match.group(1)
    for where, row in data:
        date = row.get("date")
        if isinstance(date, str) and DATE_RE.match(date) and not date.startswith(year):
            problems.append(Problem(where, "date",
                                    "every row in this year file must lie in year %s" % year))


# Command line ------------------------------------------------------------

def _validate_path(path, club_export):
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    extension = os.path.splitext(path)[1].lower()
    if extension == ".csv":
        return validate_csv_text(text, path, club_export)
    if extension == ".geojson":
        return validate_geojson_text(text, path, club_export)
    return [Problem(0, "file", "only .csv and .geojson are checked")]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check CSV and GeoJSON files against FORMAT.md")
    parser.add_argument("--club-export", action="store_true",
                        help="allow channel 'club' (FORMAT.md section 5)")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args(argv)

    total = 0
    for path in args.files:
        try:
            problems = _validate_path(path, args.club_export)
        except OSError as exc:
            print("%s:0: file: %s" % (path, exc))
            total += 1
            continue
        for problem in problems:
            print("%s:%s: %s: %s" % (path, problem.where, problem.column, problem.message))
        total += len(problems)

    print("%d file(s), %d problem(s)" % (len(args.files), total))
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
