#!/usr/bin/env python3
"""May this pull request merge on its own?

A pull request may merge automatically once every required check is green.
Excepted are files where a mistake is expensive and the tests do not look:
the published format, the live database, the worker configuration, the
licences and the workflows. The maintainer merges those by hand.

    python3 tools/sensitive_paths.py --files FILE --auto-merge true|false

    exit 0   nothing sensitive, or auto-merge is off (merge by hand)
    exit 1   at least one sensitive path while auto-merge is on

What this guards against: auto-merge in places the tests do not see. It does
NOT hold against anyone with write access who merges directly.
"""
from __future__ import annotations

import argparse
import sys

# (pattern, reason). A pattern ending in "/" is a directory and matches every
# path below it; any other pattern matches exactly that path. No wildcards and
# no regular expressions, so a pattern never reaches further than it reads.
SENSITIVE = (
    ("FORMAT.md", "the published format, readers build against it"),
    ("schema/", "the published format, readers build against it"),
    ("api/openapi.json", "the API contract, partners build against it"),
    ("api/migrations/", "changes the live database"),
    ("api/schema.sql", "the live database"),
    ("api/wrangler.toml", "worker bindings and routes"),
    ("api/wrangler.json", "worker bindings and routes"),
    ("api/wrangler.jsonc", "worker bindings and routes"),
    ("LICENSE", "licences"),
    ("LICENSES/", "licences"),
    ("REUSE.toml", "licences"),
    (".github/", "workflows"),
    ("tools/sensitive_paths.py", "this check itself"),
    ("tools/automerge.py", "the automatic merge path"),
)

# The REST list pulls/{n}/files returns at most 3,000 files. A pull request
# that changes more would be checked only in part, so it counts as sensitive.
# Lines are counted, so a rename counts both names: this fires early rather
# than late.
API_LIMIT = 3000
TOO_MANY = "(at least %d paths)" % API_LIMIT


def _normalise(path):
    """Strip a leading "./".

    The API returns paths without it, a hand-written list may carry it;
    without this ./FORMAT.md would pass as harmless.
    """
    while path.startswith("./"):
        path = path[2:]
    return path


def _matches(pattern, path):
    if pattern.endswith("/"):
        return path.startswith(pattern)
    return path == pattern


def sensitive(paths):
    """(path, reason) per matched path, in input order, without duplicates."""
    paths = list(paths)
    hits = []
    seen = set()
    for raw in paths:
        path = _normalise(raw)
        if path in seen:
            continue
        for pattern, reason in SENSITIVE:
            if _matches(pattern, path):
                hits.append((path, reason))
                seen.add(path)
                break
    if len(paths) >= API_LIMIT:
        hits.append((TOO_MANY, "more than the API returns, the rest would go unchecked"))
    return hits


def _read_list(name):
    # Strip only the line break: a space at the edge belongs to the file name.
    with open(name, encoding="utf-8") as f:
        return [line.rstrip("\r\n") for line in f if line.rstrip("\r\n")]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--files", required=True,
                    help="file with one path per line, empty lines do not count")
    ap.add_argument("--auto-merge", required=True, choices=("true", "false"),
                    help="whether auto-merge is on for the pull request")
    a = ap.parse_args(argv)

    hits = sensitive(_read_list(a.files))

    if not hits:
        print("No sensitive paths.")
        return 0

    for path, reason in hits:
        print("%s: %s" % (path, reason))

    if a.auto_merge == "false":
        print("::notice title=Sensitive paths::%d file(s) need a merge by hand; "
              "auto-merge stays off." % len(hits))
        return 0

    print("::error title=Sensitive paths::%d file(s) need a merge by hand. "
          "Turn auto-merge off; the maintainer merges." % len(hits))
    return 1


if __name__ == "__main__":
    sys.exit(main())
