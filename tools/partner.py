#!/usr/bin/env python3
"""Issue, rotate and revoke data partner keys for the OpenPinsheet API.

Standard library only, Python 3.10+.

API.md 3: a key belongs to one data partner (a `channel`, FORMAT.md 5), only
its sha256 is stored, and at most two valid keys exist per partner so a key can
be swapped without a gap. This tool builds the SQL for D1 and touches D1
itself never. The maintainer runs the line it prints:

    wrangler d1 execute openpinsheet --remote --file <the file written here>

The plaintext key appears exactly once, on stdout. The SQL file carries only
the sha256 digest (and, for revoke, the digest prefix), never the key, and is
written with mode 0600.

The two-active-key rule (API.md 3) is put INTO the SQL of `rotate`, not into
this tool: a `rotate` only inserts while the partner carries fewer than two
active keys. That way the limit holds even when this tool runs against stale
knowledge of the database.

The revoke SQL updates at most one row. A prefix shorter than the full digest
can match several keys; the statement then updates nothing rather than all of
them, because its `count(*)` guard has to be exactly one.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import os
import re
import secrets
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)
import validate as _validate  # noqa: E402

# The channel rule is taken from tools/validate.py, the source the API worker
# and the publishing tools are checked against; a second copy here could drift.
CHANNEL_RE = _validate.CHANNEL_RE
# 'club' is the club export channel (FORMAT.md 5), never a data partner.
RESERVED = "club"

KEY_PREFIX = "ops_"
PREFIX_MIN = 8
PREFIX_RE = re.compile(r"^[0-9a-fA-F]{%d,64}$" % PREFIX_MIN)
WRANGLER = "wrangler d1 execute openpinsheet --remote --file %s"


def today_utc():
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def new_key():
    """A fresh plaintext key, API.md 3: 'ops_' plus 32 random bytes, base64url."""
    return KEY_PREFIX + secrets.token_urlsafe(32)


def key_sha256(key):
    """The sha256 hex digest the worker stores and matches (worker.js)."""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _q(value):
    """A SQL string literal; single quotes are doubled."""
    return "'" + value.replace("'", "''") + "'"


def sql_add(channel, name, created, sha):
    """Create the partner and its first key in one file."""
    return (
        "INSERT INTO channels (id, name, created) VALUES (%s, %s, %s);\n"
        "INSERT INTO keys (key_sha256, channel, active, created) VALUES (%s, %s, 1, %s);\n"
        % (_q(channel), _q(name), _q(created),
           _q(sha), _q(channel), _q(created))
    )


def sql_rotate(channel, created, sha):
    """Add a key only while the partner carries fewer than two active keys."""
    return (
        "INSERT INTO keys (key_sha256, channel, active, created)\n"
        "SELECT %s, %s, 1, %s\n"
        "WHERE (SELECT count(*) FROM keys WHERE channel = %s AND active = 1) < 2;\n"
        % (_q(sha), _q(channel), _q(created), _q(channel))
    )


def sql_revoke(channel, prefix):
    """Deactivate exactly the one active key of this partner with this prefix.

    The inner `count(*) = 1` is the guard: two keys sharing the prefix leave it
    at 0 and no row is touched.
    """
    length = len(prefix)
    return (
        "UPDATE keys SET active = 0\n"
        "WHERE channel = %s AND active = 1\n"
        "  AND substr(key_sha256, 1, %d) = %s\n"
        "  AND (SELECT count(*) FROM keys WHERE channel = %s AND active = 1\n"
        "       AND substr(key_sha256, 1, %d) = %s) = 1;\n"
        % (_q(channel), length, _q(prefix), _q(channel), length, _q(prefix))
    )


def sql_remove(channel, with_pins):
    """Delete the partner and its keys; pins and days only with --with-pins.

    A published day does not depend on the partner, so without the switch only
    the keys and the channel go; its pins and days stay (API.md 4).
    """
    statements = ["DELETE FROM keys WHERE channel = %s;" % _q(channel)]
    if with_pins:
        statements.append("DELETE FROM pins WHERE channel = %s;" % _q(channel))
        statements.append("DELETE FROM days WHERE channel = %s;" % _q(channel))
    statements.append("DELETE FROM channels WHERE id = %s;" % _q(channel))
    return "\n".join(statements) + "\n"


def write_sql(path, text):
    """Write the SQL with mode 0600, so only the maintainer can read it.

    os.open applies the umask, so the mode is set again afterwards; the file
    never carries a plaintext key, but it does carry digests and is kept closed
    anyway.
    """
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(handle, text.encode("utf-8"))
    finally:
        os.close(handle)
    os.chmod(path, 0o600)


def _checked_channel(parser, channel):
    if CHANNEL_RE.fullmatch(channel) is None or channel == RESERVED:
        parser.error("channel must match the rule of FORMAT.md 5 and must not be 'club'")
    return channel


def _checked_prefix(parser, prefix):
    if PREFIX_RE.fullmatch(prefix) is None:
        parser.error("prefix must be at least %d hex digits of the sha256" % PREFIX_MIN)
    return prefix.lower()


def build_parser():
    parser = argparse.ArgumentParser(
        description="Build the D1 SQL that issues, rotates and revokes data partner keys (API.md 3)")
    commands = parser.add_subparsers(dest="command", required=True)

    add = commands.add_parser("add", help="create a partner and its first key")
    add.add_argument("id")
    add.add_argument("name")

    rotate = commands.add_parser("rotate", help="add a key, if fewer than two are active")
    rotate.add_argument("id")

    revoke = commands.add_parser("revoke", help="deactivate one key by sha256 prefix")
    revoke.add_argument("id")
    revoke.add_argument("prefix")

    remove = commands.add_parser("remove", help="delete the partner and its keys")
    remove.add_argument("id")
    remove.add_argument("--with-pins", action="store_true",
                        help="also delete its pins and days; a published day stays otherwise")

    for command in (add, rotate, revoke, remove):
        command.add_argument("--sql-out", required=True,
                             help="the file to write the SQL into (mode 0600)")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    channel = _checked_channel(parser, args.id)
    created = today_utc()
    plaintext = None

    if args.command == "add":
        plaintext = new_key()
        text = sql_add(channel, args.name, created, key_sha256(plaintext))
    elif args.command == "rotate":
        plaintext = new_key()
        text = sql_rotate(channel, created, key_sha256(plaintext))
    elif args.command == "revoke":
        prefix = _checked_prefix(parser, args.prefix)
        text = sql_revoke(channel, prefix)
    else:
        text = sql_remove(channel, args.with_pins)

    write_sql(args.sql_out, text)

    if plaintext is not None:
        print("Key (shown once, it cannot be shown again):")
        print(plaintext)
    print("SQL written to %s" % args.sql_out)
    print("Run:")
    print(WRANGLER % args.sql_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
