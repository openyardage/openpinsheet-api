"""Tests for tools/validate.py against FORMAT.md version 1.

One case per rule. Each test that expects a defect checks that there is
exactly one problem and names its column, so a rule cannot pass by accident.
"""
import copy
import csv
import io
import json
import os
import re
import sys
import unittest
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import validate  # noqa: E402

COLUMNS = list(validate.COLUMNS)
EXAMPLES = os.path.join(ROOT, "examples", "v1")
FORMAT = os.path.join(ROOT, "FORMAT.md")


# The wording of the four published comment lines and of the attribution is
# read out of FORMAT.md, the source of truth, so a test cannot drift from it.
def _format_comment_lines():
    with open(FORMAT, encoding="utf-8") as handle:
        lines = [line.strip() for line in handle.read().split("\n")]
    start = next(index for index, line in enumerate(lines)
                 if line.startswith("# OpenPinsheet day file "))
    return lines[start:start + 4]


def _format_attribution():
    with open(FORMAT, encoding="utf-8") as handle:
        parts = [line[2:].strip() for line in handle.read().split("\n")
                 if line.startswith("> ")]
    return " ".join(parts)


REQUIRED_COMMENTS = _format_comment_lines()
REQUIRED_NOTES = [line[2:] for line in REQUIRED_COMMENTS]
FORMAT_ATTRIBUTION = _format_attribution()
EXAMPLE_NOTE = "EXAMPLE. Made-up records that show the format. Not real data."


def _title_for(filename, prefix):
    name = os.path.basename(filename) if filename else ""
    day = re.match(r"^(\d{4}-\d{2}-\d{2})\.(csv|geojson)$", name, re.IGNORECASE)
    if day:
        return prefix + "OpenPinsheet day file %s. Format 1." % day.group(1)
    year = re.match(r"^(\d{4})\.csv$", name, re.IGNORECASE)
    if year:
        return prefix + "OpenPinsheet year file %s. Format 1." % year.group(1)
    return None


def comments_for(filename):
    title = _title_for(filename, "# ")
    if title is None:
        return list(REQUIRED_COMMENTS)
    return [title] + REQUIRED_COMMENTS[1:]


def notes_for(filename):
    title = _title_for(filename, "")
    if title is None:
        return list(REQUIRED_NOTES)
    return [title] + REQUIRED_NOTES[1:]


ROW_EST_M = 0
ROW_MAPPED = 1
ROW_EST_YD = 2
ROW_LOST = 3
ROW_NOSOURCE = 4
ROW_SURVEYED = 5


def base_rows():
    return [
        {"date": "2027-04-12", "date_basis": "local", "hole": "2",
         "lat": "0.0001234", "lon": "0.0002345", "source": "estimated",
         "front_m": "12", "left_m": "9.5", "input_front": "12",
         "input_offset": "5", "input_side": "right", "input_unit": "m",
         "channel": "openyardage"},
        {"date": "2027-04-12", "date_basis": "local", "hole": "3",
         "lat": "0.0003456", "lon": "0.0004567", "source": "mapped",
         "channel": "openyardage"},
        {"date": "2027-04-12", "date_basis": "local", "hole": "10",
         "lat": "0.0005678", "lon": "0.0006789", "source": "estimated",
         "front_m": "8", "left_m": "4.2", "input_front": "9",
         "input_offset": "7", "input_side": "left", "input_unit": "yd",
         "channel": "openyardage"},
        {"date": "2027-04-12", "date_basis": "local", "hole": "11",
         "missing": "1"},
        {"date": "2027-04-12", "date_basis": "local", "hole": "A1",
         "front_m": "6", "left_m": "3", "channel": "openyardage"},
        {"date": "2027-04-12", "date_basis": "local", "hole": "B3",
         "lat": "0.0007891", "lon": "0.0008912", "source": "surveyed",
         "accuracy_m": "0.03", "channel": "openyardage"},
    ]


def changed(rows, index, **kwargs):
    rows = [dict(row) for row in rows]
    for key, value in kwargs.items():
        if value is None:
            rows[index].pop(key, None)
        else:
            rows[index][key] = value
    return rows


