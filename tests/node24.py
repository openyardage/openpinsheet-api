"""Node 24 for the cross-checks with the worker; its tests use node:sqlite.

Node 24 comes from PATH, or else through mise. In CI, setup-node puts it on
PATH.

In CI (GitHub Actions sets CI=true) a missing Node 24 fails the test instead
of skipping it. Otherwise a broken setup would switch the cross-checks off
and the run would still be green.
"""
import os
import shutil
import subprocess


def _major(node):
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout
        return int(out.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0


def _command():
    node = shutil.which("node")
    if node and _major(node) >= 24:
        return [node]
    mise = shutil.which("mise")
    if mise:
        return [mise, "exec", "node@24", "--", "node"]
    return None


NODE24 = _command()
REQUIRED = os.environ.get("CI") == "true"
