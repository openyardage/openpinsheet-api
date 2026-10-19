"""Tests for tools/partner.py.

The four commands build SQL; nothing here touches D1. Every statement is run
against a Python sqlite3 database built from api/schema.sql, which is the same
schema D1 gets, and the effect on channels, keys, pins and days is checked.
The plaintext key must never reach the SQL file, and that file must carry mode
0600.

The API worker (api/src/worker.js) matches a key by sha256 hex, so the tests
recompute the digest from the plaintext line the tool prints.
"""
import contextlib
import hashlib
import io
import os
import re
import sqlite3
import stat
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import partner  # noqa: E402

SCHEMA = os.path.join(ROOT, "api", "schema.sql")
KEY_RE = re.compile(r"ops_[A-Za-z0-9_-]+")


def run(args):
    """Run the CLI and return (exit code, stdout)."""
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = partner.main(args)
    return code, out.getvalue()


def plaintext_from(stdout):
    """The one key printed on stdout, or None."""
    keys = KEY_RE.findall(stdout)
    if not keys:
        return None
    assert len(keys) == 1, "expected exactly one key, found %d" % len(keys)
    return keys[0]


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


class PartnerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(self._cleanup)
        self.conn = sqlite3.connect(":memory:")
        self.addCleanup(self.conn.close)
        with open(SCHEMA, encoding="utf-8") as handle:
            self.conn.executescript(handle.read())
        self.conn.commit()

    def _cleanup(self):
        for name in os.listdir(self.tmp):
            os.unlink(os.path.join(self.tmp, name))
        os.rmdir(self.tmp)

    def sql_path(self, name="out.sql"):
        return os.path.join(self.tmp, name)

    def apply(self, path):
        self.conn.executescript(read(path))
        self.conn.commit()

    def count(self, sql, params=()):
        return self.conn.execute(sql, params).fetchone()[0]

    def active_keys(self, channel):
        return self.count(
            "SELECT count(*) FROM keys WHERE channel = ? AND active = 1", (channel,))

    def all_keys(self, channel):
        return self.count("SELECT count(*) FROM keys WHERE channel = ?", (channel,))


class TestAdd(PartnerCase):
    def test_add_creates_channel_and_first_key(self):
        path = self.sql_path()
        code, out = run(["add", "w620181682", "Example Golf", "--sql-out", path])
        self.assertEqual(code, 0)
        key = plaintext_from(out)
        self.assertIsNotNone(key)
        self.assertTrue(key.startswith("ops_"))

        self.apply(path)
        row = self.conn.execute(
            "SELECT id, name, created FROM channels WHERE id = ?",
            ("w620181682",)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row[1], "Example Golf")
        self.assertEqual(row[2], partner.today_utc())
        self.assertEqual(self.active_keys("w620181682"), 1)
        stored = self.conn.execute(
            "SELECT key_sha256 FROM keys WHERE channel = ?",
            ("w620181682",)).fetchone()[0]
        self.assertEqual(stored, hashlib.sha256(key.encode("utf-8")).hexdigest())

    def test_plaintext_key_is_not_in_the_sql_file(self):
        path = self.sql_path()
        _code, out = run(["add", "w620181682", "Example Golf", "--sql-out", path])
        key = plaintext_from(out)
        text = read(path)
        self.assertNotIn(key, text)
        self.assertIn(hashlib.sha256(key.encode("utf-8")).hexdigest(), text)

    def test_sql_file_mode_is_0600(self):
        path = self.sql_path()
        run(["add", "w620181682", "Example Golf", "--sql-out", path])
        mode = stat.S_IMODE(os.stat(path).st_mode)
        self.assertEqual(mode, 0o600, oct(mode))


class TestRotate(PartnerCase):
    def test_rotate_stops_at_two_active_keys(self):
        first = self.sql_path("add.sql")
        _code, out = run(["add", "w620181682", "Example Golf", "--sql-out", first])
        self.assertIsNotNone(plaintext_from(out))
        self.apply(first)
        self.assertEqual(self.active_keys("w620181682"), 1)

        second = self.sql_path("rotate1.sql")
        code, out = run(["rotate", "w620181682", "--sql-out", second])
        self.assertEqual(code, 0)
        self.assertIsNotNone(plaintext_from(out))
        self.assertIn("< 2", read(second))
        self.apply(second)
        self.assertEqual(self.active_keys("w620181682"), 2)

        # The third insertion has to do nothing: the condition sits in the SQL.
        third = self.sql_path("rotate2.sql")
        code, out = run(["rotate", "w620181682", "--sql-out", third])
        self.assertEqual(code, 0)
        self.assertIsNotNone(plaintext_from(out))
        self.apply(third)
        self.assertEqual(self.active_keys("w620181682"), 2)
        self.assertEqual(self.all_keys("w620181682"), 2)

    def test_plaintext_key_is_not_in_the_sql_file(self):
        first = self.sql_path("add.sql")
        run(["add", "w620181682", "Example Golf", "--sql-out", first])
        path = self.sql_path("rotate.sql")
        _code, out = run(["rotate", "w620181682", "--sql-out", path])
        key = plaintext_from(out)
        self.assertNotIn(key, read(path))