def csv_text(rows, header=None, comments=None, bom=False, eol="\n"):
    header = list(header) if header else list(COLUMNS)
    lines = list(comments) if comments is not None else list(REQUIRED_COMMENTS)
    lines.append(",".join(header))
    for row in rows:
        lines.append(",".join(str(row.get(name, "")) for name in header))
    text = eol.join(lines) + eol
    return "\ufeff" + text if bom else text


def csv_text_positional(rows, header):
    lines = list(REQUIRED_COMMENTS)
    lines.append(",".join(header))
    for row in rows:
        lines.append(",".join(str(row.get(name, "")) for name in COLUMNS))
    return "\n".join(lines) + "\n"


def csv_problems(rows, filename=None, club_export=False, **kwargs):
    if "comments" not in kwargs:
        kwargs["comments"] = comments_for(filename)
    return validate.validate_csv_text(csv_text(rows, **kwargs), filename, club_export)


def number_text(value):
    if value is None or value == "":
        return ""
    return format(Decimal(str(value)), "f")


def normalize(record, name):
    if name == "missing":
        value = record.get(name, "")
        return "1" if value in ("1", True, 1) else ""
    if name in validate.NUMBER_COLUMNS:
        return number_text(record.get(name, ""))
    value = record.get(name, "")
    return "" if value is None else str(value)


def base_features():
    return [
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.0002345, 0.0001234]},
         "properties": {"date": "2027-04-12", "date_basis": "local", "hole": "2",
                        "source": "estimated", "front_m": 12, "left_m": 9.5,
                        "input_front": 12, "input_offset": 5, "input_side": "right",
                        "input_unit": "m", "channel": "openyardage"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.0004567, 0.0003456]},
         "properties": {"date": "2027-04-12", "date_basis": "local", "hole": "3",
                        "source": "mapped", "channel": "openyardage"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.0006789, 0.0005678]},
         "properties": {"date": "2027-04-12", "date_basis": "local", "hole": "10",
                        "source": "estimated", "front_m": 8, "left_m": 4.2,
                        "input_front": 9, "input_offset": 7, "input_side": "left",
                        "input_unit": "yd", "channel": "openyardage"}},
        {"type": "Feature", "geometry": None,
         "properties": {"date": "2027-04-12", "date_basis": "local", "hole": "11",
                        "missing": True}},
        {"type": "Feature", "geometry": None,
         "properties": {"date": "2027-04-12", "date_basis": "local", "hole": "A1",
                        "front_m": 6, "left_m": 3, "channel": "openyardage"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [0.0008912, 0.0007891]},
         "properties": {"date": "2027-04-12", "date_basis": "local", "hole": "B3",
                        "source": "surveyed", "accuracy_m": 0.03, "channel": "openyardage"}},
    ]


def geojson_text(feature_list, **overrides):
    document = {
        "type": "FeatureCollection",
        "format": 1,
        "as_of": "2027-04-14",
        "license": {"name": "Open Database License 1.0", "spdx": "ODbL-1.0",
                    "url": "https://opendatacommons.org/licenses/odbl/1-0/"},
        "attribution": FORMAT_ATTRIBUTION,
        "notes": [EXAMPLE_NOTE] + list(REQUIRED_NOTES),
        "features": feature_list,
    }
    document.update(overrides)
    return json.dumps(document)


def geojson_problems(features, filename=None, club_export=False, **overrides):
    overrides.setdefault("attribution", FORMAT_ATTRIBUTION)
    overrides.setdefault("notes", [EXAMPLE_NOTE] + notes_for(filename))
    return validate.validate_geojson_text(geojson_text(feature_list=features, **overrides), filename, club_export)


def prop_changed(features, index, **kwargs):
    features = copy.deepcopy(features)
    properties = features[index]["properties"]
    for key, value in kwargs.items():
        if value is None:
            properties.pop(key, None)
        else:
            properties[key] = value
    return features


def feature_changed(features, index, **kwargs):
    features = copy.deepcopy(features)
    for key, value in kwargs.items():
        if value is None:
            features[index].pop(key, None)
        else:
            features[index][key] = value
    return features


class OneProblemMixin(unittest.TestCase):
    def assertOne(self, problems, column):
        self.assertEqual(len(problems), 1, list(problems))
        self.assertEqual(problems[0].column, column, list(problems))


