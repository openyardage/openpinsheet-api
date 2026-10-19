"""Tests for tools/publish.py against FORMAT.md 4.3."""
import contextlib
import csv
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from decimal import Decimal
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import index  # noqa: E402
import publish  # noqa: E402
import validate  # noqa: E402

COLUMNS = list(validate.COLUMNS)
TODAY = "2027-04-20"
GENERATED = "2027-04-20"


def export_text(rows, comments=("# Club: Secret Golf Club",), extra=()):
    lines = list(comments)
    lines.append(",".join(COLUMNS + [name for name, _ in extra]))
    for row in rows:
        fields = [str(row.get(name, "")) for name in COLUMNS]
        fields.extend(str(value) for _, value in extra)
        lines.append(",".join(fields))
    return "\n".join(lines) + "\n"


def write_export(folder, name, rows, comments=("# Club: Secret Golf Club",), extra=()):
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(export_text(rows, comments, extra))
    return path


def run(args):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = publish.main(args)
    return code, out.getvalue()


def read_csv_rows(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        text = handle.read()
    lines = [line for line in text.replace("\r\n", "\n").split("\n")
             if line and not line.startswith("# ")]
    reader = csv.reader(io.StringIO("\n".join(lines)))
    header = next(reader)
    return header, [dict(zip(header, fields)) for fields in reader]


def read_geojson(path):
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle, parse_float=Decimal)
    rows = []
    for feature in data["features"]:
        record = dict(feature["properties"])
        geometry = feature["geometry"]
        if geometry is None:
            record["lon"] = ""
            record["lat"] = ""
        else:
            record["lon"], record["lat"] = geometry["coordinates"]
        rows.append(record)
    return data, rows


def normalize(record, name):
    value = record.get(name, "")
    if name == "missing":
        return "1" if value in ("1", True, 1) else ""
    if name in validate.NUMBER_COLUMNS:
        return "" if value == "" else format(Decimal(str(value)), "f")
    return "" if value is None else str(value)


def tree_bytes(folder):
    result = {}
    for base, _, names in os.walk(folder):
        for name in names:
            path = os.path.join(base, name)
            with open(path, "rb") as handle:
                result[os.path.relpath(path, folder)] = handle.read()
    return result


def day(date, hole, **kwargs):
    row = {"date": date, "date_basis": "local", "hole": hole, "channel": "club"}
    row.update(kwargs)
    return row


ROW_2 = day("2027-04-10", "2", lat="0.0001234", lon="0.0002345", source="estimated",
            front_m="12", left_m="9.5", input_front="12", input_offset="5",
            input_side="right", input_unit="m")
ROW_3 = day("2027-04-10", "3", lat="0.0003456", lon="0.0004567", source="mapped")
ROW_10 = day("2027-04-10", "10", lat="0.0005678", lon="0.0006789", source="estimated",
             front_m="8", left_m="4.2", input_front="9", input_offset="7",
             input_side="left", input_unit="yd")
ROW_LOST = {"date": "2027-04-10", "date_basis": "local", "hole": "11", "missing": "1"}


class PublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.exports = os.path.join(self.tmp, "exports")
        os.makedirs(self.exports)
        self.out = os.path.join(self.tmp, "v1")

    def publish(self, files, today=TODAY, generated=GENERATED, channel="openyardage"):
        args = ["--channel", channel, "--out", self.out, "--today", today,
                "--generated", generated] + files
        return run(args)


