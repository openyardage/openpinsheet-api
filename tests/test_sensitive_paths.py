"""Tests for tools/sensitive_paths.py.

The plain match function, and the whole call through subprocess as the
workflow runs it: a file with one path per line and whether auto-merge is on for the pull
request.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import sensitive_paths as S  # noqa: E402

TOOL = Path(S.__file__)
WORKFLOW = Path(ROOT, ".github", "workflows", "approval.yml")


class Matches(unittest.TestCase):

    def test_directory_matches_path_below(self):
        self.assertEqual(S.sensitive(["api/migrations/0006_x.sql"]),
                         [("api/migrations/0006_x.sql", "changes the live database")])

    def test_directory_does_not_match_similar_name(self):
        self.assertEqual(S.sensitive(["api/migrationsX/a.sql"]), [])

    def test_directory_does_not_match_elsewhere(self):
        self.assertEqual(S.sensitive(["tests/schema/a.json"]), [])

    def test_exact_file_matches(self):
        self.assertEqual(S.sensitive(["REUSE.toml"]), [("REUSE.toml", "licences")])

    def test_exact_file_does_not_match_suffix(self):
        self.assertEqual(S.sensitive(["FORMAT.md.bak"]), [])

    def test_leading_dot_slash_is_normalised(self):
        self.assertEqual(S.sensitive(["./FORMAT.md"]),
                         [("FORMAT.md", "the published format, readers build against it")])

    def test_duplicates_appear_once(self):
        self.assertEqual(S.sensitive([".github/a.yml", ".github/a.yml"]),
                         S.sensitive([".github/a.yml"]))

    def test_empty_list_is_empty(self):
        self.assertEqual(S.sensitive([]), [])

    def test_every_entry_matches_once(self):
        """Counter-check: the list is not silently broken or renamed."""
        probes = [p + "x.py" if p.endswith("/") else p for p, _ in S.SENSITIVE]
        for probe, (pattern, reason) in zip(probes, S.SENSITIVE):
            self.assertEqual(S.sensitive([probe]), [(probe, reason)],
                             "pattern %r misses its probe" % pattern)

    def test_list_is_pinned(self):
        """Dropping an entry must show up here, in a diff a human reads."""
        self.assertEqual([p for p, _ in S.SENSITIVE], [
            "FORMAT.md", "schema/", "api/openapi.json",
            "api/migrations/", "api/schema.sql",
            "api/wrangler.toml", "api/wrangler.json", "api/wrangler.jsonc",
            "LICENSE", "LICENSES/", "REUSE.toml", ".github/",
            "tools/sensitive_paths.py", "tools/automerge.py",
        ])

    def test_every_entry_exists_or_is_another_wrangler_format(self):
        """A renamed file would leave its entry guarding nothing."""
        not_yet = {"api/wrangler.json", "api/wrangler.jsonc"}
        for pattern, _ in S.SENSITIVE:
            if pattern not in not_yet:
                self.assertTrue(os.path.exists(os.path.join(ROOT, pattern)),
                                "%s is listed but missing" % pattern)

    def test_workflow_names_the_job_the_tool_requires(self):
        import automerge
        self.assertIn("    name: %s\n" % automerge.REQUIRED, WORKFLOW.read_text("utf-8"))


class Workflow(unittest.TestCase):
    """The lines that make approval.yml a gate. Each one, changed, would let a
    pull request check itself or slip past."""

    text = WORKFLOW.read_text("utf-8")

    def test_runs_from_main_on_pull_request_target(self):
        self.assertIn("\n  pull_request_target:\n", self.text)
        self.assertNotIn("\n  pull_request:\n", self.text)
        self.assertIn("    branches: [main]\n", self.text)
        self.assertIn("ref: ${{ github.sha }}\n", self.text)
        self.assertIn("persist-credentials: false", self.text)

    def test_reruns_when_auto_merge_switches(self):
        self.assertIn("types: [opened, synchronize, reopened, auto_merge_enabled, "
                      "auto_merge_disabled]", self.text)

    def test_renames_count_the_old_name(self):
        self.assertIn(".filename, (.previous_filename // empty)", self.text)

    def test_passes_the_auto_merge_state(self):
        self.assertIn("AUTO_MERGE: ${{ github.event.pull_request.auto_merge != null }}",
                      self.text)
        self.assertIn('--auto-merge "$AUTO_MERGE"', self.text)

    def test_cannot_write(self):
        """Nothing in this workflow needs to change the pull request."""
        self.assertIn("  pull-requests: read\n", self.text)
        self.assertNotIn("write", self.text.split("jobs:")[0].split("permissions:")[1])

    def test_runs_the_tool_from_the_checkout(self):
        self.assertIn("run: python3 tools/sensitive_paths.py --files", self.text)


class Call(unittest.TestCase):
    """The whole call with a list in a throwaway directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.list = Path(self.tmp.name) / "files.txt"

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, paths, auto_merge="true"):
        self.list.write_text("\n".join(paths) + "\n", "utf-8")
        return subprocess.run(
            [sys.executable, str(TOOL), "--files", str(self.list),
             "--auto-merge", auto_merge],
            capture_output=True, text=True)

    def test_hit_with_auto_merge_exits_1_with_error(self):
        r = self.call(["api/wrangler.toml"])
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn("api/wrangler.toml: worker bindings and routes", r.stdout)
        self.assertIn("::error title=Sensitive paths::1 file(s) need a merge by hand. "
                      "Turn auto-merge off; the maintainer merges.", r.stdout)

    def test_hit_without_auto_merge_exits_0_with_notice(self):
        r = self.call(["FORMAT.md"], "false")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("::notice title=Sensitive paths::1 file(s) need a merge by hand; "
                      "auto-merge stays off.", r.stdout)

    def test_auto_merge_value_must_be_known(self):
        r = self.call(["FORMAT.md"], "yes")
        self.assertEqual(r.returncode, 2, r.stdout)

    def test_too_many_paths_are_sensitive(self):
        r = self.call(["examples/x%d.csv" % i for i in range(S.API_LIMIT)])
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn(S.TOO_MANY, r.stdout)

    def test_just_below_the_limit_is_harmless(self):
        r = self.call(["examples/x%d.csv" % i for i in range(S.API_LIMIT - 1)])
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_space_in_name_stays(self):
        """A space at the edge belongs to the name: "FORMAT.md " is another
        file than FORMAT.md and not sensitive."""
        r = self.call(["FORMAT.md "])
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_no_hit_exits_0(self):
        r = self.call(["api/src/worker.js"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("No sensitive paths.", r.stdout)


if __name__ == "__main__":
    unittest.main()