class TestExamples(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(EXAMPLES, "days", name), encoding="utf-8") as handle:
            return handle.read()

    def test_csv_valid(self):
        path = os.path.join(EXAMPLES, "days", "2027-04-12.csv")
        self.assertEqual(validate.validate_csv_text(self.read("2027-04-12.csv"), path), [])

    def test_geojson_valid(self):
        path = os.path.join(EXAMPLES, "days", "2027-04-12.geojson")
        self.assertEqual(validate.validate_geojson_text(self.read("2027-04-12.geojson"), path), [])

    def test_csv_and_geojson_same_rows(self):
        with open(os.path.join(EXAMPLES, "days", "2027-04-12.csv"), encoding="utf-8-sig", newline="") as handle:
            text = handle.read()
        lines = [line for line in text.split("\n") if line and not line.startswith("# ")]
        reader = csv.reader(io.StringIO("\n".join(lines)))
        header = next(reader)
        csv_rows = [dict(zip(header, fields)) for fields in reader]

        with open(os.path.join(EXAMPLES, "days", "2027-04-12.geojson"), encoding="utf-8") as handle:
            data = json.load(handle)
        geo_rows = []
        for feature in data["features"]:
            record = dict(feature["properties"])
            coordinates = feature["geometry"]["coordinates"] if feature["geometry"] else [None, None]
            record["lon"] = coordinates[0]
            record["lat"] = coordinates[1]
            geo_rows.append(record)

        self.assertEqual(len(csv_rows), len(geo_rows))
        for left, right in zip(csv_rows, geo_rows):
            self.assertEqual([normalize(left, c) for c in COLUMNS],
                             [normalize(right, c) for c in COLUMNS])


class TestCsvFormat(OneProblemMixin):
    def test_no_bom_lf_accepted(self):
        self.assertEqual(csv_problems(base_rows()), [])

    def test_bom_and_crlf_accepted(self):
        self.assertEqual(csv_problems(base_rows(), bom=True, eol="\r\n"), [])

    def test_comments_before_header(self):
        comments = ["# title", "# license"] + list(REQUIRED_COMMENTS)
        self.assertEqual(csv_problems(base_rows(), comments=comments), [])

    def test_comment_with_comma(self):
        self.assertOne(csv_problems(base_rows(), comments=["# a, b"] + list(REQUIRED_COMMENTS)), "#")

    def test_comment_after_header(self):
        text = csv_text(base_rows())
        text = text.replace("2027-04-12,local,2", "# late, note\n2027-04-12,local,2", 1)
        self.assertOne(validate.validate_csv_text(text), "#")

    def test_header_name(self):
        header = list(COLUMNS)
        header[0] = "datum"
        self.assertOne(validate.validate_csv_text(csv_text_positional(base_rows(), header)), "date")

    def test_header_missing_column(self):
        rows = [base_rows()[ROW_MAPPED]]
        self.assertOne(csv_problems(rows, header=COLUMNS[:14]), "missing")

    def test_extra_columns_allowed(self):
        header = list(COLUMNS) + ["note"]
        rows = base_rows()
        for row in rows:
            row["note"] = "x"
        self.assertEqual(csv_problems(rows, header=header), [])

    def test_duplicate_extra_channel_rejected(self):
        header = list(COLUMNS) + ["channel"]
        self.assertOne(csv_problems([base_rows()[ROW_MAPPED]], header=header), "channel")

    def test_duplicate_extra_date_rejected(self):
        header = list(COLUMNS) + ["date"]
        self.assertOne(csv_problems([base_rows()[ROW_MAPPED]], header=header), "date")

    def test_field_count(self):
        text = csv_text(base_rows())
        longer = text.replace("openyardage,,,\n2027-04-12,local,3",
                              "openyardage,,,,extra\n2027-04-12,local,3", 1)
        self.assertNotEqual(longer, text)
        self.assertOne(validate.validate_csv_text(longer), "fields")

    def test_published_file_needs_all_17_columns(self):
        rows = [base_rows()[ROW_MAPPED]]
        self.assertOne(csv_problems(rows, header=COLUMNS[:15]), "play_bearing_deg")

    def test_club_export_may_end_after_missing(self):
        # FORMAT.md 5: the first producers write 15 columns.
        rows = [changed(base_rows(), index, channel="club")[index]
                for index in (ROW_EST_M, ROW_MAPPED, ROW_SURVEYED)]
        rows.append(base_rows()[ROW_LOST])
        rows.sort(key=lambda row: int(row["hole"]) if row["hole"].isdigit() else 999)
        self.assertEqual(csv_problems(rows, club_export=True, header=COLUMNS[:15]), [])

    def test_club_export_with_another_column_after_missing(self):
        # publish.py reads by position: a foreign column in place 16 would be
        # read as play_bearing_deg.
        rows = [changed(base_rows(), ROW_MAPPED, channel="club")[ROW_MAPPED]]
        self.assertOne(csv_problems(rows, club_export=True, header=COLUMNS[:15] + ["note"]),
                       "play_bearing_deg")

    def test_missing_bad_value(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, missing="2")), "missing")


