"""Public system identities must survive ordinary authoring and library imports."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from estimator.storage import Store
from estimator.catalog import ValidationError
from estimator.technical_library_edits import FACETS, ManualTechnicalLibrary
from estimator.technical_public_ids import _allocated_ids, public_item
from estimator.technical_item_exports import prepare_technical_item
from test_firestopping_library import editable_library


class TechnicalPublicIdTests(unittest.TestCase):
    def test_one_sequence_concurrent_replay_reserves_deleted_numbers(self):
        with TemporaryDirectory() as folder:
            store = Store(Path(folder) / 'state.sqlite3')
            self.assertEqual(_allocated_ids(store, {'b', 'a'}), {'a': 'CF-01', 'b': 'CF-02'})
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = list(workers.map(lambda keys: _allocated_ids(store, keys), ({'b', 'c'}, {'c', 'b'})))
            self.assertEqual(results[0], results[1])
            reopened = Store(store.path)
            numbers = _allocated_ids(reopened, {'a', 'd'})
            self.assertEqual(numbers, {'a': 'CF-01', 'b': 'CF-02', 'c': 'CF-03', 'd': 'CF-04'})
            self.assertEqual(_allocated_ids(reopened, {'b'})['b'], 'CF-02')

    def test_contextual_id_and_bondek_are_public_only(self):
        record = {'id': 'tv-example', 'title': 'Trafalgar: 2590 — Bondeck floor',
                  'subtitle': '2590 — Bondeck floor', 'source_code': '2590',
                  'fields': [{'label': 'ID', 'value': 'tv-example'},
                             {'label': 'Barrier Construction', 'value': 'Bondeck slab, 2590 mm.',
                              'table': {'columns': ['ID', 'Construction'], 'rows': [['2590', 'Bondeck 65 mm']]}},
                             {'label': 'System Products', 'value': 'SNAP 63R and SNAP 100 Low-Top Stack'}],
                  'sources': [{'label': 'SNAP product filter, system 2590', 'url': 'https://www.snapcollars.com.au/product-filter'}]}
        before = deepcopy(record)
        result = public_item({'_technical_public_ids': {'tv-example': 'CF-01'}}, 'tv-example', record)
        self.assertEqual(record, before)
        self.assertEqual(result['title'], 'Trafalgar: CF-01 — Bondek floor')
        self.assertEqual(result['subtitle'], 'CF-01 — Bondek floor')
        self.assertEqual(result['fields'][0]['value'], 'CF-01')
        self.assertEqual(result['fields'][1]['value'], 'Bondek slab, 2590 mm.')
        self.assertEqual(result['fields'][1]['table'], {'columns': ['Construction'], 'rows': [['Bondek 65 mm']]})
        self.assertEqual(result['fields'][2], record['fields'][2])
        self.assertEqual(result['sources'][0]['url'], record['sources'][0]['url'])
        self.assertNotIn('2590', result['sources'][0]['label'])

    def test_global_cross_manufacturer_identity_roundtrip_and_native_ids(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            editable_library(folder / 'library')
            lib = ManualTechnicalLibrary(folder / 'library', Store(folder / 'state.sqlite3'))
            base = lib.technical_edit('report-a-v1', for_display=False)['record']
            def insert(key, manufacturer, system_id=None):
                record = deepcopy(base)
                record.update(id=key, title=f'{manufacturer} — collar', source_label='User-created Technical Library item')
                record['filter_values'].update(manufacturer=[manufacturer], report=['Sample report'],
                    category=['Plumbing & Hydraulic'], substrate=['Concrete/masonry wall'], orientation=['Vertical'],
                    type=['Core hole'], services=['Copper Pipes'], frl=['-/120/120'])
                record['fields'] = [f for f in record['fields'] if f['label'] != 'ID']
                if not any(field['label'] == 'Report Number' for field in record['fields']):
                    record['fields'].append({'label': 'Report Number', 'value': 'Sample report'})
                if system_id is not None:
                    record['fields'].append({'label': 'ID', 'value': system_id})
                lib.technical_edits.save(key, 0, 'c' * 64, record, created=True)
            for key, maker, source in [('supplier-z', 'Snap', 'SNAP 3100'), ('supplier-m', 'Allproof', None),
                                        ('supplier-b', 'Trafalgar', '7612'), ('supplier-a', 'Promat', 'sys_var_8811_au'),
                                        ('native-firefly', 'Firefly', 'V1'), ('native-boss', 'BOSS', 'BF-2001'),
                                        ('existing-fendix', 'Fendix', None)]:
                insert(key, maker, source)
            choices = lib._load()['_technical_public_ids']
            self.assertEqual([choices[k] for k in ('supplier-a', 'supplier-b', 'supplier-m', 'supplier-z')],
                             ['CF-01', 'CF-02', 'CF-03', 'CF-04'])
            self.assertEqual([choices[k] for k in ('native-firefly','native-boss','existing-fendix')],
                             ['V1','BF-2001','existing-fendix'])
            key = 'supplier-z'
            edit = lib.technical_edit(key)
            rec = edit['record']
            self.assertEqual(next(f['value'] for f in rec['fields'] if f['label']=='ID'), 'CF-04')
            normalized = [{'label': f['label'], 'value': f.get('value','')} for f in rec['fields']]
            next(f for f in normalized if f['label']=='ID')['value'] = 'CF-01'
            report = next(f for f in rec['fields'] if f['label']=='Report Number')
            body = {'revision':edit['revision'], 'source_sha256':edit['source_sha256'], 'request_key':None,
                    'title':rec['title'], 'facets':{k:rec['filter_values'][k] for k,_ in FACETS},
                    'fields':normalized, 'report':{'number':report['value'], 'url':''}}
            invalid = deepcopy(body)
            next(f for f in invalid['fields'] if f['label'] == 'ID')['value'] = {'invalid': 'type'}
            with self.assertRaises(ValidationError):
                lib.technical_save(key, invalid)
            lib.technical_save(key, body)
            self.assertEqual(next(f['value'] for f in lib.technical_edit(key, for_display=False)['record']['fields']
                                  if f['label']=='ID'), 'SNAP 3100')
            checked = prepare_technical_item({'id':key},library=lib,include_diagrams=False)
            self.assertEqual(next(f['value'] for f in checked['fields'] if f['label']=='ID'), 'CF-04')
            self.assertEqual(lib.listing('technical',search='CF-04')['items'][0]['id'],key)
            self.assertEqual(lib.listing('technical',search='SNAP 3100')['total'],0)

