"""Pricing XLSX round trips, list replacement, and untrusted-file rejection."""

from copy import deepcopy
from io import BytesIO
import json
import hashlib
import math
import xml.etree.ElementTree as ET
from pathlib import Path
import unittest
from zipfile import ZIP_DEFLATED, ZipFile

from openpyxl import load_workbook

from estimator.calculator import calculate
from estimator.catalog import ValidationError, baseline, effective_catalog
from estimator.pricing_workbook import (
    INVENTORY_HEADERS, RATE_HEADERS, export_pricing_workbook,
    import_pricing_workbook, _serialize_exact,
)


def modify(payload, action, *, normal_excel_precision=False):
    workbook = load_workbook(BytesIO(payload))
    action(workbook)
    if normal_excel_precision:
        stream = BytesIO()
        workbook.save(stream)
        result = stream.getvalue()
    else:
        result = _serialize_exact(workbook)
    workbook.close()
    return result


def find(sheet, identity):
    return next(row[0].row for row in sheet.iter_rows(min_row=2) if row[0].value == identity)


def replace_part(payload, name, content):
    output = BytesIO()
    with ZipFile(BytesIO(payload)) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
        for item in source.infolist():
            target.writestr(item.filename, content if item.filename == name else source.read(item.filename))
        if name not in source.namelist():
            target.writestr(name, content)
    return output.getvalue()


class PricingWorkbookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.exported = export_pricing_workbook({})

    def imported(self, payload=None, current=None):
        return import_pricing_workbook(self.exported if payload is None else payload,
                                       "ceasefire-pricing.xlsx", {} if current is None else current)

    def test_export_contains_complete_typed_editable_lists_and_instructions(self):
        workbook = load_workbook(BytesIO(self.exported))
        self.assertEqual(workbook.sheetnames, ["Inventory", "Rates", "Instructions"])
        inventory, rates = workbook["Inventory"], workbook["Rates"]
        self.assertEqual(tuple(cell.value for cell in inventory[1]), INVENTORY_HEADERS)
        self.assertEqual(tuple(cell.value for cell in rates[1]), RATE_HEADERS)
        self.assertEqual((inventory.max_row, rates.max_row), (418, 167))
        self.assertEqual(inventory.freeze_panes, "E2")
        self.assertEqual(rates.auto_filter.ref, "A1:H167")
        self.assertEqual(inventory["G3"].value, 0.3)
        self.assertIn("%", inventory["G3"].number_format)
        self.assertTrue(inventory.data_validations.dataValidation)
        self.assertFalse(any(cell.data_type == "f" for sheet in workbook for row in sheet for cell in row))
        self.assertEqual(inventory.cell(find(inventory, "239"), 8).value,
                         next(item for item in baseline()["inventory"] if item["id"] == "239")["sales_price"])
        workbook.close()

    def test_unchanged_import_preserves_every_calculator_cell_and_reports_no_changes(self):
        result = self.imported()
        empty = {"added": 0, "removed": 0, "updated": 0}
        self.assertEqual(result["summary"], {"inventory": empty, "rates": empty})
        catalog = effective_catalog(result["configuration"])
        for old, new in zip(baseline()["inventory"], catalog["inventory"]):
            for field in ("name", "sales_description", "sales_price", "supplier_price", "markup", "properties"):
                self.assertEqual(old[field], new[field], (old["id"], field))
        fixture_path = Path(__file__).parent / "fixtures" / "excel-calculator-oracle.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8-sig"))
        self.assertEqual(len(fixture["scenarios"]), 216)
        source_index = {}
        for rows in baseline()["rate_groups"].values():
            for rate in rows:
                for field in ("price", "yield"):
                    if source := rate["source"].get(field):
                        source_index[source.replace("Lists!", "")] = (rate["id"], field)
        for case in fixture["scenarios"]:
            config = deepcopy(result["configuration"])
            for source, expected in case.get("lookupOverrides", {}).items():
                rate_id, field = source_index[source.replace("Lists!", "")]
                config["rates"].setdefault(rate_id, {})[field] = expected
            actual = calculate(case["inputs"], config)["cells"]
            for cell, expected in case["expected"].items():
                with self.subTest(scenario=case["id"], cell=cell):
                    if isinstance(expected, (int, float)):
                        self.assertTrue(math.isclose(actual[cell], expected, rel_tol=1e-12, abs_tol=1e-8))
                    else:
                        self.assertEqual(actual[cell], expected)
        self.assertEqual(calculate()["cells"], calculate(configuration=result["configuration"])["cells"])
        self.assertEqual(result["configuration"]["catalog"]["sources"]["pricing_import"],
                         {"filename": "ceasefire-pricing.xlsx", "sha256": hashlib.sha256(self.exported).hexdigest()})

    def test_excel_save_precision_preserves_stored_prices_and_trailing_choice_names(self):
        saved_by_excel = modify(self.exported, lambda workbook: None, normal_excel_precision=True)
        result = self.imported(saved_by_excel)
        self.assertEqual(result["summary"]["inventory"]["updated"], 0)
        self.assertEqual(result["summary"]["rates"]["updated"], 0)
        self.assertEqual(calculate({"D6": "1 Team (sheeting) - 1x "})["cells"],
                         calculate({"D6": "1 Team (sheeting) - 1x "}, result["configuration"])["cells"])

    def test_missing_or_stale_dimensions_do_not_omit_inventory_or_rates(self):
        for dimension in (None, "A1:A1"):
            payload = self.exported
            for part in ("xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"):
                with ZipFile(BytesIO(payload)) as archive:
                    root = ET.fromstring(archive.read(part))
                element = root.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}dimension")
                if dimension is None:
                    root.remove(element)
                else:
                    element.set("ref", dimension)
                payload = replace_part(payload, part, ET.tostring(root, encoding="utf-8"))
            with self.subTest(dimension=dimension):
                result = self.imported(payload)
                catalog = effective_catalog(result["configuration"])
                self.assertEqual(len(catalog["inventory"]), 417)
                self.assertEqual(sum(map(len, catalog["rate_groups"].values())), 166)
                self.assertEqual(result["summary"], {"inventory": {"added": 0, "removed": 0, "updated": 0},
                                                     "rates": {"added": 0, "removed": 0, "updated": 0}})
        with ZipFile(BytesIO(self.exported)) as archive:
            root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        root.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheetData").clear()
        payload = replace_part(self.exported, "xl/worksheets/sheet1.xml", ET.tostring(root, encoding="utf-8"))
        with self.assertRaisesRegex(ValidationError, "headers"):
            self.imported(payload)

    def test_supplier_markup_changes_propagate_without_freezing_exported_rates(self):
        def edit(workbook):
            row = find(workbook["Inventory"], "204")
            workbook["Inventory"].cell(row, 6, 300)
            workbook["Inventory"].cell(row, 7, 0.2)
        result = self.imported(modify(self.exported, edit))
        catalog = effective_catalog(result["configuration"])
        self.assertEqual(result["summary"]["inventory"]["updated"], 1)
        self.assertEqual(result["summary"]["rates"]["updated"], 2)
        for group in ("primers", "topcoats"):
            self.assertEqual(catalog["rate_groups"][group][0]["price"], 360)
        second = self.imported(export_pricing_workbook(result["configuration"]), result["configuration"])
        self.assertEqual(second["summary"]["rates"]["updated"], 0)

    def test_rate_price_changes_become_persistent_overrides_and_can_restore_link(self):
        def edit(workbook):
            workbook["Rates"].cell(find(workbook["Rates"], "primers:1"), 6, 401.25)
        first = self.imported(modify(self.exported, edit))["configuration"]
        catalog = effective_catalog(first)
        self.assertEqual(catalog["rate_groups"]["primers"][0]["price_mode"], "override")
        self.assertEqual(catalog["rate_groups"]["primers"][0]["price"], 401.25)
        changed = deepcopy(first)
        changed["inventory"]["204"] = {"supplier_price": 300}
        catalog = effective_catalog(changed)
        self.assertEqual(catalog["rate_groups"]["primers"][0]["price"], 401.25)
        self.assertEqual(catalog["rate_groups"]["topcoats"][0]["price"], 390)
        def restore(workbook):
            workbook["Rates"].cell(find(workbook["Rates"], "primers:1"), 5, "Inventory")
        restored = self.imported(modify(export_pricing_workbook(changed), restore), changed)
        self.assertEqual(effective_catalog(restored["configuration"])["rate_groups"]["primers"][0]["price"], 390)

    def test_exported_existing_overrides_round_trip_without_loss(self):
        configuration = {"inventory": {"200": {"supplier_price": 99}, "915": {"sales_price": 2222}},
                         "rates": {"boards:1": {"price": 123.45, "yield": 1.2345}}}
        before = deepcopy(configuration)
        result = self.imported(export_pricing_workbook(configuration), configuration)
        self.assertEqual(configuration, before)
        self.assertEqual(result["summary"]["inventory"]["updated"], 0)
        self.assertEqual(result["summary"]["rates"]["updated"], 0)
        inputs = {"B15": 18.75, "B19": 50.5, "D19": baseline()["rate_groups"]["boards"][0]["name"]}
        self.assertEqual(calculate(inputs, configuration)["cells"], calculate(inputs, result["configuration"])["cells"])

    def test_add_remove_products_choices_and_move_group_preserves_explicit_ids(self):
        def edit(workbook):
            inventory, rates = workbook["Inventory"], workbook["Rates"]
            inventory.delete_rows(find(inventory, "200"))
            rates.delete_rows(find(rates, "sprays:2"))
            inventory.append(["new-product", "C-1", "New coating", "New coating", "Supplier markup", 25, 0.2, None] + [None] * 11)
            rates.append([None, "sprays", "new-product", "New coating", "Inventory", None, "Not used", None])
            rates.cell(find(rates, "sprays:3"), 2, "access_panels")
        result = self.imported(modify(self.exported, edit))
        self.assertEqual(result["summary"]["inventory"], {"added": 1, "removed": 1, "updated": 0})
        self.assertEqual(result["summary"]["rates"], {"added": 1, "removed": 1, "updated": 1})
        catalog = effective_catalog(result["configuration"])
        new_rate = next(item for item in catalog["rate_groups"]["sprays"] if item["name"] == "New coating")
        self.assertTrue(new_rate["id"].startswith("rate_"))
        self.assertEqual(new_rate["price"], 30)
        self.assertEqual(calculate({"D15": "New coating", "B15": 2}, result["configuration"])["cells"]["A63"], 30)

    def test_blank_inventory_id_allocates_new_identity_and_independent_rate_is_supported(self):
        def edit(workbook):
            workbook["Inventory"].append([None, "X", "New product", "", "Manual", None, 0, 42] + [None] * 11)
            workbook["Rates"].append([None, "labour_rates", None, "New team", "Override", 1234.56, "Not used", None])
        result = self.imported(modify(self.exported, edit))
        catalog = effective_catalog(result["configuration"])
        self.assertTrue(catalog["inventory"][-1]["id"].startswith("inv_"))
        self.assertEqual(catalog["rate_groups"]["labour_rates"][-1]["price"], 1234.56)

    def test_blank_empty_text_and_numeric_yields_remain_distinct(self):
        for yield_type, value, expected in (("Blank", None, "#DIV/0!"), ("Empty text", None, "#VALUE!"), ("Number", 2.5, 4)):
            def edit(workbook):
                row = find(workbook["Rates"], "mesh:2")
                workbook["Rates"].cell(row, 7, yield_type)
                workbook["Rates"].cell(row, 8).value = value
            result = self.imported(modify(self.exported, edit))
            self.assertEqual(calculate({"D16": "Promat Promamesh", "B16": 10}, result["configuration"])["cells"]["B68"], expected)

    def test_invalid_ids_links_names_headers_numbers_and_yields_are_rejected(self):
        def change(sheet, identity, column, value):
            def edit(workbook):
                workbook[sheet].cell(find(workbook[sheet], identity), column).value = value
            return edit
        invalid = [
            change("Inventory", "200", 1, "204"),
            change("Rates", "sprays:2", 1, "sprays:1"),
            change("Rates", "sprays:2", 4, "N/A"),
            change("Rates", "sprays:2", 3, "missing"),
            change("Rates", "sprays:2", 2, "invented_group"),
            change("Rates", "sprays:2", 7, "Number"),
            change("Rates", "mesh:2", 7, "Blank"),
            change("Inventory", "200", 6, -1),
            change("Inventory", "200", 6, "55"),
            change("Inventory", "200", 6, True),
            change("Inventory", "200", 7, -1.1),
            change("Inventory", "200", 6, 1e13),
            change("Inventory", "200", 8, 123.45),
            lambda workbook: setattr(workbook["Inventory"]["A1"], "value", "Wrong header"),
            lambda workbook: workbook["Inventory"].delete_rows(find(workbook["Inventory"], "200")),
            lambda workbook: workbook["Inventory"].cell(5002, 1, "oversized"),
        ]
        for action in invalid:
            with self.subTest(action=action), self.assertRaises(ValidationError):
                self.imported(modify(self.exported, action))

    def test_formulas_macros_external_links_xml_entities_and_oversized_archives_rejected(self):
        with self.assertRaisesRegex(ValidationError, "formulas"):
            self.imported(modify(self.exported, lambda workbook: setattr(workbook["Inventory"]["F3"], "value", "=1+2")))
        with self.assertRaisesRegex(ValidationError, "Macros"):
            self.imported(replace_part(self.exported, "xl/vbaProject.bin", b"anything"))
        with self.assertRaisesRegex(ValidationError, "External links"):
            self.imported(replace_part(self.exported, "xl/_rels/extra.xml.rels", b'<Relationships><Relationship TargetMode="External" Target="https://invalid.test"/></Relationships>'))
        with self.assertRaisesRegex(ValidationError, "entities"):
            self.imported(replace_part(self.exported, "xl/worksheets/sheet1.xml", b'<!DOCTYPE a [<!ENTITY b "x">]><a>&b;</a>'))
        with self.assertRaisesRegex(ValidationError, "20 MB"):
            self.imported(replace_part(self.exported, "padding.bin", b"0" * (21 * 1024 * 1024)))
        with ZipFile(BytesIO(self.exported)) as archive:
            xml = archive.read("xl/worksheets/sheet1.xml").replace(b">112.5<", b">not-a-number<", 1)
        with self.assertRaisesRegex(ValidationError, "malformed cells"):
            self.imported(replace_part(self.exported, "xl/worksheets/sheet1.xml", xml))
        for content, filename in ((b"garbage", "list.xlsx"), (self.exported, "list.xlsm"), (b"", "list.xlsx")):
            with self.subTest(filename=filename), self.assertRaises(ValidationError):
                import_pricing_workbook(content, filename, {})

    def test_labels_starting_equals_are_exported_as_literal_text(self):
        configuration = {"inventory": {"200": {"name": "=A1+A2"}}}
        payload = export_pricing_workbook(configuration)
        workbook = load_workbook(BytesIO(payload))
        cell = workbook["Inventory"].cell(find(workbook["Inventory"], "200"), 3)
        self.assertEqual((cell.value, cell.data_type), ("=A1+A2", "s"))
        workbook.close()
        self.imported(payload, configuration)


if __name__ == "__main__":
    unittest.main()
