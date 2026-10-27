"""Exact review boundaries and source-preserving public library corrections."""
from copy import deepcopy
from io import BytesIO
import unittest
from unittest.mock import patch

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.library_substrates import canonical_substrate, classify_substrates
from estimator.library_report_links import validate_report_links
from estimator.technical_brand_presentation import present_manufacturer_fields
from estimator.technical_discovery import discovery_facets, present_technical
from estimator.technical_fields import normalize_technical_item
from estimator.technical_item_exports import (prepare_technical_item,
    build_technical_item_xlsx, render_technical_item_pdf)
from estimator.technical_record_corrections import (
    BOSS_3391_CONSTRUCTION, REPORT_CAPTION_CORRECTIONS, correct_report_captions,
    fingerprint, reviewed_boss_construction, reviewed_promat_table,
)


class ReportCaptionReviewTests(unittest.TestCase):
    def record(self, brand, caption, url):
        return {'id': 'source', 'subtitle': caption,
            'filter_values': {'manufacturer': [brand], 'document': [caption]},
            'fields': [{'label': 'Report Number', 'value': caption,
                        'report_links': [{'label': caption, 'url': url}]}],
            'technical_basis': {'source_fields': [{'label': 'Report Number', 'value': caption}]}}

    def test_each_reviewed_link_changes_caption_and_discovery_without_changing_source(self):
        for brand, old, url, new in REPORT_CAPTION_CORRECTIONS:
            with self.subTest(brand=brand, caption=old):
                item = self.record(brand, old, url)
                before = deepcopy(item)
                result = correct_report_captions(item)
                self.assertEqual(item, before)
                self.assertEqual(result['fields'][0]['value'], new)
                self.assertEqual(result['fields'][0]['report_links'], [{'label': new, 'url': url}])
                validate_report_links(result['fields'][0])
                self.assertEqual(result['filter_values']['document'], [new])
                self.assertEqual(result['technical_basis'], before['technical_basis'])
                self.assertEqual(correct_report_captions(result), result)

    def test_unreviewed_brand_caption_or_url_never_reuses_review(self):
        brand, old, url, _ = REPORT_CAPTION_CORRECTIONS[0]
        for change in (lambda x:x['filter_values'].update(manufacturer=['Other']),
                       lambda x:x['fields'][0]['report_links'][0].update(url=url+'?changed=1'),
                       lambda x:x['fields'][0].update(value='Other report'),
                       lambda x:x['fields'][0].pop('report_links')):
            item = self.record(brand, old, url)
            change(item)
            self.assertIs(correct_report_captions(item), item)

    def test_two_aliases_to_same_report_collapse_in_order_and_preserve_other_report(self):
        brand, old, url, new = REPORT_CAPTION_CORRECTIONS[3]
        other_old = REPORT_CAPTION_CORRECTIONS[4][1]
        item = self.record(brand, old, url)
        item['fields'][0]['value'] += '\nOTHER\n'+other_old
        item['fields'][0]['report_links'] += [{'label':'OTHER','url':'https://media.promat.com/other.pdf'},
                                            {'label':other_old,'url':url}]
        item['filter_values']['document'] += ['OTHER', other_old]
        result = correct_report_captions(item)
        self.assertEqual(result['fields'][0]['value'], new+'\nOTHER')
        self.assertEqual([x['label'] for x in result['fields'][0]['report_links']], [new, 'OTHER'])
        self.assertEqual(result['filter_values']['document'], [new, 'OTHER'])

    def test_pdf_and_workbook_keep_corrected_caption_and_same_report_hyperlink(self):
        brand, old, url, new = REPORT_CAPTION_CORRECTIONS[0]
        item = self.record(brand, old, url)
        item.update(title='Example system', subtitle='', sources=[])
        projected = correct_report_captions(item)
        class Library:
            def detail(self, kind, key):
                return projected
        snapshot = prepare_technical_item({'id':'source'}, library=Library())
        pdf = PdfReader(BytesIO(render_technical_item_pdf(snapshot)))
        text = '\n'.join(page.extract_text() for page in pdf.pages)
        self.assertIn(new, text)
        self.assertNotIn(old, text)
        self.assertIn(url, [a.get_object().get('/A', {}).get('/URI') for p in pdf.pages
                            for a in p.get('/Annots', [])])
        workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)))
        cells = [cell for sheet in workbook for row in sheet for cell in row]
        self.assertIn(new, [cell.value for cell in cells])
        self.assertNotIn(old, [cell.value for cell in cells])
        self.assertIn(url, [cell.hyperlink.target for cell in cells if cell.hyperlink])


