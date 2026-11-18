"""Secondary manufacturer discovery keeps one configuration and its original evidence."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from estimator.storage import Store
from estimator.technical_library_edits import ManualTechnicalLibrary
from estimator.technical_manufacturers import discovery_manufacturers, ryanfire_terms
from estimator.technical_item_exports import prepare_technical_item
from test_firestopping_library import editable_library


class TechnicalManufacturerTests(unittest.TestCase):
    def test_requested_product_terms_accept_source_spellings_and_exclude_other_products(self):
        cases = [('FYREBATT50', 'FyreBATT 50'), ('FyreBATT 50 mm', 'FyreBATT 50'),
                 ('Ryan', 'Ryan'), ('Ryanfire502Board', 'Ryan'), ('Ryan502Batts', 'Ryan'),
                 ('RyanBATT', 'Ryan'), ('RyanSPAN', 'Ryan'), ('FyreMASTICA–R', 'FyreMASTIC A-R'),
                 ('HP‑X', 'HP-X'), ('RyanfireHP-X', 'HP-X'), ('Servowrap', 'Servowrap'),
                 ('RyanfireServowrap', 'Servowrap'), ('servo wrap', 'Servowrap')]
        for value, expected in cases:
            with self.subTest(value=value):
                record = {'fields': [{'label': 'System Products', 'value': value}]}
                self.assertIn(expected, ryanfire_terms(record))
                self.assertEqual(discovery_manufacturers(record, ['Trafalgar']), ['Trafalgar', 'Ryanfire'])
                self.assertEqual(discovery_manufacturers(record, ['Trafalgar','Ryanfire']), ['Trafalgar','Ryanfire'])
        for value in ('FyreBATT 60', 'FyreBATT 500', 'FyreMASTIC HP-R', 'FyreFLEX', 'Ryanology', 'Unrelated item'):
            self.assertEqual(ryanfire_terms({'fields':[{'label':'System Products','value':value}]}),[])
        self.assertEqual(ryanfire_terms({'fields':[{'label':'Source Issues','value':'Reviewer Ryan'}]}),[])

    def test_selected_table_product_evidence_is_included(self):
        record = {'fields': [{'label': 'Service Size / Configuration', 'value': '',
                             'table': {'columns':['Product','Detail'], 'rows':[['Servowrap','300 mm']]}}]}
        self.assertEqual(ryanfire_terms(record), ['Servowrap'])
        original = deepcopy(record)
        self.assertEqual(discovery_manufacturers(record,['Trafalgar']),['Trafalgar','Ryanfire'])
        self.assertEqual(record,original)

    def test_browse_counts_detail_editor_export_and_inspection_share_secondary_manufacturer(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            editable_library(root/'library')
            library = ManualTechnicalLibrary(root/'library',Store(root/'state.sqlite3'))
            base = library.technical_edit('report-a-v1',for_display=False)['record']
            source_bytes = (root/'library/library.json').read_bytes()
            baseline = library.listing('technical')['total']
            originals = {}
            for key, product in (('ryan-reference','FyreBATT50'),('other-reference','FyreBATT 60')):
                record = deepcopy(base)
                record.update(id=key,title=product,source_label='User-created Technical Library item')
                record['filter_values'].update(manufacturer=['Trafalgar'],report=['Sample report'],
                    category=['Plumbing & Hydraulic'],substrate=['Concrete/masonry wall'],orientation=['Vertical'],
                    type=['Core hole'],services=['Copper Pipes'],frl=['-/120/120'])
                record['fields'] = [{'label':'System Products','value':product},
                                    {'label':'Manufacturer','value':'Trafalgar'},
                                    {'label':'Report Number','value':'Sample report'},
                                    {'label':'FRL','value':'-/120/120'}]
                originals[key] = deepcopy(record)
                library.technical_edits.save(key,0,'a'*64,record,created=True)
            all_items = library.listing('technical')
            self.assertEqual(all_items['total'],baseline+2)
            self.assertEqual([r['id'] for r in library.listing('technical',manufacturer='Ryanfire')['items']],['ryan-reference'])
            self.assertEqual(library.listing('technical',manufacturer='Trafalgar')['total'],2)
            counts = {row['name']:row['count'] for row in all_items['counts']['manufacturers']}
            self.assertEqual((counts['Ryanfire'],counts['Trafalgar']),(1,2))
            options = next(f['options'] for f in all_items['filters'] if f['key']=='manufacturer')
            self.assertEqual(sum(o['value']=='Ryanfire' for o in options),1)
            detail = library.detail('technical','ryan-reference')
            editor = library.technical_edit('ryan-reference')['record']
            exported = prepare_technical_item({'id':'ryan-reference'},library=library,
                                             include_diagrams=False,inspection_filters={'manufacturer':'Ryanfire'})
            for item in (detail,editor):
                self.assertEqual(next(f['value'] for f in item['fields'] if f['label']=='Manufacturer'),'Trafalgar\nRyanfire')
            self.assertEqual(detail['inspection_options']['manufacturer'],['Trafalgar','Ryanfire'])
            self.assertEqual(editor['filter_values']['manufacturer'],['Trafalgar','Ryanfire'])
            self.assertTrue(any(f['label']=='Manufacturer' and f['value']=='Ryanfire' for f in exported['fields']))
            stored = library.technical_edits.read()[0]
            for key,record in originals.items():
                self.assertEqual(stored[key]['record'],record)
            self.assertEqual((root/'library/library.json').read_bytes(),source_bytes)