class TestMergeAndFormat(PublishTest):
    def test_two_inputs_merge_into_sorted_day(self):
        a = write_export(self.exports, "a.csv", [ROW_10])
        b = write_export(self.exports, "b.csv", [ROW_2, ROW_3, ROW_LOST])
        code, _ = self.publish([a, b])
        self.assertEqual(code, 0)
        header, rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        self.assertEqual(header, COLUMNS)
        self.assertEqual([row["hole"] for row in rows], ["2", "3", "10", "11"])
        self.assertEqual(rows[3]["missing"], "1")

    def test_export_of_15_columns_is_published_with_17(self):
        # FORMAT.md 5: an export may end after missing, as the first producers
        # write it. The published file carries all 17 columns.
        lines = ["# Club: Secret Golf Club", ",".join(COLUMNS[:15])]
        for row in (ROW_2, ROW_3, ROW_LOST):
            lines.append(",".join(str(row.get(name, "")) for name in COLUMNS[:15]))
        path = os.path.join(self.exports, "short.csv")
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write("\n".join(lines) + "\n")
        code, out = self.publish([path])
        self.assertEqual(code, 0, out)
        header, rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        self.assertEqual(header, COLUMNS)
        self.assertEqual([(row["play_bearing_deg"], row["correction"]) for row in rows],
                         [("", "")] * 3)

    def test_bearing_and_correction_reach_csv_and_geojson(self):
        surveyed = day("2027-04-10", "4", lat="0.0004", lon="0.0005", source="surveyed",
                       accuracy_m="0.03", correction="ppk")
        estimated = dict(ROW_2, play_bearing_deg="274.5")
        a = write_export(self.exports, "a.csv", [estimated, ROW_3, surveyed])
        code, out = self.publish([a])
        self.assertEqual(code, 0, out)
        _, rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        self.assertEqual(rows[0]["play_bearing_deg"], "274.5")
        self.assertEqual(rows[2]["correction"], "ppk")
        _, features = read_geojson(os.path.join(self.out, "days", "2027-04-10.geojson"))
        self.assertEqual(features[0]["play_bearing_deg"], Decimal("274.5"))
        self.assertEqual(features[2]["correction"], "ppk")
        self.assertNotIn("play_bearing_deg", features[1])

    def test_input_comments_and_club_name_stay_out(self):
        a = write_export(self.exports, "a.csv", [ROW_2])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        for name in ("2027-04-10.csv", "2027-04-10.geojson"):
            with open(os.path.join(self.out, "days", name), encoding="utf-8") as handle:
                text = handle.read()
            self.assertNotIn("Secret Golf Club", text)
            self.assertNotIn("# Club", text)

    def test_club_becomes_the_public_channel(self):
        a = write_export(self.exports, "a.csv", [ROW_2, ROW_3])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        _, rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        for row in rows:
            self.assertNotEqual(row["channel"], "club")
            self.assertEqual(row["channel"], "openyardage")

    def test_csv_and_geojson_carry_the_same_rows(self):
        a = write_export(self.exports, "a.csv", [ROW_2, ROW_3, ROW_LOST])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        _, csv_rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        _, geo_rows = read_geojson(os.path.join(self.out, "days", "2027-04-10.geojson"))
        self.assertEqual(len(csv_rows), len(geo_rows))
        for left, right in zip(csv_rows, geo_rows):
            self.assertEqual([normalize(left, name) for name in COLUMNS],
                             [normalize(right, name) for name in COLUMNS])


class TestClosedDays(PublishTest):
    def test_day_plus_two_is_skipped(self):
        a = write_export(self.exports, "a.csv", [ROW_2])
        code, out = self.publish([a], today="2027-04-12")
        self.assertEqual(code, 0)
        self.assertIn("1 row(s) skipped", out)
        self.assertFalse(os.path.exists(os.path.join(self.out, "days", "2027-04-10.csv")))

    def test_day_plus_three_is_published(self):
        a = write_export(self.exports, "a.csv", [ROW_2])
        code, out = self.publish([a], today="2027-04-13")
        self.assertEqual(code, 0)
        self.assertIn("0 row(s) skipped", out)
        self.assertTrue(os.path.exists(os.path.join(self.out, "days", "2027-04-10.csv")))


class TestUnchangeability(PublishTest):
    def test_second_run_changes_no_byte(self):
        a = write_export(self.exports, "a.csv", [ROW_2, ROW_3])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        before = tree_bytes(self.out)
        code, out = self.publish([a])
        self.assertEqual(code, 0)
        self.assertIn("1 day(s) unchanged", out)
        self.assertEqual(before, tree_bytes(self.out))

    def test_changed_row_aborts_and_writes_nothing(self):
        a = write_export(self.exports, "a.csv", [ROW_2, ROW_3])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        before = tree_bytes(self.out)
        new_two = dict(ROW_2)
        new_two["lat"] = "0.0009999"
        b = write_export(self.exports, "b.csv", [new_two])
        code, out = self.publish([b])
        self.assertEqual(code, 1)
        self.assertIn("different content", out)
        self.assertEqual(before, tree_bytes(self.out))

    def test_changed_row_with_new_day_writes_nothing_at_all(self):
        a = write_export(self.exports, "a.csv", [ROW_2])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        before = tree_bytes(self.out)
        new_two = dict(ROW_2)
        new_two["lat"] = "0.0009999"
        changed = write_export(self.exports, "changed.csv", [new_two])
        added = write_export(self.exports, "added.csv", [day("2027-04-05", "1",
                       lat="0.0001", lon="0.0002", source="mapped")])
        code, out = self.publish([changed, added])
        self.assertEqual(code, 1)
        self.assertEqual(before, tree_bytes(self.out))
        self.assertFalse(os.path.exists(os.path.join(self.out, "days", "2027-04-05.csv")))


class TestAborts(PublishTest):
    def test_partner_row_aborts(self):
        partner = dict(ROW_2)
        partner["channel"] = "partner"
        a = write_export(self.exports, "a.csv", [partner])
        code, out = self.publish([a])
        self.assertEqual(code, 1)
        self.assertIn("channel 'partner'", out)
        self.assertFalse(os.path.exists(self.out))

    def test_invalid_input_aborts(self):
        bad = dict(ROW_2)
        bad["input_unit"] = "ft"
        a = write_export(self.exports, "a.csv", [bad])
        code, out = self.publish([a])
        self.assertEqual(code, 1)
        self.assertIn("input_unit", out)
        self.assertFalse(os.path.exists(self.out))