class MergedCellReviewTests(unittest.TestCase):
    def table(self):
        return {'columns': ['ID', 'Barrier Construction', 'FRL', 'Annular Gap', 'Installation Details'],
                'rows': [['seal', 'PROMASEAL® Bulkhead Batt (Double Layer), ≥100', '-/120/120', '', ''],
                         ['wall-a', 'FR Plasterboard 2 x 13mm each face, ≥116', '-/120/120', 'Width: 10 mm - 20 mm', ''],
                         ['wall-b', 'FR Plasterboard 2 x 13mm each face, ≥116', '-/120/120', '', 'Batt Location: Both in Wall or One each Face'],
                         ['wall-c', 'FR Plasterboard 2 x 16mm each face, ≥128', '-/60/60', '', 'Batt Location: Both in Wall or One each Face']]}

    def test_fills_only_reviewed_host_cells_and_keeps_source_rows(self):
        table = self.table()
        before = deepcopy(table)
        with patch('estimator.technical_record_corrections._PROMAT_MERGED_CELLS', {fingerprint(table)}):
            result = reviewed_promat_table(table)
            self.assertEqual(table, before)
            self.assertEqual(result['rows'][0], table['rows'][0])
            for row in result['rows'][1:]:
                self.assertEqual(row[3:], ['Width: 10 mm - 20 mm', 'Batt Location: Both in Wall or One each Face'])
            self.assertEqual(reviewed_promat_table(result), result)

    def test_changed_source_or_unreviewed_table_is_not_filled(self):
        table = self.table()
        with patch('estimator.technical_record_corrections._PROMAT_MERGED_CELLS', {fingerprint(table)}):
            table['rows'][1][3] = 'Width: 5 mm'
            self.assertIs(reviewed_promat_table(table), table)
        unreviewed = self.table()
        self.assertIs(reviewed_promat_table(unreviewed), unreviewed)

    def test_completed_duplicate_display_rows_merge_but_distinct_conditions_survive(self):
        table = self.table()
        source = {'id': 'sample', 'filter_values': {'manufacturer': ['Promat']},
                  'fields': [{'label':'Barrier Construction','value':'Aperture seal: PROMASEAL® Bulkhead Batt, Thickness: 2x50mm'},
                             {'label':'Service Size / Configuration','value':'', 'table':table,
                              'table_row_ids':[[row[0] for row in table['rows']]]}]}
        before = deepcopy(source)
        with patch('estimator.technical_record_corrections._PROMAT_MERGED_CELLS', {fingerprint(table)}):
            result = normalize_technical_item(source)
        shown = next(f for f in result['fields'] if 'table' in f)
        self.assertEqual(source, before)
        self.assertEqual([row[0] for row in shown['table']['rows']], ['wall-a','wall-c'])
        self.assertEqual(shown['table_row_ids'], [['wall-a','wall-c']])
        self.assertEqual(result['technical_basis']['source_fields'], source['fields'])


class UserConstructionAndSearchGroupTests(unittest.TestCase):
    def source(self):
        return {'id':'boss-bf-3391','filter_values':{'manufacturer':['BOSS']},
                'boss_matrix_source':{'approved_substrate_columns':[]},
                'fields':[{'label':'Barrier Type','value':'Wall'},
                          {'label':'Barrier Construction','value':'No approved substrate is marked in matrix columns K–AQ.'},
                          {'label':'Report Number','value':'PF25016 Rev 2'}]}

    def test_user_assigned_construction_and_substrate_are_source_bound(self):
        source = self.source()
        before = deepcopy(source)
        with patch('estimator.technical_record_corrections._BOSS_3391_SOURCE', fingerprint(source['fields'])):
            shown = normalize_technical_item(source)
            self.assertEqual(next(f['value'] for f in shown['fields'] if f['label']=='Barrier Construction'), BOSS_3391_CONSTRUCTION)
            self.assertEqual(classify_substrates(source, shown), ['Plasterboard wall'])
            self.assertEqual(present_manufacturer_fields(deepcopy(shown)), shown)
            source['fields'][2]['value'] = 'Changed report'
            self.assertIsNone(reviewed_boss_construction(source))
        self.assertEqual(before['fields'], shown['technical_basis']['source_fields'])

    def test_search_aliases_do_not_change_source_construction_or_base_facets(self):
        item = {'id':'sample','fields':[{'label':'Barrier Construction','value':'Solid gypsum block wall, 100 mm'}],
                'filter_values':{'substrate':['Rigid wall','Solid gypsum block wall','Hebel wall']}}
        before = deepcopy(item)
        self.assertEqual(discovery_facets(item)['substrate'], ['Concrete/masonry wall','Hebel wall'])
        shown = present_technical(item)
        self.assertEqual(shown['filter_values']['substrate'], ['Concrete/masonry wall','Hebel wall'])
        self.assertEqual(shown['fields'], item['fields'])
        self.assertEqual(item, before)
        self.assertEqual(canonical_substrate('Concrete/masonry floor'), 'Concrete/masonry floor')


if __name__ == '__main__':
    unittest.main()