class TestNumbers(OneProblemMixin):
    def one(self, **kwargs):
        return csv_problems(changed(base_rows(), ROW_MAPPED, **kwargs))

    def test_trailing_zero(self):
        self.assertOne(self.one(lat="0.0001230"), "lat")

    def test_minus_zero(self):
        self.assertOne(self.one(lat="-0"), "lat")

    def test_exponent(self):
        self.assertOne(self.one(lat="1e-4"), "lat")

    def test_leading_zero(self):
        self.assertOne(self.one(lat="00.5"), "lat")

    def test_plus_sign(self):
        self.assertOne(self.one(lat="+1"), "lat")

    def test_too_many_decimals(self):
        self.assertOne(self.one(lat="0.00012345"), "lat")

    def test_lat_range(self):
        self.assertOne(self.one(lat="90.5"), "lat")

    def test_lon_range(self):
        self.assertOne(self.one(lon="180.5"), "lon")

    def test_accuracy_zero(self):
        self.assertOne(self.one(accuracy_m="0"), "accuracy_m")

    def test_accuracy_negative(self):
        self.assertOne(self.one(accuracy_m="-1.5"), "accuracy_m")

    def test_decimals_limited_for_every_number(self):
        # FORMAT.md 4.1: the 7 decimal limit is not only for lat and lon.
        rows = changed(base_rows(), ROW_SURVEYED, accuracy_m="0.00000003")
        self.assertOne(csv_problems(rows), "accuracy_m")

    def test_decimals_allowed_for_every_number(self):
        rows = changed(base_rows(), ROW_SURVEYED, accuracy_m="0.0000003")
        self.assertEqual(csv_problems(rows), [])

    def test_front_negative(self):
        rows = changed(base_rows(), ROW_EST_M, front_m="-1")
        self.assertOne(csv_problems(rows), "front_m")


class TestRowRules(OneProblemMixin):
    def test_lat_without_lon(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, lon=None)), "lon")

    def test_lon_without_lat(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, lat=None)), "lat")

    def test_lost_position_valid(self):
        self.assertEqual(csv_problems(base_rows()), [])

    def test_lost_position_with_lat(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_LOST, lat="1")), "lat")

    def test_coordinate_without_source(self):
        rows = changed(base_rows(), ROW_NOSOURCE, lat="0.0001", lon="0.0002")
        self.assertOne(csv_problems(rows), "source")

    def test_no_source_needs_front_left(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_NOSOURCE, front_m=None)), "front_m")

    def test_front_left_together(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_EST_M, left_m=None)), "left_m")

    def test_accuracy_required_surveyed(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_SURVEYED, accuracy_m=None)), "accuracy_m")

    def test_accuracy_required_detected(self):
        rows = changed(base_rows(), ROW_SURVEYED, source="detected", accuracy_m=None)
        self.assertOne(csv_problems(rows), "accuracy_m")

    def test_accuracy_forbidden_estimated(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_EST_M, accuracy_m="1")), "accuracy_m")

    def test_accuracy_forbidden_without_source(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_NOSOURCE, accuracy_m="1")), "accuracy_m")

    def test_input_partial(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_EST_M, input_offset=None)), "input_offset")

    def test_input_without_estimated(self):
        rows = changed(base_rows(), ROW_EST_M, source="surveyed", accuracy_m="0.03")
        self.assertOne(csv_problems(rows), "input_unit")

    def test_channel_required(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, channel=None)), "channel")

    def test_channel_pattern(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, channel="OpenYardage")), "channel")
        for bad in ("1club", "-club", "club-", "golf--club", "a", "a" * 41, "golf_club"):
            with self.subTest(channel=bad):
                self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, channel=bad)), "channel")

    def test_channel_with_hyphens(self):
        # The form the account page of the API builds from a partner name.
        for good in ("golfclub-berlin", "gc-st-leon-rot-2", "a" * 40):
            with self.subTest(channel=good):
                self.assertEqual(csv_problems(changed(base_rows(), ROW_MAPPED, channel=good)), [])

    def test_club_rejected(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, channel="club")), "channel")

    def test_club_allowed_in_export(self):
        rows = changed(base_rows(), ROW_MAPPED, channel="club")
        self.assertEqual(csv_problems(rows, club_export=True), [])

    def test_date_required(self):
        rows = changed([base_rows()[ROW_MAPPED]], 0, date=None)
        self.assertOne(validate.validate_csv_text(csv_text(rows)), "date")

    def test_date_invalid(self):
        rows = changed([base_rows()[ROW_MAPPED]], 0, date="2027-02-30")
        self.assertOne(validate.validate_csv_text(csv_text(rows)), "date")

    def test_date_basis_bad(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, date_basis="gmt")), "date_basis")

    def test_date_basis_required(self):
        rows = changed([base_rows()[ROW_MAPPED]], 0, date_basis=None)
        self.assertOne(validate.validate_csv_text(csv_text(rows)), "date_basis")

    def test_hole_bad(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_MAPPED, hole="A-1")), "hole")

    def test_source_bad(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_SURVEYED, source="gps")), "source")

    def test_input_side_bad(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_EST_M, input_side="up")), "input_side")

    def test_input_unit_bad(self):
        self.assertOne(csv_problems(changed(base_rows(), ROW_EST_M, input_unit="ft")), "input_unit")


