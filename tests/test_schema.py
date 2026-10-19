"""Structural checks on schema/feature.schema.json.

There is no jsonschema library here, so the schema is checked as JSON: it must
parse, and the two conditions added for FORMAT.md 2.1 must be present. The
shape of each condition is checked, not the wording of the description.
"""
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCHEMA_PATH = os.path.join(ROOT, "schema", "feature.schema.json")


class TestFeatureSchema(unittest.TestCase):
    def setUp(self):
        with open(SCHEMA_PATH, encoding="utf-8") as handle:
            self.schema = json.load(handle)

    def test_is_valid_json_object(self):
        self.assertIsInstance(self.schema, dict)
        self.assertEqual(self.schema["type"], "object")
        self.assertEqual(self.schema["properties"]["type"], {"const": "Feature"})

    def test_channel_may_not_be_club(self):
        channel = self.schema["$defs"]["properties"]["properties"]["channel"]
        self.assertEqual(channel.get("not"), {"const": "club"})

    def test_row_without_source_needs_null_geometry(self):
        found = False
        for rule in self.schema.get("allOf", []):
            condition = rule.get("if", {}).get("properties", {}).get("properties", {})
            required = [item.get("not", {}).get("required")
                        for item in condition.get("allOf", [])]
            if ["missing"] in required and ["source"] in required:
                then = rule.get("then", {}).get("properties", {}).get("geometry")
                self.assertEqual(then, {"type": "null"})
                found = True
        self.assertTrue(found, "no condition tying a source-less row to geometry null")

    def test_bearing_and_correction(self):
        properties = self.schema["$defs"]["properties"]
        self.assertEqual(properties["properties"]["play_bearing_deg"],
                         {"type": "number", "minimum": 0, "exclusiveMaximum": 360})
        self.assertEqual(properties["properties"]["correction"],
                         {"enum": ["none", "ppp", "rtk", "ppk"]})
        rules = properties["allOf"]
        lost = next(rule for rule in rules if rule.get("if") == {"required": ["missing"]})
        forbidden = [item["required"] for item in lost["then"]["not"]["anyOf"]]
        self.assertIn(["play_bearing_deg"], forbidden)
        self.assertIn(["correction"], forbidden)
        dependent = next(rule["dependentRequired"] for rule in rules if "dependentRequired" in rule)
        self.assertEqual(dependent["play_bearing_deg"],
                         ["input_front", "input_offset", "input_side", "input_unit"])
        surveyed = next(rule for rule in rules if rule.get("if") == {"required": ["correction"]})
        self.assertEqual(surveyed["then"]["properties"]["source"], {"const": "surveyed"})
        self.assertIn("source", surveyed["then"]["required"])


if __name__ == "__main__":
    unittest.main()
