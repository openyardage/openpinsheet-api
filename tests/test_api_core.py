"""Cross-check api/src/core.js against the Python tools.

Package 1 of the API is the pure core. This test runs api/test/emit.mjs with
Node 24, which writes a v1 directory with core.js, and then checks that

1. tools/validate.py finds no problem in any file,
2. tools/index.py --check is green,
3. the day CSV, the day GeoJSON and the year CSV are byte for byte the files
   tools/publish.py writes from the same rows as a club export.

The Node call is a subprocess (tests/node24.py finds Node 24); without it the
test is skipped, in CI it fails. The
run is offline, nothing outside the temporary directory is touched.
"""
import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import index  # noqa: E402
import publish  # noqa: E402
import validate  # noqa: E402
from node24 import NODE24, REQUIRED  # noqa: E402

DATE = "2027-04-12"
YEAR = "2027"
CHANNEL = "openyardage"
TODAY = "2027-04-15"          # DATE + 3, the first day the day file may be published
GENERATED = "2027-04-15"


def row(hole, **kwargs):
    base = {"date": DATE, "date_basis": "local", "hole": hole, "channel": CHANNEL}
    base.update(kwargs)
    return base


# The fixed row set: estimated with input in m (with play_bearing_deg) and in
# yd (without), surveyed with correction, mapped, a lost position, and a
# position without source carrying only front_m and left_m. Holes 2, 10 and B3 are mixed on purpose (FORMAT.md 2.2).
ROWS = [
    row("2", lat=52.1234561, lon=13.1234573, source="estimated", front_m=12, left_m=9.5,
        input_front=12, input_offset=5, input_side="right", input_unit="m",
        play_bearing_deg=274.5),
    row("10", lat=52.1240001, lon=13.1240002, source="estimated", front_m=8, left_m=4.2,
        input_front=9, input_offset=7, input_side="left", input_unit="yd"),
    row("B3", lat=52.1250003, lon=13.1250004, source="surveyed", accuracy_m=0.03,
        correction="rtk"),
    row("5", lat=52.1260005, lon=13.1260006, source="mapped"),
    {"date": DATE, "date_basis": "local", "hole": "11", "missing": True},
    row("A1", front_m=6, left_m=3),
]


def text(value):
    """The plain text of a value, the form FORMAT.md 4.1 writes and reads."""
    if value is True:
        return "1"
    if isinstance(value, bool):
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return str(value)


def order_key(item):
    hole = item.get("hole", "")
    hole_key = (0, int(hole), "") if hole.isdigit() else (1, 0, hole)
    return (item.get("date", ""),) + hole_key


def export_text(rows):
    lines = ["# Club: Secret Golf Club"]
    lines.append(",".join(validate.COLUMNS))
    for item in sorted(rows, key=order_key):
        lines.append(",".join(text(item.get(column, "")) for column in validate.COLUMNS))
    return "\n".join(lines) + "\n"


def club_rows():
    rows = []
    for item in ROWS:
        copy = dict(item)
        if copy.get("missing") is True:
            copy.pop("channel", None)
        else:
            copy["channel"] = "club"
        rows.append(copy)
    return rows


@unittest.skipUnless(NODE24 or REQUIRED, "Node 24 not available")
class ApiCoreCrossCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.v1 = os.path.join(self.tmp, "v1")
        self.rows_json = os.path.join(self.tmp, "rows.json")
        with open(self.rows_json, "w", encoding="utf-8") as handle:
            json.dump(ROWS, handle)

    def run_emit(self):
        emit = os.path.join(ROOT, "api", "test", "emit.mjs")
        self.assertIsNotNone(NODE24, "Node 24 is required in CI")
        command = NODE24 + [emit, self.v1, self.rows_json]
        return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=30)

    def emitted_files(self):
        found = []
        for base, _, names in os.walk(self.v1):
            for name in sorted(names):
                if name.endswith(".csv") or name.endswith(".geojson"):
                    found.append(os.path.join(base, name))
        return sorted(found)

    def test_core_files_validate_match_python_and_index(self):
        result = self.run_emit()
        self.assertEqual(result.returncode, 0, result.stderr)

        files = self.emitted_files()
        self.assertEqual(sorted(os.path.relpath(path, self.v1) for path in files),
                         ["days/%s.csv" % DATE, "days/%s.geojson" % DATE, "years/%s.csv" % YEAR])

        # 1. tools/validate.py finds no problem, with the file names.
        for path in files:
            with open(path, encoding="utf-8") as handle:
                content = handle.read()
            if path.endswith(".csv"):
                problems = validate.validate_csv_text(content, path)
            else:
                problems = validate.validate_geojson_text(content, path)
            self.assertEqual(problems, [], "%s: %s" % (path, problems))

        # 2. tools/index.py --check is green.
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = index.main(["--check", self.v1])
        self.assertEqual(code, 0, output.getvalue())

        # 3. byte equality with tools/publish.py from the same rows.
        export = os.path.join(self.tmp, "club_export.csv")
        with open(export, "w", encoding="utf-8", newline="") as handle:
            handle.write(export_text(club_rows()))
        published = os.path.join(self.tmp, "published")
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = publish.main(["--channel", CHANNEL, "--out", published,
                                 "--today", TODAY, "--generated", GENERATED, export])
        self.assertEqual(code, 0, output.getvalue())

        relatives = ["days/%s.csv" % DATE, "days/%s.geojson" % DATE, "years/%s.csv" % YEAR]
        for relative in relatives:
            with open(os.path.join(self.v1, relative), "rb") as handle:
                core_bytes = handle.read()
            with open(os.path.join(published, relative), "rb") as handle:
                python_bytes = handle.read()
            self.assertEqual(core_bytes, python_bytes, relative)


if __name__ == "__main__":
    unittest.main()