class TestBearingAndCorrection(OneProblemMixin):
    """FORMAT.md 2 columns 16 and 17, and rules 7 and 8 of 2.1."""

    def bearing(self, value, index=ROW_EST_M, **kwargs):
        return csv_problems(changed(base_rows(), index, play_bearing_deg=value, **kwargs))

    def correction(self, value, index=ROW_SURVEYED, **kwargs):
        return csv_problems(changed(base_rows(), index, correction=value, **kwargs))

    def test_bearing_valid(self):
        for value in ("0", "274.5", "359.9", "90"):
            self.assertEqual(self.bearing(value), [], value)

    def test_bearing_360_rejected(self):
        self.assertOne(self.bearing("360"), "play_bearing_deg")

    def test_bearing_negative_rejected(self):
        self.assertOne(self.bearing("-0.5"), "play_bearing_deg")

    def test_bearing_two_decimals_rejected(self):
        self.assertOne(self.bearing("274.25"), "play_bearing_deg")

    def test_bearing_trailing_zero_reported_once(self):
        self.assertOne(self.bearing("274.50"), "play_bearing_deg")

    def test_bearing_only_with_input(self):
        self.assertOne(self.bearing("274.5", input_front=None, input_offset=None,
                                    input_side=None, input_unit=None), "play_bearing_deg")

    def test_bearing_not_with_mapped(self):
        self.assertOne(self.bearing("274.5", ROW_MAPPED), "play_bearing_deg")

    def test_bearing_empty_for_lost_position(self):
        self.assertOne(self.bearing("274.5", ROW_LOST), "play_bearing_deg")

    def test_estimated_without_bearing_valid(self):
        # Optional in format 1: the first producers do not send it yet.
        self.assertEqual(csv_problems(base_rows()), [])

    def test_correction_values(self):
        for value in ("none", "ppp", "rtk", "ppk"):
            self.assertEqual(self.correction(value), [], value)

    def test_correction_unknown_value(self):
        self.assertOne(self.correction("dgps"), "correction")

    def test_correction_only_with_surveyed(self):
        for index in (ROW_EST_M, ROW_MAPPED, ROW_NOSOURCE):
            self.assertOne(self.correction("rtk", index), "correction")

    def test_correction_empty_for_lost_position(self):
        self.assertOne(self.correction("rtk", ROW_LOST), "correction")

    def test_geojson_bearing_and_correction(self):
        features = base_features()
        features[ROW_EST_M]["properties"]["play_bearing_deg"] = 274.5
        features[ROW_SURVEYED]["properties"]["correction"] = "ppk"
        self.assertEqual(geojson_problems(features), [])

    def test_geojson_bearing_must_be_a_number(self):
        features = base_features()
        features[ROW_EST_M]["properties"]["play_bearing_deg"] = "274.5"
        self.assertOne(geojson_problems(features), "play_bearing_deg")

    def test_geojson_correction_on_lost_position(self):
        features = base_features()
        features[ROW_LOST]["properties"]["correction"] = "rtk"
        self.assertOne(geojson_problems(features), "correction")


