#!/usr/bin/env python3
"""Turn on auto-merge for a pull request that may merge without a human.

    python3 tools/automerge.py <PR number>

The one way to have a pull request merged automatically. A direct `gh pr merge` does
not wait for the required checks. This tool only turns on GitHub's
auto-merge: the merge happens once every required check is green, and
nowhere else.

First it checks three things and stops without turning anything on:

1. The ruleset on main requires the checks "tests" and "Sensitive paths",
   both from GitHub Actions. Without the one, auto-merge would merge untested
   code; without the other, it would wait for nothing on a sensitive pull
   request. Pinned to GitHub Actions, because a pull request could add a
   workflow of its own with a job of the same name.
2. The pull request is open, not a draft, and targets main. The ruleset
   applies only there.
3. It touches no sensitive path, or it carries `human-ok`. This is a
   shortcut, not the gate: the list comes from the working tree, perhaps
   from the pull request itself. The gate is the check on the pull request,
   which takes list and workflow from main (.github/workflows/approval.yml).
   It sits here so the caller hears the answer at once and not from a red
   check later.

Exit 0: turned on. 2: refused, with the reason. Anything else: gh failed.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sensitive_paths  # noqa: E402

# The job in .github/workflows/approval.yml, as the ruleset lists it.
REQUIRED = "Sensitive paths"
# The job in .github/workflows/tests.yml; it has no name, so the id counts.
TESTS = "tests"
# App id of GitHub Actions, the value the ruleset stores as integration_id
# when "GitHub Actions" is chosen as the source of a check.
GITHUB_ACTIONS = 15368


def gh(*args):
    run = subprocess.run(["gh", *args], capture_output=True, text=True)
    if run.returncode != 0:
        sys.stderr.write(run.stderr)
        raise SystemExit(run.returncode or 1)
    return run.stdout


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1 or not argv[0].isdigit():
        print(__doc__)
        return 2
    number = argv[0]
    repo = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner").strip()

    rules = json.loads(gh("api", "repos/%s/rules/branches/main" % repo))
    required = {c.get("context") for r in rules if r.get("type") == "required_status_checks"
                for c in (r.get("parameters") or {}).get("required_status_checks", [])
                if c.get("integration_id") == GITHUB_ACTIONS}
    missing = [c for c in (TESTS, REQUIRED) if c not in required]
    if missing:
        print("Refused: the ruleset on main does not require %s with the source "
              "GitHub Actions. Auto-merge would not wait for it."
              % " and ".join("\"%s\"" % c for c in missing))
        return 2

    pr = json.loads(gh("pr", "view", number, "--json",
                       "state,isDraft,labels,baseRefName"))
    if pr["state"] != "OPEN" or pr["isDraft"] or pr["baseRefName"] != "main":
        print("Refused: pull request #%s is %s%s and targets %s; auto-merge only "
              "for open pull requests against main." % (
                  number, pr["state"].lower(), ", a draft" if pr["isDraft"] else "",
                  pr["baseRefName"]))
        return 2

    # A rename counts the old name too, as on the pull request. Lines and not
    # words: a file name may contain a space.
    files = gh("api", "--paginate", "repos/%s/pulls/%s/files" % (repo, number),
               "--jq", ".[] | .filename, (.previous_filename // empty)").splitlines()
    labels = {label["name"] for label in pr["labels"]}
    hits = sensitive_paths.sensitive(files)
    if hits and "human-ok" not in labels:
        print("Refused: pull request #%s touches sensitive paths, the operator "
              "decides (label human-ok):" % number)
        for path, reason in hits:
            print("  %s: %s" % (path, reason))
        return 2

    gh("pr", "merge", number, "--auto", "--merge")
    print("Auto-merge on for pull request #%s. GitHub merges once every required "
          "check is green." % number)
    return 0


if __name__ == "__main__":
    sys.exit(main())
