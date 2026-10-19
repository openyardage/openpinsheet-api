#!/usr/bin/env python3
"""Write v1/index.json for a v1 directory (FORMAT.md 4.3).

Every file under days/ and years/ is listed with its kind, date or year, size,
sha256 and row count. The validator runs on each file first; a problem stops
the write.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import validate as _validate  # noqa: E402

LICENSE = {
    "name": "Open Database License 1.0",
    "spdx": "ODbL-1.0",
    "url": "https://opendatacommons.org/licenses/odbl/1-0/",
}
DAY_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2})\.(csv|geojson)$")
YEAR_NAME = re.compile(r"^(\d{4})\.csv$")
GENERATED_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _iter_files(directory):
    for sub, kind in (("days", "day"), ("years", "year")):
        folder = os.path.join(directory, sub)
        if not os.path.isdir(folder):
            continue
        for name in sorted(os.listdir(folder)):
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                yield kind, "%s/%s" % (sub, name), path


def _name_matches(path):
    # The directory decides the kind. A .geojson under years/ is a wrong name
    # and not a day file, so it is reported instead of crashing later.
    base = os.path.basename(path)
    if os.path.basename(os.path.dirname(path)) == "years":
        return YEAR_NAME.match(base) is not None
    return DAY_NAME.match(base) is not None


def _rows_csv(raw):
    # Count records over the csv module, not physical lines: a quoted field may
    # carry a line break and would then be counted as several rows.
    text = raw.decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    lines = [line[:-1] if line.endswith("\r") else line for line in text.split("\n")]
    if lines and lines[-1] == "":
        lines = lines[:-1]
    body = []
    seen_header = False
    for line in lines:
        if not seen_header and line.startswith("# "):
            continue
        body.append(line)
        seen_header = True
    if not body:
        return 0
    records = list(csv.reader(io.StringIO("\n".join(body))))
    return max(len(records) - 1, 0)


def _rows_geojson(raw):
    data = json.loads(raw.decode("utf-8"))
    features = data.get("features") if isinstance(data, dict) else None
    return len(features) if isinstance(features, list) else 0


def _file_entry(kind, rel, path):
    with open(path, "rb") as handle:
        raw = handle.read()
    entry = {"path": rel, "kind": kind}
    if kind == "day":
        entry["date"] = DAY_NAME.match(os.path.basename(path)).group(1)
    else:
        entry["year"] = YEAR_NAME.match(os.path.basename(path)).group(1)
    entry["bytes"] = len(raw)
    entry["sha256"] = hashlib.sha256(raw).hexdigest()
    entry["rows"] = _rows_csv(raw) if rel.endswith(".csv") else _rows_geojson(raw)
    return entry


def build_index(directory, generated):
    entries = [_file_entry(kind, rel, path) for kind, rel, path in _iter_files(directory)]
    entries.sort(key=lambda entry: entry["path"])
    return {"format": 1, "generated": generated, "license": LICENSE, "files": entries}


def _validate_directory(directory):
    problems = []
    for kind, rel, path in _iter_files(directory):
        if not _name_matches(path):
            problems.append((path, _validate.Problem(0, "path", "the file name does not match its kind")))
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
        if path.endswith(".csv"):
            found = _validate.validate_csv_text(text, path)
        else:
            found = _validate.validate_geojson_text(text, path)
        for problem in found:
            problems.append((path, problem))
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write index.json for a v1 directory")
    parser.add_argument("directory")
    parser.add_argument("--generated", default=None, help="YYYY-MM-DD, default today UTC")
    parser.add_argument("--check", action="store_true", help="compare, write nothing")
    args = parser.parse_args(argv)

    generated = args.generated or dt.datetime.now(dt.timezone.utc).date().isoformat()
    if GENERATED_RE.match(generated) is None:
        parser.error("--generated must be YYYY-MM-DD")

    directory = args.directory
    problems = _validate_directory(directory)
    if problems:
        for path, problem in problems:
            print("%s:%s: %s: %s" % (path, problem.where, problem.column, problem.message))
        print("validation failed")
        return 1

    index = build_index(directory, generated)
    target = os.path.join(directory, "index.json")

    if args.check:
        try:
            with open(target, encoding="utf-8") as handle:
                existing = json.load(handle)
        except OSError:
            print("missing %s" % target)
            return 1
        existing.pop("generated", None)
        expected = dict(index)
        expected.pop("generated", None)
        if existing != expected:
            print("%s does not match the files" % target)
            return 1
        return 0

    with open(target, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(index, indent=1, ensure_ascii=False) + "\n")
    print("wrote %s" % target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
