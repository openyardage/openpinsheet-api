"""Cross-check api/src/worker.js against the Python tools.

Package 2 of the API is the worker. This test runs api/test/emit_worker.mjs
with Node 24. The helper delivers two data partners for the same day through
the worker, runs scheduled three days later, and writes the fake bucket to a
temporary v1 directory. Then the test checks that

1. tools/validate.py finds no problem in any file (without club_export),
2. tools/index.py --check is green.

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
import validate  # noqa: E402
from node24 import NODE24, REQUIRED  # noqa: E402

DATE = "2027-04-12"
YEAR = "2027"


@unittest.skipUnless(NODE24 or REQUIRED, "Node 24 not available")
class ApiWorkerCrossCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.v1 = os.path.join(self.tmp, "v1")

    def run_emit(self):
        emit = os.path.join(ROOT, "api", "test", "emit_worker.mjs")
        self.assertIsNotNone(NODE24, "Node 24 is required in CI")
        command = NODE24 + [emit, self.v1]
        return subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)

    def emitted_files(self):
        found = []
        for base, _, names in os.walk(self.v1):
            for name in sorted(names):
                if name.endswith(".csv") or name.endswith(".geojson"):
                    found.append(os.path.join(base, name))
        return sorted(found)

    def test_worker_files_validate_and_index(self):
        result = self.run_emit()
        self.assertEqual(result.returncode, 0, result.stderr)

        files = self.emitted_files()
        self.assertEqual(sorted(os.path.relpath(path, self.v1) for path in files),
                         ["days/%s.csv" % DATE, "days/%s.geojson" % DATE,
                          "years/%s.csv" % YEAR])

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

        with open(os.path.join(self.v1, "index.json"), encoding="utf-8") as handle:
            written = json.load(handle)
        paths = [entry["path"] for entry in written["files"]]
        self.assertIn("days/%s.csv" % DATE, paths)
        self.assertIn("days/%s.geojson" % DATE, paths)
        self.assertIn("years/%s.csv" % YEAR, paths)

        # 3. play_bearing_deg and correction went through D1 into the files.
        with open(os.path.join(self.v1, "days", DATE + ".geojson"), encoding="utf-8") as handle:
            features = json.load(handle)["features"]
        by_hole = {(feature["properties"].get("channel"), feature["properties"]["hole"]):
                   feature["properties"] for feature in features}
        self.assertEqual(by_hole[("openyardage", "2")]["play_bearing_deg"], 274.5)
        self.assertEqual(by_hole[("openyardage", "10")]["correction"], "rtk")


if __name__ == "__main__":
    unittest.main()
