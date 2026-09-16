"""Editable yield labels preserve coverage arithmetic and legacy file exchanges."""

from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

from openpyxl import load_workbook

from estimator.calculator import calculate
from estimator.catalog import baseline, effective_catalog, validate_catalog, ValidationError, yield_unit
from estimator.pricing_workbook import export_pricing_workbook, import_pricing_workbook, _serialize_exact
from estimator.storage import Store


class PricingUnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = export_pricing_workbook({})

    def test_every_export_cell_is_centred_and_units_are_aligned_per_use(self):
        book = load_workbook(BytesIO(self.payload))
        sheet = book['Inventory & Rates']
        headers = {cell.value: cell.column for cell in sheet[1]}
        for page in book:
            for row in page:
                for cell in row:
                    self.assertEqual((cell.alignment.horizontal, cell.alignment.vertical), ('center', 'center'))
        product = next(row[0].row for row in sheet if sheet.cell(row[0].row, headers['Inventory ID']).value == '204')
        self.assertEqual(sheet.cell(product, headers['Yield unit']).value, 'm² / unit;m² / unit')
        self.assertEqual(headers['Yield unit'], headers['Yield'] + 1)
        result = import_pricing_workbook(self.payload, 'pricing.xlsx', {})
        self.assertEqual(result['summary']['rates']['updated'], 0)
        book.close()

    def test_independent_units_and_yields_survive_export_without_converting_values(self):
        catalog = baseline()
        catalog['rate_groups']['primers'][0]['yield_unit'] = 'm² / drum; coverage'
        catalog['rate_groups']['topcoats'][0]['yield_unit'] = 'm² / 20 kg'
        configuration = {'catalog': catalog, 'rates': {'primers:1': {'yield': 71, 'price': 401.25}}}
        inputs = {'D20': '20kg SBR Latex - Promat', 'B20': 142, 'D21': '20kg SBR Latex - Promat', 'B21': 142}
        before = calculate(inputs, configuration)
        exported = export_pricing_workbook(configuration)
        after = import_pricing_workbook(exported, 'pricing.xlsx', configuration)
        self.assertEqual(after['summary']['rates']['updated'], 0)
        rates = effective_catalog(after['configuration'])['rate_groups']
        self.assertEqual(rates['primers'][0]['yield_unit'], 'm² / drum; coverage')
        self.assertEqual(rates['topcoats'][0]['yield_unit'], 'm² / 20 kg')
        self.assertEqual(calculate(inputs, after['configuration'])['cells'], before['cells'])

    def test_earlier_compact_workbook_without_unit_column_still_imports(self):
        book = load_workbook(BytesIO(self.payload))
        book['Inventory & Rates'].delete_cols(12)
        book['Inventory & Rates'].auto_filter.ref = 'A1:AA418'
        result = import_pricing_workbook(_serialize_exact(book), 'older-pricing.xlsx', {})
        self.assertEqual(result['summary']['rates']['updated'], 0)
        self.assertEqual(result['summary']['inventory']['updated'], 0)
        book.close()

    def test_invalid_unit_metadata_is_rejected_before_persistence(self):
        for group, value in [('primers', 42), ('primers', 'x' * 101), ('labour_rates', 'm² / unit')]:
            catalog = baseline()
            catalog['rate_groups'][group][0]['yield_unit'] = value
            with self.subTest(group=group, value=value), self.assertRaises(ValidationError):
                validate_catalog(catalog)
        self.assertEqual(yield_unit('mastic', baseline()['rate_groups']['mastic'][0]), 'm / unit')

    def test_saved_library_and_reset_persist_across_restart_without_mutating_quotes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'library.sqlite3'
            store = Store(path)
            custom = {'inventory': {'204': {'supplier_price': 300}}, 'rates': {'primers:1': {'yield': 71}}}
            store.save_configuration(custom)
            quote = store.save_quote({'title': 'Frozen library', 'inputs': {'D20': '20kg SBR Latex - Promat', 'B20': 142}})
            self.assertEqual(Store(path).configuration(), custom)
            store.save_configuration({'inventory': {}, 'rates': {}})
            self.assertEqual(Store(path).configuration(), {'inventory': {}, 'rates': {}})
            self.assertEqual(Store(path).quote(quote['id']), quote)


if __name__ == '__main__':
    unittest.main()