class TestOrderAndDayFile(OneProblemMixin):
    def test_order_ok(self):
        rows = [dict(base_rows()[ROW_MAPPED]), dict(base_rows()[ROW_MAPPED])]
        rows[0]["hole"] = "2"
        rows[1]["hole"] = "10"
        self.assertEqual(csv_problems(rows), [])

    def test_order_hole(self):
        rows = [dict(base_rows()[ROW_MAPPED]), dict(base_rows()[ROW_MAPPED])]
        rows[0]["hole"] = "10"
        rows[1]["hole"] = "2"
        self.assertOne(csv_problems(rows), "hole")

    def test_order_text_after_digits(self):
        rows = [dict(base_rows()[ROW_MAPPED]), dict(base_rows()[ROW_MAPPED])]
        rows[0]["hole"] = "B3"
        rows[1]["hole"] = "10"
        self.assertOne(csv_problems(rows), "hole")

    def test_order_date(self):
        rows = [dict(base_rows()[ROW_MAPPED]), dict(base_rows()[ROW_MAPPED])]
        rows[0]["date"] = "2027-04-13"
        rows[1]["date"] = "2027-04-12"
        self.assertOne(csv_problems(rows, filename=None), "date")

    def test_day_file_ok(self):
        self.assertEqual(csv_problems(base_rows(), filename="2027-04-12.csv"), [])

    def test_day_file_mismatch(self):
        rows = [base_rows()[ROW_MAPPED]]
        self.assertOne(csv_problems(rows, filename="2027-04-13.csv"), "date")

    def test_day_file_ignored_in_club_export(self):
        rows = [base_rows()[ROW_MAPPED]]
        self.assertEqual(csv_problems(rows, filename="2027-04-13.csv", club_export=True), [])


class TestPublishedComments(OneProblemMixin):
    def test_missing_comments_rejected(self):
        self.assertOne(csv_problems(base_rows(), comments=[]), "#")

    def test_wrong_licence_line_rejected(self):
        comments = list(REQUIRED_COMMENTS)
        comments[1] = "# Licence: MIT"
        self.assertOne(csv_problems(base_rows(), comments=comments), "#")

    def test_extra_comment_before_the_four_allowed(self):
        comments = ["# EXAMPLE. Made-up records."] + list(REQUIRED_COMMENTS)
        self.assertEqual(csv_problems(base_rows(), comments=comments), [])

    def test_day_title_must_match_filename(self):
        row = dict(base_rows()[ROW_MAPPED])
        row["date"] = "2027-04-13"
        self.assertOne(csv_problems([row], filename="2027-04-13.csv",
                                    comments=list(REQUIRED_COMMENTS)), "#")

    def test_no_filename_accepts_year_title(self):
        row = dict(base_rows()[ROW_MAPPED])
        comments = ["# OpenPinsheet year file 2027. Format 1."] + list(REQUIRED_COMMENTS[1:])
        self.assertEqual(csv_problems([row], comments=comments), [])

    def test_club_export_ignores_comments(self):
        self.assertEqual(csv_problems(base_rows(), comments=[], club_export=True), [])


class TestYearFile(OneProblemMixin):
    def year_comments(self):
        return ["# OpenPinsheet year file 2027. Format 1."] + list(REQUIRED_COMMENTS[1:])

    def test_year_file_ok(self):
        row = dict(base_rows()[ROW_MAPPED])
        row["date"] = "2027-04-12"
        self.assertEqual(csv_problems([row], filename="2027.csv",
                                      comments=self.year_comments()), [])

    def test_row_outside_the_year_rejected(self):
        row = dict(base_rows()[ROW_MAPPED])
        row["date"] = "2026-04-12"
        self.assertOne(csv_problems([row], filename="2027.csv",
                                    comments=self.year_comments()), "date")

    def test_year_title_must_match_filename(self):
        row = dict(base_rows()[ROW_MAPPED])
        row["date"] = "2027-04-12"
        wrong = ["# OpenPinsheet year file 2028. Format 1."] + list(REQUIRED_COMMENTS[1:])
        self.assertOne(csv_problems([row], filename="2027.csv", comments=wrong), "#")


