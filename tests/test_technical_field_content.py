"""Synthetic ownership cases; no supplier-document text or assets are fixtures."""

from copy import deepcopy
import unittest

from estimator.technical_field_content import normalize_content


def values(fields, label):
    return "\n\n".join(field.get("value", "") for field in fields if field.get("label") == label)


class TechnicalFieldContentTests(unittest.TestCase):
    def test_moves_complete_service_configuration_without_losing_equivalents(self):
        fields = [{"label": "Service", "value": "Copper pipes up to DN60:\nDN20, 22 mm OD, minimum wall 1 mm.\nEquivalent listed sizes permitted."}]
        original = deepcopy(fields)
        result = normalize_content(fields)
        self.assertEqual(values(result, "Service"), "Copper pipes")
        self.assertEqual(values(result, "Service Size / Configuration"), fields[0]["value"])
        self.assertEqual(fields, original)

    def test_does_not_add_derived_category_when_explicit_service_exists(self):
        fields = [{"label": "Service", "value": "Pipes - Copper, Pipes - Steel"},
                  {"label": "Service", "value": "1x DN60 Copper pipe, 2x DN40 Copper pipes"}]
        result = normalize_content(fields)
        self.assertEqual(values(result, "Service"), "Pipes - Copper, Pipes - Steel")
        self.assertIn("DN60", values(result, "Service Size / Configuration"))

    def test_service_conditions_move_with_action_not_just_their_numbers(self):
        fields = [{"label": "Service", "value": "Bundle of up to 3 copper pipes.\nNOTE:\n• Where close to an edge, increase the wrap to 450 mm on both sides.\n• Other listed copper sizes may be used."}]
        result = normalize_content(fields)
        self.assertIn("Where close to an edge", values(result, "Service Wrap"))
        self.assertIn("450 mm on both sides", values(result, "Service Wrap"))
        self.assertIn("Other listed", values(result, "Service Size / Configuration"))

    def test_mixed_explicit_source_keys_have_distinct_owners(self):
        fields = [{"label": "Installation Details", "source_labels": ["Service / core hole / annular gap (Source Reference)"],
                   "value": "Service/s: 75mm PVC Pipe; Core Hole: 90mm; Annular Gap: 0-4mm; FRL: -/60/60. Fire Barrier: 100mm concrete wall."}]
        result = normalize_content(fields)
        self.assertEqual(values(result, "Service Size / Configuration"), "75mm PVC Pipe")
        self.assertEqual(values(result, "Core Hole Diameter"), "90mm")
        self.assertEqual(values(result, "Annular Gap"), "0-4mm")
        self.assertEqual(values(result, "FRL"), "-/60/60")
        self.assertEqual(values(result, "Barrier Construction"), "100mm concrete wall")
        self.assertEqual(values(result, "Maximum Opening Size"), "")

    def test_mixed_source_trailing_instruction_survives(self):
        result = normalize_content([{"label": "Installation Details", "source_labels": ["Service / core hole / annular gap (Source Reference)"],
                                     "value": "Service/s: 75mm PVC Pipe; FRL: -/60/60. Install two collars in the specified orientation."}])
        self.assertEqual(values(result, "Installation Details"), "Install two collars in the specified orientation.")

    def test_only_gap_value_is_not_a_maximum_opening(self):
        result = normalize_content([{"label": "Maximum Opening Size", "value": "Annular Gap up to 15mm"}])
        self.assertEqual(values(result, "Annular Gap"), "up to 15mm")

    def test_repeated_action_is_owned_once_and_step_keeps_reference(self):
        text = "Apply ExampleWrap for 450 mm on the upper side; fix with ties at 100 mm centres."
        fields = [{"label": "Service Wrap", "value": text}, {"label": "Installation Details", "value": "1. Fit the seal.\n2. " + text + "\n3. Check the assembly."}]
        result = normalize_content(fields)
        self.assertEqual(values(result, "Service Wrap"), text)
        self.assertIn("2. Apply the Service Wrap requirements.", values(result, "Installation Details"))
        self.assertNotIn("450", values(result, "Installation Details"))

    def test_repeated_service_size_removed_from_procedure_only(self):
        result = normalize_content([{"label": "Service Size / Configuration", "value": "75mm PVC pipe without a socket"},
                                    {"label": "Installation Details", "value": "The 75mm PVC pipe passes through the opening. Fit the collar."}])
        self.assertEqual(values(result, "Installation Details"), "The specified service passes through the opening. Fit the collar.")
        self.assertIn("without a socket", values(result, "Service Size / Configuration"))

    def test_multiple_service_identities_remain_attached_to_their_actions(self):
        procedure = "Fit the collar around the 32mm PVC pipe. Wrap the 50mm copper pipe."
        result = normalize_content([
            {"label": "Service Size / Configuration", "value": "32mm PVC pipe and 50mm copper pipe"},
            {"label": "Installation Details", "value": procedure},
        ])
        self.assertEqual(values(result, "Installation Details"), procedure)
        self.assertNotIn("specified service", values(result, "Installation Details"))

    def test_conflicting_source_service_sizes_keep_source_specific_actions(self):
        procedure = "The 110mm HDPE pipe passes through the opening."
        result = normalize_content([
            {"label": "Service Size / Configuration", "value": "100mm HDPE Pipe without elbow or socket"},
            {"label": "Service Size / Configuration", "value": "110mm HDPE Pipe"},
            {"label": "Installation Details", "value": procedure},
        ])
        self.assertEqual(values(result, "Installation Details"), procedure)

    def test_conditional_wrap_pairing_is_not_erased(self):
        wrap = "300mm for PEX up to 20mm and 450mm for PEX up to 32mm."
        result = normalize_content([{"label": "Service Size / Configuration", "value": "PEX pipe up to 32mm"},
                                    {"label": "Service Wrap", "value": wrap},
                                    {"label": "Installation Details", "value": "For a 32mm PEX pipe use the longer wrap."}])
        self.assertEqual(values(result, "Service Wrap"), wrap)
        self.assertIn("32mm", values(result, "Installation Details"))

    def test_protection_content_not_blindly_relabelled(self):
        result = normalize_content([{"label": "Protection", "value": "One layer of Penowrap for 450 mm."},
                                    {"label": "Protection", "value": "Apply a 30 mm mastic fillet at the rod base."},
                                    {"label": "Protection", "value": "None"}])
        self.assertIn("Penowrap", values(result, "Service Wrap"))
        self.assertIn("rod base", values(result, "Local Protection"))
        self.assertEqual(values(result, "Protection"), "None")

    def test_numbered_wrap_procedure_is_owned_by_service_wrap(self):
        procedure = "1. Install one layer of Penowrap for 450 mm on the upper side.\n2. Secure with ties.\n3. Seal the wrap to the face of the board."
        result = normalize_content([{"label": "Protection", "value": procedure}])
        self.assertEqual(values(result, "Service Wrap"), procedure)
        self.assertEqual(values(result, "Installation Details"), "")

    def test_mixed_board_and_wrap_procedure_preserves_installation_sequence(self):
        procedure = "1. Cut strips of board 50 mm wide.\n2. Form a board collar around the service.\n3. Wrap the service with Penowrap."
        result = normalize_content([{"label": "Protection", "value": procedure}])
        self.assertEqual(values(result, "Installation Details"), procedure)
        self.assertEqual(values(result, "Service Wrap"), "")

    def test_negations_conflicts_and_nested_tables_are_preserved(self):
        table = {"columns": ["Service", "Wrap", "FRL"], "rows": [["pipe A", "100 mm", "-/60/60"], ["pipe B", "200 mm", "-/90/90"]]}
        fields = [{"label": "Service Wrap", "value": "Wrap not required."},
                  {"label": "Service Wrap", "value": "Wrap required."},
                  {"label": "Service", "value": "Pipes up to 75mm", "tables": [table]}]
        result = normalize_content(fields)
        self.assertIn("not required", values(result, "Service Wrap"))
        self.assertIn("Wrap required", values(result, "Service Wrap"))
        self.assertEqual(result[-1]["tables"], [table])
        self.assertEqual(values(result, "Service Size / Configuration"), "")

    def test_size_indexed_table_moves_intact_to_configuration(self):
        table = {"columns": ["Service (purlin size)", "Wrap length", "FRL", "PDF page"],
                 "rows": [["120 10", "300 mm", "-/60/60", "4"], ["120 10", "450 mm", "-/90/90", "5"]]}
        fields = [{"label": "Service", "value": "Steel purlins", "table": table},
                  {"label": "Service Wrap", "value": "Size-specific lengths and their FRLs are preserved in the Service table."}]
        result = normalize_content(fields)
        configuration = next(field for field in result if field["label"] == "Service Size / Configuration")
        self.assertEqual(configuration["tables"], [table])
        self.assertEqual(values(result, "Service"), "Steel purlins")
        self.assertIn("Service Size / Configuration table", values(result, "Service Wrap"))
        self.assertEqual(normalize_content(result), result)

    def test_idempotent_and_preserves_images(self):
        fields = [{"label": "Service", "value": "Copper pipes up to DN60."},
                  {"label": "Service Wrap", "value": "Wrap fixed with 3 ties at 100 mm centres."},
                  {"label": "Service Wrap", "value": "Wrap fixed with 3 ties at 100mm centres."},
                  {"label": "Diagrams & Figures", "value": "Figure A", "images": [{"id": "image-A", "caption": "A"}]}]
        result = normalize_content(fields)
        self.assertEqual(normalize_content(result), result)
        self.assertEqual(next(f for f in result if f["label"] == "Diagrams & Figures")["images"], fields[-1]["images"])

    def test_bare_bundle_category_is_stable(self):
        fields = [{"label": "Service", "value": "Aircon bundle consisting of up to 2 copper pipes."}]
        result = normalize_content(fields)
        self.assertEqual(normalize_content(result), result)
        self.assertEqual(values(result, "Service"), "Aircon bundle")

    def test_qualified_configuration_owns_bare_duplicate(self):
        fields = [{"label": "Service Size / Configuration", "value": "75mm PVC Pipe without a socket"},
                  {"label": "Service Size / Configuration", "value": "75 mm PVC Pipe"}]
        result = normalize_content(fields)
        self.assertEqual(values(result, "Service Size / Configuration"), "75mm PVC Pipe without a socket")

    def test_control_joint_width_is_owned_by_opening_only(self):
        fields = [{"label": "Service", "value": "Control Joint"},
                  {"label": "Service Size / Configuration", "value": "Up to 35 mm joint"},
                  {"label": "Maximum Opening Size", "value": "Up to 35mm joint"}]
        result = normalize_content(fields)
        self.assertEqual(values(result, "Service Size / Configuration"), "")
        self.assertEqual(values(result, "Maximum Opening Size"), "Up to 35mm joint")
        fields[1]["value"] = "Up to 45mm joint"
        self.assertEqual(values(normalize_content(fields), "Service Size / Configuration"), "Up to 45mm joint")


if __name__ == "__main__":
    unittest.main()