class TestRevoke(PartnerCase):
    def test_revoke_hits_exactly_one_key(self):
        first = self.sql_path("add.sql")
        _code, out = run(["add", "w620181682", "Example Golf", "--sql-out", first])
        key_a = plaintext_from(out)
        self.apply(first)
        second = self.sql_path("rotate.sql")
        _code, out = run(["rotate", "w620181682", "--sql-out", second])
        key_b = plaintext_from(out)
        self.apply(second)
        self.assertEqual(self.active_keys("w620181682"), 2)

        sha_a = hashlib.sha256(key_a.encode("utf-8")).hexdigest()
        revoke = self.sql_path("revoke.sql")
        code, _ = run(["revoke", "w620181682", sha_a[:8], "--sql-out", revoke])
        self.assertEqual(code, 0)
        self.apply(revoke)

        self.assertEqual(self.active_keys("w620181682"), 1)
        still = self.conn.execute(
            "SELECT key_sha256 FROM keys WHERE channel = ? AND active = 1",
            ("w620181682",)).fetchone()[0]
        self.assertEqual(still, hashlib.sha256(key_b.encode("utf-8")).hexdigest())

    def test_ambiguous_prefix_touches_nothing(self):
        # Two keys whose digests share the first eight characters.
        self.conn.execute(
            "INSERT INTO channels (id, name, created) VALUES ('w620181682', 'G', '2026-10-17')")
        shared = "aaaaaaaa"
        for tail in ("1" * 56, "2" * 56):
            digest = shared + tail
            self.conn.execute(
                "INSERT INTO keys (key_sha256, channel, active, created) "
                "VALUES (?, 'w620181682', 1, '2026-10-17')", (digest,))
        self.conn.commit()

        path = self.sql_path()
        run(["revoke", "w620181682", shared, "--sql-out", path])
        self.apply(path)
        self.assertEqual(self.active_keys("w620181682"), 2)

    def test_unknown_prefix_touches_nothing(self):
        first = self.sql_path("add.sql")
        _code, out = run(["add", "w620181682", "Example Golf", "--sql-out", first])
        key = plaintext_from(out)
        self.apply(first)
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        other = "f" * 8 if not digest.startswith("f" * 8) else "0" * 8

        path = self.sql_path("revoke.sql")
        run(["revoke", "w620181682", other, "--sql-out", path])
        self.apply(path)
        self.assertEqual(self.active_keys("w620181682"), 1)

    def test_prefix_shorter_than_eight_is_rejected(self):
        path = self.sql_path()
        with self.assertRaises(SystemExit):
            run(["revoke", "w620181682", "abcd", "--sql-out", path])
        self.assertFalse(os.path.exists(path))


class TestRemove(PartnerCase):
    def _seed(self, channel):
        self.conn.execute(
            "INSERT INTO channels (id, name, created) VALUES (?, 'G', '2026-10-17')",
            (channel,))
        self.conn.execute(
            "INSERT INTO keys (key_sha256, channel, active, created) "
            "VALUES (?, ?, 1, '2026-10-17')", ("0" * 64, channel))
        self.conn.execute(
            "INSERT INTO pins (channel, grp, date, hole) VALUES (?, 'g', '2026-10-01', '1')",
            (channel,))
        self.conn.execute(
            "INSERT INTO days (channel, grp, date, visible_from) "
            "VALUES (?, 'g', '2026-10-01', '2026-10-01T06:00:00Z')", (channel,))
        self.conn.commit()

    def test_remove_without_pins_keeps_pins_and_days(self):
        self._seed("w620181682")
        path = self.sql_path()
        code, _ = run(["remove", "w620181682", "--sql-out", path])
        self.assertEqual(code, 0)
        self.apply(path)
        self.assertEqual(self.count(
            "SELECT count(*) FROM channels WHERE id = 'w620181682'"), 0)
        self.assertEqual(self.all_keys("w620181682"), 0)
        self.assertEqual(self.count(
            "SELECT count(*) FROM pins WHERE channel = 'w620181682'"), 1)
        self.assertEqual(self.count(
            "SELECT count(*) FROM days WHERE channel = 'w620181682'"), 1)

    def test_remove_with_pins_deletes_pins_and_days(self):
        self._seed("w620181682")
        path = self.sql_path()
        code, _ = run(["remove", "w620181682", "--with-pins", "--sql-out", path])
        self.assertEqual(code, 0)
        self.apply(path)
        self.assertEqual(self.count(
            "SELECT count(*) FROM channels WHERE id = 'w620181682'"), 0)
        self.assertEqual(self.count(
            "SELECT count(*) FROM pins WHERE channel = 'w620181682'"), 0)
        self.assertEqual(self.count(
            "SELECT count(*) FROM days WHERE channel = 'w620181682'"), 0)


class TestInvalidChannel(PartnerCase):
    def test_invalid_ids_are_rejected(self):
        for bad in ("club", "Club", "1abc", "ab--cd", "-abcd", "a", ""):
            with self.assertRaises(SystemExit, msg=bad):
                run(["add", bad, "Name", "--sql-out", self.sql_path()])

    def test_reserved_id_only_for_add_is_rejected(self):
        for command in (["rotate", "club"], ["remove", "club"], ["revoke", "club", "a" * 8]):
            with self.assertRaises(SystemExit):
                run(command + ["--sql-out", self.sql_path()])


if __name__ == "__main__":
    unittest.main()