class TestGeojsonRoot(OneProblemMixin):
    def one(self, **overrides):
        return geojson_problems(base_features(), **overrides)

    def test_valid(self):
        self.assertEqual(geojson_problems(base_features()), [])

    def test_type(self):
        self.assertOne(self.one(type="X"), "type")

    def test_format(self):
        self.assertOne(self.one(format=2), "format")

    def test_as_of(self):
        self.assertOne(self.one(as_of="2027-13-40"), "as_of")

    def test_license(self):
        self.assertOne(self.one(license={"name": "MIT", "spdx": "MIT"}), "license")

    def test_license_name(self):
        license_ = {"name": "MIT", "spdx": "ODbL-1.0",
                    "url": "https://opendatacommons.org/licenses/odbl/1-0/"}
        self.assertOne(self.one(license=license_), "license")

    def test_license_url(self):
        license_ = {"name": "Open Database License 1.0", "spdx": "ODbL-1.0",
                    "url": "https://example.org/odbl"}
        self.assertOne(self.one(license=license_), "license")

    def test_attribution(self):
        self.assertOne(self.one(attribution=12), "attribution")

    def test_attribution_must_be_the_section_6_text(self):
        self.assertOne(self.one(attribution="OpenPinsheet and its data partners"), "attribution")

    def test_notes(self):
        self.assertOne(self.one(notes="x"), "notes")

    def test_notes_must_end_with_the_four_sentences(self):
        self.assertOne(self.one(notes=["EXAMPLE. Made-up records."]), "notes")

    def test_notes_extra_before_the_four_allowed(self):
        notes = ["EXAMPLE. Made-up records."] + list(REQUIRED_NOTES)
        self.assertEqual(geojson_problems(base_features(), notes=notes), [])

    def test_club_export_ignores_notes_and_attribution(self):
        self.assertEqual(geojson_problems(base_features(), club_export=True,
                                          attribution="x", notes=[]), [])

    def test_features(self):
        self.assertOne(validate.validate_geojson_text(geojson_text([], features={})), "features")


