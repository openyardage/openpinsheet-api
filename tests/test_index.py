"""Tests for tools/index.py."""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import index  # noqa: E402

EXAMPLES = os.path.join(ROOT, "examples", "v1")


def run(args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = index.main(args)
    return code, out.getvalue()


class TestIndex(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.copy = os.path.join(self.tmp, "v1")
        shutil.copytree(EXAMPLES, self.copy)

    def test_check_green_on_examples(self):
        code, _ = run(["--check", EXAMPLES])
        self.assertEqual(code, 0)

    def test_check_red_after_one_byte(self):
        target = os.path.join(self.copy, "days", "2027-04-12.csv")
        with open(target, "rb") as handle:
            raw = handle.read()
        self.assertIn(b"openyardage", raw)
        raw = raw.replace(b"openyardage", b"openyardagf", 1)
        with open(target, "wb") as handle:
            handle.write(raw)
        code, _ = run(["--check", self.copy])
        self.assertEqual(code, 1)

    def test_entries(self):
        result = index.build_index(EXAMPLES, "2027-04-15")
        self.assertEqual(result["format"], 1)
        self.assertEqual(result["generated"], "2027-04-15")
        self.assertEqual(result["license"]["spdx"], "ODbL-1.0")
        paths = [entry["path"] for entry in result["files"]]
        self.assertEqual(paths, sorted(paths))
        csv_entry = [e for e in result["files"] if e["path"] == "days/2027-04-12.csv"][0]
        self.assertEqual(csv_entry["kind"], "day")
        self.assertEqual(csv_entry["date"], "2027-04-12")
        self.assertEqual(csv_entry["rows"], 7)
        self.assertEqual(len(csv_entry["sha256"]), 64)
        self.assertGreater(csv_entry["bytes"], 0)
        geo_entry = [e for e in result["files"] if e["path"] == "days/2027-04-12.geojson"][0]
        self.assertEqual(geo_entry["rows"], 7)

    def test_rows_csv_counts_quoted_newline_once(self):
        text = 'date,hole\n"1\n2",3\n'
        self.assertEqual(index._rows_csv(text.encode("utf-8")), 1)

    def test_year_geojson_reported_not_crashed(self):
        folder = os.path.join(self.copy, "years")
        os.makedirs(folder, exist_ok=True)
        document = {
            "type": "FeatureCollection", "format": 1, "as_of": "2027-04-14",
            "license": {"name": "Open Database License 1.0", "spdx": "ODbL-1.0",
                        "url": "https://opendatacommons.org/licenses/odbl/1-0/"},
            "attribution": "OpenPinsheet and its data partners", "notes": [], "features": [],
        }
        with open(os.path.join(folder, "2027-04-12.geojson"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps(document))
        code, out = run([self.copy])
        self.assertEqual(code, 1)
        self.assertIn("does not match its kind", out)

    def test_written_file_matches_build(self):
        code, _ = run([self.copy, "--generated", "2027-04-15"])
        self.assertEqual(code, 0)
        with open(os.path.join(self.copy, "index.json"), encoding="utf-8") as handle:
            written = json.load(handle)
        self.assertEqual(written, index.build_index(self.copy, "2027-04-15"))

    def test_generated_bad(self):
        with self.assertRaises(SystemExit):
            run([EXAMPLES, "--generated", "bogus"])

    def test_aborts_on_invalid_file(self):
        target = os.path.join(self.copy, "days", "2027-04-12.csv")
        with open(target, encoding="utf-8") as handle:
            text = handle.read()
        text = text.replace("right,m,openyardage", "right,ft,openyardage", 1)
        with open(target, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        code, out = run([self.copy])
        self.assertEqual(code, 1)
        self.assertNotIn("wrote", out)
