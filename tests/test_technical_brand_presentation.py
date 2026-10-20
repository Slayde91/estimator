"""Display cleanup preserves source evidence, conditions and export parity."""

from copy import deepcopy
from io import BytesIO
import unittest

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.technical_brand_presentation import simplify_promat_wrap
from estimator.technical_fields import normalize_technical_item
from estimator.technical_item_exports import (prepare_technical_item,
    build_technical_item_xlsx, render_technical_item_pdf)
from estimator.technical_table_navigation import validate_table_navigation
from scripts.import_boss_matrix import bind_review


def record(*fields, brand='Promat'):
    return {'id': 'sample', 'title': 'Sample',
            'filter_values': {'manufacturer': [brand]},
            'fields': [{'label': label, 'value': value} for label, value in fields]}


def values(item):
    return {field['label']: field['value'] for field in item['fields']}


class BrandPresentationTests(unittest.TestCase):
    def project(self, source):
        before = deepcopy(source)
        reviewed = deepcopy(source)
        if 'technical_field_review' not in reviewed:
            bind_review(reviewed)
        result = normalize_technical_item(reviewed)
        self.assertEqual(source, before)
        self.assertEqual(result['technical_basis']['source_fields'], before['fields'])
        self.assertEqual(normalize_technical_item(result), result)
        validate_table_navigation(result['fields'])
        return result

    def test_boss_product_names_without_codes_after_fingerprint_validation(self):
        source = record(('System Products', 'Product Alpha\nProduct Beta\nProduct code: A, B\nCollar / wrap component code: C'), brand='BOSS')
        bind_review(source)
        result = self.project(source)
        self.assertEqual(values(result)['System Products'], 'Product Alpha\nProduct Beta')
        self.assertEqual(result['technical_basis']['review'], source['technical_field_review'])

    def test_other_brands_and_mixed_manufacturers_unchanged(self):
        source = record(('System Products', 'Product code: A'),
                        ('Service Wrap', 'Wrap; Configuration: 600mm; Floor - upperside'), brand='Other')
        self.assertEqual(values(self.project(source)), values(source))
        source['filter_values']['manufacturer'] = ['BOSS', 'Other']
        self.assertEqual(values(self.project(source)), values(source))

    def test_wrap_brevity_retains_dimensions_classes_and_conflicting_sides(self):
        cases = {
            'PROMASEAL SupaWrap; Configuration: 600mm Top Side Only; Floor - upperside': 'PROMASEAL SupaWrap; 600mm Top Side Only.',
            'Wrap; Configuration: 600mm Each Face; Wall - both sides 600mm Long': 'Wrap; 600mm Each Face.',
            'Wrap; Configuration: 300mm Each Face; Wall - both sides 600mm Long': 'Wrap; 300mm Each Face; 600mm Long.',
            'Wrap; Thickness: 600mm; Configuration: 300mm Each Face; Wall - both sides 600mm Long': 'Wrap; Thickness: 600mm; 300mm Each Face; 600mm Long.',
            'Wrap; Wall - both sides 925mm both faces': 'Wrap; 925mm both faces.',
            'Wrap; Thickness: 40 mm; Configuration: LI (300mm on top side)': 'Wrap; Thickness: 40 mm; LI (300mm on top side).',
            'Armaflex; Configuration: LI (400mm on both sides); Class: FR Armaflex 25mm; Wall - both sides 400mm Long': 'Armaflex; LI (400mm on both sides); Class: FR Armaflex 25mm.',
            'Wrap; Configuration: 800mm Top Side Only; Floor - both sides': 'Wrap; 800mm Top Side Only; Floor - both sides.',
            'Wrap; Configuration: 300mm Top Side Only; Floor - both sides 600mm Long': 'Wrap; 300mm Top Side Only; Floor - both sides 600mm Long.',
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(simplify_promat_wrap(source), expected)
                self.assertEqual(simplify_promat_wrap(expected), expected)

    def test_only_requested_boilerplate_removed_and_real_instructions_retained(self):
        source = record(('Service Size / Configuration', 'ø 20, Floor - Vertical\n\nExisting insulation: None'),
                        ('Installation Details', 'Service configuration: Floor - Vertical; Existing insulation: None.\n\n'
                         'Pass the vertical cable tray through the double batt floor seal and fit wrap above slab.\n\n'
                         'Fit two anchors, 20 x 5mm, at 150mm centres.\n\n'
                         'Annular gap: 10mm. Service wrap: Wrap; Configuration: 600mm Top Side Only; Floor - upperside.\n\n'
                         'Fire exposure: Floor - fire from below. Test standard: AS1530.4. Location: Top.'))
        actual = values(self.project(source))
        self.assertEqual(actual['Service Size / Configuration'], 'ø 20')
        self.assertEqual(actual['Installation Details'], 'Fit two anchors, 20 x 5mm, at 150mm centres.\n\n'
                         'Annular gap: 10mm. Service wrap: Wrap; 600mm Top Side Only.\n\nLocation: Top.')
        for text in ('ø 32, Wall - Horizontal, Retrofit - Stack',
                     'ø 32, Wall - Horizontal, Cast In - Floor Waste',
                     'Existing insulation: None Armaflex 25mm',
                     'Existing insulation: Combustible insulation 13mm'):
            actual = values(self.project(record(('Service Size / Configuration', text))))['Service Size / Configuration']
            self.assertEqual(actual, text.replace('Wall - Horizontal, ', ''))
        actual = values(self.project(record(('Service Size / Configuration', '100 mm\n\nFloor - Vertical - Cast In - Floor Waste'))))
        self.assertEqual(actual['Service Size / Configuration'], '100 mm\n\nCast In - Floor Waste')

    def test_standard_removal_preserves_trailing_installation_requirements(self):
        for tail in ('Use 2 x 13mm board, or 25mm board.', 'Seal deck voids.',
                     'Both batts on top or one top and one friction fit.', '\nFriction Fit within Opening'):
            source = record(('Installation Details', 'Fire exposure: Floor - fire from below. Test standard: AS1530.4. ' + tail))
            self.assertEqual(values(self.project(source))['Installation Details'], tail.strip())

    def test_rating_only_table_uses_highest_and_removes_navigation(self):
        source = record(('Service Size / Configuration', 'ø 20, Floor - Vertical'), ('FRL', '-/30/30 to -/120/120'))
        source['fields'][0].update(table={'columns': ['ID', 'FRL'],
            'rows': [['a', '-/90/90'], ['b', '-/60/60'], ['c', '-/30/30'], ['d', '-/120/120']]},
            table_row_ids=[['a', 'b', 'c', 'd']])
        source['fields'][1]['table_links'] = [{'field': 'Service Size / Configuration', 'table_index': 0}]
        result = self.project(source)
        self.assertEqual(values(result)['FRL'], '-/120/120')
        self.assertEqual(values(result)['Service Size / Configuration'], 'ø 20')
        self.assertFalse(any(field.get('table_links') or field.get('table') for field in result['fields']))

    def test_qualified_or_incomparable_ratings_keep_their_table(self):
        for ratings in (['-/120/60', '-/90/90'], ['-/60/60 if insulated', '-/120/120']):
            source = record(('Service Size / Configuration', 'ø 20'))
            source['fields'][0]['table'] = {'columns': ['ID', 'FRL'], 'rows': [[str(n), rating] for n, rating in enumerate(ratings)]}
            self.assertEqual(self.project(source)['fields'][0]['table'], source['fields'][0]['table'])

    def test_visible_duplicate_rows_merge_without_losing_distinct_requirements(self):
        source = record(('Service Size / Configuration', ''))
        source['fields'][0].update(table={'columns': ['ID', 'FRL', 'Seal Depth / Fillet Size'],
            'rows': [['a', '-/120/120', '20mm'], ['b', '-/120/120', '20mm'], ['c', '-/120/120', '25mm']]},
            table_row_ids=[['a', 'b', 'c']], table_captions=['Paired requirements'])
        table = self.project(source)['fields'][0]
        self.assertEqual(table['table']['rows'], [['a', '-/120/120', '20mm'], ['c', '-/120/120', '25mm']])
        self.assertEqual(table['table_row_ids'], [['a', 'c']])
        self.assertEqual(table['table_captions'], ['Paired requirements'])

    def test_only_redundant_seal_product_rows_removed_not_real_barrier_rows(self):
        source = record(('Barrier Construction', 'Concrete Slab\n\nAperture seal: PROMASEAL® Bulkhead Batt, Thickness: 2x50mm'),
                        ('Service Size / Configuration', ''), ('FRL', '-/120/120'))
        source['fields'][1]['table'] = {'columns': ['ID', 'Barrier Construction', 'FRL', 'Installation Details', 'Annular Gap'],
            'rows': [['a', 'PROMASEAL® Bulkhead Batt (Double Layer), ≥100', '-/120/120', '', ''],
                     ['b', 'Concrete Slab, ≥120', '-/120/120', 'Both in slab', ''],
                     ['c', 'FR Plasterboard, ≥116', '-/120/120', '', '10–20mm']]}
        result = self.project(source)
        table = next(field['table'] for field in result['fields'] if 'table' in field)
        self.assertEqual([row[0] for row in table['rows']], ['b', 'c'])
        self.assertEqual(table['rows'][1][3:], ['—', '10–20mm'])
        # A seal row with a distinct rating cannot be removed on this basis.
        source['fields'][1]['table']['rows'][0][2] = '-/240/240'
        result = self.project(source)
        table = next(field['table'] for field in result['fields'] if 'table' in field)
        self.assertEqual(table['rows'][0][0:3], ['a', 'PROMASEAL® Bulkhead Batt (Double Layer), ≥100', '-/240/240'])

    def test_table_links_reindex_after_rating_table_removed(self):
        source = record(('Service Size / Configuration', 'ø 20'), ('FRL', '-/120/120'), ('Collar', ''))
        source['fields'][0].update(tables=[{'columns': ['ID', 'FRL'], 'rows': [['a', '-/120/120']]},
            {'columns': ['ID', 'Collar'], 'rows': [['a', 'Type A'], ['b', 'Type B']]}],
            table_row_ids=[['a'], ['a', 'b']], table_captions=['Ratings', 'Collars'])
        source['fields'][2]['table_links'] = [{'field': 'Service Size / Configuration', 'table_index': 1}]
        result = self.project(source)
        self.assertEqual(next(f for f in result['fields'] if f['label'] == 'Collar')['table_links'],
                         [{'field': 'Service Size / Configuration', 'table_index': 0}])

    def test_pdf_and_excel_use_same_cleaned_fields(self):
        for source, forbidden, expected in [
            (record(('System Products', 'Product Alpha\nProduct code: A'), brand='BOSS'), 'Product code:', 'Product Alpha'),
            (record(('Service Wrap', 'Wrap; Configuration: 600mm Top Side Only; Floor - upperside')),
             'Configuration:', 'Wrap; 600mm Top Side Only.')]:
            projected = self.project(source)
            class Library:
                def detail(self, kind, key):
                    return projected
            snapshot = prepare_technical_item({'id': 'sample'}, library=Library())
            pdf = '\n'.join(page.extract_text() for page in PdfReader(BytesIO(render_technical_item_pdf(snapshot))).pages)
            workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)))
            xlsx = '\n'.join(str(cell.value) for sheet in workbook for row in sheet for cell in row if cell.value)
            for text in (pdf, xlsx):
                self.assertIn(expected, text)
                self.assertNotIn(forbidden, text)


if __name__ == '__main__':
    unittest.main()