class TestGeojsonFeature(OneProblemMixin):
    def test_feature_type(self):
        features = feature_changed(base_features(), ROW_MAPPED, type="X")
        self.assertOne(geojson_problems(features), "type")

    def test_geometry_required(self):
        features = feature_changed(base_features(), ROW_MAPPED, geometry=None)
        self.assertOne(geojson_problems(features), "geometry")

    def test_geometry_type(self):
        features = feature_changed(base_features(), ROW_MAPPED, geometry="x")
        self.assertOne(geojson_problems(features), "geometry")

    def test_coordinates_length(self):
        features = copy.deepcopy(base_features())
        features[ROW_MAPPED]["geometry"]["coordinates"] = [1]
        self.assertOne(geojson_problems(features), "geometry")

    def test_coordinate_not_number(self):
        features = copy.deepcopy(base_features())
        features[ROW_MAPPED]["geometry"]["coordinates"] = ["a", 0.0003456]
        self.assertOne(geojson_problems(features), "geometry")

    def test_lat_range(self):
        features = copy.deepcopy(base_features())
        features[ROW_MAPPED]["geometry"]["coordinates"] = [0.0004567, 91]
        self.assertOne(geojson_problems(features), "lat")

    def test_lon_decimals(self):
        features = copy.deepcopy(base_features())
        features[ROW_MAPPED]["geometry"]["coordinates"] = [0.00012345, 0.0003456]
        self.assertOne(geojson_problems(features), "lon")

    def test_null_property(self):
        features = copy.deepcopy(base_features())
        features[ROW_MAPPED]["properties"]["date_basis"] = None
        self.assertOne(geojson_problems(features), "date_basis")

    def test_unknown_property(self):
        features = prop_changed(base_features(), ROW_MAPPED, lat=1)
        self.assertOne(geojson_problems(features), "properties")

    def test_hole_must_be_string(self):
        features = prop_changed(base_features(), ROW_MAPPED, hole=7)
        self.assertOne(geojson_problems(features), "hole")

    def test_number_must_be_json_number(self):
        features = prop_changed(base_features(), ROW_EST_M, front_m="12")
        self.assertOne(geojson_problems(features), "front_m")

    def raw_geojson(self, old, new):
        text = geojson_text(base_features())
        self.assertEqual(text.count(old), 1, old)
        return text.replace(old, new, 1)

    def test_number_trailing_zero_rejected(self):
        # FORMAT.md 4.2: the text of a Decimal must be the form of 4.1, and
        # 12.0 is the same value as 12 but not the same text.
        text = self.raw_geojson('"front_m": 12,', '"front_m": 12.0,')
        self.assertOne(validate.validate_geojson_text(text), "front_m")

    def test_number_exponent_rejected(self):
        text = self.raw_geojson('"front_m": 12,', '"front_m": 1e2,')
        self.assertOne(validate.validate_geojson_text(text), "front_m")

    def test_coordinate_trailing_zero_rejected(self):
        text = self.raw_geojson('[0.0004567, 0.0003456]', '[0.0004567, 12.0]')
        self.assertOne(validate.validate_geojson_text(text), "geometry")

    def test_coordinate_exponent_rejected(self):
        text = self.raw_geojson('[0.0004567, 0.0003456]', '[0.0004567, 1e1]')
        self.assertOne(validate.validate_geojson_text(text), "geometry")

    def test_negative_zero_rejected(self):
        text = self.raw_geojson('"front_m": 12,', '"front_m": -0.0,')
        self.assertOne(validate.validate_geojson_text(text), "front_m")

    def test_coordinate_small_decimal_is_valid(self):
        # 0.0000005 has 7 decimals. Python writes that Decimal as 5E-7, but it
        # is the plain decimal form of section 4.1 and a valid latitude.
        text = self.raw_geojson('[0.0004567, 0.0003456]', '[0.0004567, 0.0000005]')
        self.assertEqual(validate.validate_geojson_text(text), [])

    def test_coordinate_negative_small_decimal_is_valid(self):
        text = self.raw_geojson('[0.0004567, 0.0003456]', '[0.0004567, -0.0000001]')
        self.assertEqual(validate.validate_geojson_text(text), [])

    def test_number_small_decimal_is_valid(self):
        text = self.raw_geojson('"front_m": 12,', '"front_m": 0.0000001,')
        self.assertEqual(validate.validate_geojson_text(text), [])

    def test_number_zero_with_decimal_point_rejected(self):
        text = self.raw_geojson('"front_m": 12,', '"front_m": 0.0,')
        self.assertOne(validate.validate_geojson_text(text), "front_m")

    def test_integer_number_is_valid(self):
        # base_features carry front_m=12 as an int, and an int is valid.
        self.assertEqual(geojson_problems(base_features()), [])

    def test_missing_must_be_true(self):
        features = prop_changed(base_features(), ROW_LOST, missing=False)
        self.assertOne(geojson_problems(features), "missing")

    def test_missing_needs_null_geometry(self):
        features = copy.deepcopy(base_features())
        features[ROW_LOST]["geometry"] = {"type": "Point", "coordinates": [1, 2]}
        self.assertOne(geojson_problems(features), "geometry")

    def test_date_basis_required(self):
        features = prop_changed(base_features(), ROW_MAPPED, date_basis=None)
        self.assertOne(geojson_problems(features), "date_basis")

    def test_missing_row_must_be_empty(self):
        features = prop_changed(base_features(), ROW_LOST, channel="openyardage")
        self.assertOne(geojson_problems(features), "channel")

    def test_order(self):
        features = [copy.deepcopy(base_features()[ROW_MAPPED]) for _ in range(2)]
        features[0]["properties"]["hole"] = "10"
        features[1]["properties"]["hole"] = "2"
        self.assertOne(geojson_problems(features), "hole")

    def test_day_file_mismatch(self):
        features = [copy.deepcopy(base_features()[ROW_MAPPED])]
        self.assertOne(geojson_problems(features, filename="2027-04-13.geojson"), "date")

    def test_club_rejected(self):
        features = prop_changed(base_features(), ROW_MAPPED, channel="club")
        self.assertOne(geojson_problems(features), "channel")

    def test_club_allowed_in_export(self):
        features = prop_changed(base_features(), ROW_MAPPED, channel="club")
        self.assertEqual(geojson_problems(features, club_export=True), [])