class TestExtraColumns(PublishTest):
    def test_extra_channel_cannot_hide_a_partner_row(self):
        partner = dict(ROW_2)
        partner["channel"] = "partner"
        a = write_export(self.exports, "a.csv", [partner], extra=[("channel", "club")])
        code, out = self.publish([a])
        self.assertEqual(code, 1, out)
        self.assertIn("channel", out)
        self.assertFalse(os.path.exists(self.out))

    def test_extra_date_cannot_publish_a_young_day(self):
        young = day("2027-04-19", "2", lat="0.0001234", lon="0.0002345",
                    source="mapped")
        a = write_export(self.exports, "a.csv", [young], extra=[("date", "2027-04-10")])
        code, out = self.publish([a])
        self.assertEqual(code, 1, out)
        self.assertIn("date", out)
        self.assertFalse(os.path.exists(self.out))

    def test_new_extra_column_is_dropped(self):
        a = write_export(self.exports, "a.csv", [ROW_2], extra=[("note", "x")])
        code, out = self.publish([a])
        self.assertEqual(code, 0, out)
        csv_path = os.path.join(self.out, "days", "2027-04-10.csv")
        header, rows = read_csv_rows(csv_path)
        self.assertEqual(header, COLUMNS)
        self.assertNotIn("note", rows[0])
        with open(csv_path, encoding="utf-8-sig") as handle:
            self.assertNotIn("note", handle.read())
        with open(os.path.join(self.out, "days", "2027-04-10.geojson"),
                  encoding="utf-8") as handle:
            self.assertNotIn('"note":', handle.read())


class TestDuplicateRows(PublishTest):
    def test_same_coordinate_row_in_two_inputs_aborts(self):
        # Two courses never share one coordinate, so the same coordinate row
        # twice means the same export was read twice.
        a = write_export(self.exports, "a.csv", [ROW_2])
        b = write_export(self.exports, "b.csv", [ROW_2])
        code, out = self.publish([a, b])
        self.assertEqual(code, 1)
        self.assertIn("2027-04-10", out)
        self.assertIn("hole 2", out)
        self.assertFalse(os.path.exists(self.out))

    def test_duplicate_lost_position_allowed(self):
        # A lost position has no coordinate: the same hole can be lost on two
        # courses, so an equal row twice is allowed.
        a = write_export(self.exports, "a.csv", [ROW_LOST])
        b = write_export(self.exports, "b.csv", [ROW_LOST])
        code, _ = self.publish([a, b])
        self.assertEqual(code, 0)
        _, rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        self.assertEqual([row["hole"] for row in rows], ["11", "11"])

    def test_duplicate_row_without_source_allowed(self):
        # A row with only front_m and left_m has no coordinate either.
        row = day("2027-04-10", "A1", front_m="6", left_m="3")
        a = write_export(self.exports, "a.csv", [row])
        b = write_export(self.exports, "b.csv", [row])
        code, _ = self.publish([a, b])
        self.assertEqual(code, 0)
        _, rows = read_csv_rows(os.path.join(self.out, "days", "2027-04-10.csv"))
        self.assertEqual([row["hole"] for row in rows], ["A1", "A1"])


class TestCheckBeforeWrite(PublishTest):
    def test_broken_writer_leaves_no_day_no_year_no_index(self):
        a = write_export(self.exports, "a.csv", [ROW_2, ROW_3])
        real = publish._write_csv

        def broken(title, records):
            # A row with input_unit 'ft' is not a valid published file. The
            # real writer is wrapped, so the corruption is a row and not junk.
            return real(title, records).replace(b"right,m,openyardage",
                                                b"right,ft,openyardage", 1)

        with mock.patch.object(publish, "_write_csv", side_effect=broken):
            code, out = self.publish([a])
        self.assertEqual(code, 2, out)
        self.assertIn("program error", out)
        self.assertFalse(os.path.exists(os.path.join(self.out, "days", "2027-04-10.csv")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "days", "2027-04-10.geojson")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "years", "2027.csv")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "index.json")))


class TestCommentsAgainstFormat(PublishTest):
    def test_four_comment_lines_match_format_word_for_word(self):
        with open(os.path.join(ROOT, "FORMAT.md"), encoding="utf-8") as handle:
            lines = [line.strip() for line in handle.read().split("\n")]
        start = next(index for index, line in enumerate(lines)
                     if line.startswith("# OpenPinsheet day file "))
        expected = lines[start:start + 4]
        self.assertEqual(len(expected), 4, expected)
        self.assertEqual(publish._comments(expected[0]), expected)


class TestYearAndIndex(PublishTest):
    def test_year_holds_all_days(self):
        a = write_export(self.exports, "a.csv", [ROW_2])
        b = write_export(self.exports, "b.csv", [day("2027-04-05", "1", lat="0.0001",
                       lon="0.0002", source="mapped")])
        code, _ = self.publish([a, b])
        self.assertEqual(code, 0)
        _, rows = read_csv_rows(os.path.join(self.out, "years", "2027.csv"))
        dates = sorted({row["date"] for row in rows})
        self.assertEqual(dates, ["2027-04-05", "2027-04-10"])

    def test_index_check_is_green(self):
        a = write_export(self.exports, "a.csv", [ROW_2, ROW_3])
        code, _ = self.publish([a])
        self.assertEqual(code, 0)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            check = index.main(["--check", self.out])
        self.assertEqual(check, 0)


if __name__ == "__main__":
    unittest.main()
