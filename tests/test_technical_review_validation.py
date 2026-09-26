"""Synthetic hostile-shape and provenance tests for projected library fields."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.catalog import ValidationError
from estimator.firestopping_library import FirestoppingLibrary
from estimator.reference_library import ReferenceLibrary
from estimator.technical_fields import normalize_technical_item
from estimator.technical_field_reviewed import review_fingerprint
from tests.test_reference_library import sample_library


class TechnicalReviewValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "library"
        self.data, _, _ = sample_library(self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def item(self):
        return self.data["libraries"]["technical"]["items"][0]

    def load(self):
        (self.directory / "library.json").write_text(json.dumps(self.data), encoding="utf-8")
        library = ReferenceLibrary(self.directory)
        library.overview()
        return library

    def set_review(self, fields):
        # This fixture has one unchanged field, so pre-merge and merged generic
        # projections are identical. Correct fingerprints ensure malformed
        # shape tests fail for validation, not merely for a missing fingerprint.
        raw = deepcopy(self.item())
        raw.pop("technical_field_review", None)
        generic = normalize_technical_item(raw)["fields"]
        self.item()["technical_field_review"] = {
            "source_fields_sha256": review_fingerprint(raw["fields"]),
            "pre_review_fields_sha256": review_fingerprint(generic),
            "fields": fields,
        }

    def test_raw_plural_table_rejects_misaligned_rows(self):
        self.item()["fields"] = [{"label": "Service", "value": "", "tables": [
            {"columns": ["Service", "FRL"], "rows": [["Only one cell"]]}
        ]}]
        with self.assertRaises(ValidationError):
            self.load()

    def test_raw_plural_table_rejects_excess_rows_and_nontext_cells(self):
        tables = [
            {"columns": ["Service"], "rows": [["A"]] * 2001},
            {"columns": ["Service"], "rows": [[{"path": "../outside"}]]},
            {"columns": ["Service"], "rows": [["A"]], "path": "../outside"},
        ]
        for table in tables:
            with self.subTest(table_type=str(table)[:70]):
                self.item()["fields"] = [{"label": "Service", "value": "", "tables": [table]}]
                with self.assertRaises(ValidationError):
                    self.load()

    def test_reviewed_plural_table_rejects_invalid_shape(self):
        for table in [
            {"columns": ["Service", "Wrap"], "rows": [["A"]]},
            {"columns": ["Service"], "rows": [["A"]] * 2001},
            {"columns": ["Service"], "rows": [[False]]},
        ]:
            with self.subTest(table_type=str(table)[:70]):
                self.set_review([
                    {"label": "Service", "value": "", "tables": [table]}
                ])
                with self.assertRaises(ValidationError):
                    self.load()

    def test_reviewed_image_requires_registered_raster_id(self):
        for asset_id in ["missing-image", "../outside", "report-a"]:
            with self.subTest(asset_id=asset_id):
                self.set_review([
                    {"label": "Diagrams & Figures", "value": "", "images": [
                        {"id": asset_id, "caption": "Source diagram"}
                    ]}
                ])
                with self.assertRaises(ValidationError):
                    self.load()

    def test_review_control_has_valid_fingerprints_and_registered_image(self):
        self.set_review([{"label": "Diagrams & Figures", "value": "", "images": [
            {"id": "diagram-a", "caption": "Source diagram"}
        ]}])
        detail = self.load().detail("technical", "report-a-v1")
        self.assertEqual(detail["fields"][0]["images"][0]["id"], "diagram-a")

    def test_review_cannot_reintroduce_removed_or_hidden_labels(self):
        for label in ["Lead Time", "lead-time", "Lead Time (Source Reference)",
                      "Technical Basis", "Source table notes", "Source option alignment",
                      "Document Revision", "Selector Search Context", "T-card number",
                      "Reference review"]:
            with self.subTest(label=label):
                self.set_review([{"label": label, "value": "Private supporting information"}])
                with self.assertRaises(ValidationError):
                    self.load()

    def test_raw_projection_marker_cannot_bypass_stale_review_fingerprint(self):
        self.set_review([{"label": "Service", "value": "Reviewed service"}])
        self.item()["technical_field_review"]["source_fields_sha256"] = "0" * 64
        self.item()["technical_basis"] = {"projection_version": 1, "source_fields": []}
        with self.assertRaises(ValidationError):
            self.load()

    def test_raw_runtime_metadata_is_rejected_even_without_a_review(self):
        self.item()["technical_basis"] = {"projection_version": 1}
        with self.assertRaises(ValidationError):
            self.load()

    def test_stale_review_hash_is_rejected_without_a_projection_marker(self):
        self.set_review([{"label": "Service", "value": "Reviewed service"}])
        self.item()["technical_field_review"]["pre_review_fields_sha256"] = "0" * 64
        with self.assertRaises(ValidationError):
            self.load()

    def test_manual_link_fingerprint_uses_unchanged_sources_after_projection(self):
        raw = deepcopy(self.item())
        raw["fields"].extend([
            {"label": "Lead Time", "value": "Private lead-time marker"},
            {"label": "Max Opening Size", "value": "Annular Gap up to 12mm"},
            {"label": "Installation concept", "value": "Figure A", "images": [{"id": "diagram-a", "caption": "A"}]},
        ])
        before = deepcopy(raw)
        projected = normalize_technical_item(raw)
        self.assertEqual(raw, before)
        self.assertEqual(projected["sources"], raw["sources"])
        self.assertEqual(FirestoppingLibrary._technical_source(raw, self.data),
                         FirestoppingLibrary._technical_source(projected, self.data))

    def test_lead_time_and_hidden_basis_do_not_enter_search(self):
        self.item()["fields"].extend([
            {"label": "Lead Time", "value": "UniqueRemovedLeadMarker"},
            {"label": "Source table notes", "value": "UniqueHiddenBasisMarker"},
        ])
        library = self.load()
        for text in ["UniqueRemovedLeadMarker", "UniqueHiddenBasisMarker"]:
            with self.subTest(search=text):
                self.assertEqual(library.listing("technical", search=text)["total"], 0)
        labels = {field["label"] for field in library.detail("technical", "report-a-v1")["fields"]}
        self.assertNotIn("Lead Time", labels)
        self.assertNotIn("Source table notes", labels)


if __name__ == "__main__":
    unittest.main()
