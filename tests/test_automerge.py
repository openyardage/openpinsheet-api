"""Tests for tools/automerge.py.

No network: gh is replaced by a stand-in that gives fixed answers and records
every call. What counts most is whether `gh pr merge` was called in the end;
a refusal that merges anyway would be the worst bug this tool can have.
"""
import base64
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import automerge as A  # noqa: E402


def ruleset(*required, source=A.GITHUB_ACTIONS):
    checks = [{"context": c} if source is None else {"context": c, "integration_id": source}
              for c in required]
    return [{"type": "pull_request"},
            {"type": "required_status_checks",
             "parameters": {"required_status_checks": checks}}]


WITH_REQUIRED = ruleset("tests", "Sensitive paths")


LIST_HERE = open(os.path.join(ROOT, "tools", "sensitive_paths.py"), "rb").read()


class StandIn:
    def __init__(self, rules=WITH_REQUIRED, state="OPEN", draft=False,
                 files=("api/src/worker.js",), base="main", list_on_main=LIST_HERE):
        self.answers = {
            "rules": json.dumps(rules),
            "list": base64.b64encode(list_on_main).decode() + "\n",
            "view": json.dumps({"state": state, "isDraft": draft,
                                "baseRefName": base}),
            "files": "\n".join(files),
        }
        self.calls = []

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ("repo", "view"):
            return "openyardage/openpinsheet\n"
        if args[0] == "api" and "rules/branches/main" in args[1]:
            return self.answers["rules"]
        if args[0] == "api" and "contents/tools/sensitive_paths.py?ref=main" in args[1]:
            return self.answers["list"]
        if args[:2] == ("pr", "view"):
            return self.answers["view"]
        if args[0] == "api" and "/files" in " ".join(args):
            return self.answers["files"]
        if args[:2] == ("pr", "merge"):
            return ""
        raise AssertionError("unexpected call %r" % (args,))

    def merged(self):
        return [a for a in self.calls if a[:2] == ("pr", "merge")]


class Automerge(unittest.TestCase):
    def run_with(self, stand_in, argv=("40",)):
        old = A.gh
        A.gh = stand_in
        try:
            with redirect_stdout(io.StringIO()) as out:
                rc = A.main(list(argv))
        finally:
            A.gh = old
        return rc, out.getvalue()

    def test_harmless_pull_request_is_turned_on(self):
        s = StandIn()
        rc, _ = self.run_with(s)
        self.assertEqual(rc, 0)
        self.assertEqual(s.merged(), [("pr", "merge", "40", "--auto", "--merge")])

    def test_without_required_check_no_merge(self):
        s = StandIn(rules=[{"type": "pull_request"}])
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn("Sensitive paths", out)
        self.assertEqual(s.merged(), [])

    def test_other_required_checks_only_no_merge(self):
        s = StandIn(rules=ruleset("tests"))
        rc, _ = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertEqual(s.merged(), [])

    def test_without_tests_no_merge(self):
        """Only the sensitive check required: auto-merge would skip the tests."""
        s = StandIn(rules=ruleset("Sensitive paths"))
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn('"tests"', out)
        self.assertEqual(s.merged(), [])

    def test_checks_without_source_no_merge(self):
        """Any app could report a check of that name; a pull request could add
        a workflow with a job called "Sensitive paths"."""
        s = StandIn(rules=ruleset("tests", "Sensitive paths", source=None))
        rc, _ = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertEqual(s.merged(), [])

    def test_checks_from_another_app_no_merge(self):
        s = StandIn(rules=ruleset("tests", "Sensitive paths", source=1))
        rc, _ = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertEqual(s.merged(), [])

    def test_base_other_than_main_no_merge(self):
        s = StandIn(base="claude/something")
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn("claude/something", out)
        self.assertEqual(s.merged(), [])

    def test_space_in_name_does_not_split(self):
        """With split(), "schema/a b.json" would have become "schema/a" and
        "b.json"; still sensitive, but for the wrong reason."""
        s = StandIn(files=("tools/a b.py", "schema/c d.json"))
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn("schema/c d.json", out)
        self.assertEqual(s.merged(), [])

    def test_draft_no_merge(self):
        s = StandIn(draft=True)
        rc, _ = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertEqual(s.merged(), [])

    def test_closed_no_merge(self):
        s = StandIn(state="CLOSED")
        rc, _ = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertEqual(s.merged(), [])

    def test_sensitive_path_among_others_no_merge(self):
        s = StandIn(files=("api/src/worker.js", "api/migrations/0006_x.sql"))
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn("api/migrations/0006_x.sql", out)
        self.assertEqual(s.merged(), [])

    def test_list_differing_from_main_no_merge(self):
        """A working tree with a shortened list must not decide."""
        s = StandIn(list_on_main=LIST_HERE + b"# longer on main\n",
                    files=("FORMAT.md",))
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn("differs from main", out)
        self.assertEqual(s.merged(), [])

    def test_sensitive_path_is_refused_without_exception(self):
        """Nothing lets a sensitive pull request through."""
        s = StandIn(files=("FORMAT.md",))
        rc, out = self.run_with(s)
        self.assertEqual(rc, 2)
        self.assertIn("by hand", out)
        self.assertEqual(s.merged(), [])

    def test_bad_argument_calls_nothing(self):
        s = StandIn()
        rc, _ = self.run_with(s, argv=("abc",))
        self.assertEqual(rc, 2)
        self.assertEqual(s.calls, [])


if __name__ == "__main__":
    unittest.main()
