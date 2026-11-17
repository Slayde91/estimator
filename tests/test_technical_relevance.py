import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from estimator.reference_library import ReferenceLibrary
from estimator.storage import Store
from estimator.technical_library_edits import ManualTechnicalLibrary
from estimator.technical_relevance import TechnicalQuery, tie_key
from test_reference_library import sample_library


def score(search, *, code='', fields=(), facets=None, evidence='', direct=False):
    return TechnicalQuery(search.casefold()).rank(
        {'fields': [{'label': label, 'value': value} for label, value in fields]},
        facets or {}, code, evidence.casefold(), direct_service=direct)


class TechnicalRelevanceTests(unittest.TestCase):
    def test_identifiers_report_codes_and_dimensions_match_complete_values(self):
        self.assertLess(score('CF-000001', code='CF-000001'), score('CF-000001', evidence='mentions CF-000001'))
        self.assertIsNone(score('CF-000001', code='CF-0000012'))
        self.assertIsNone(score('V1', code='V10'))
        self.assertIsNone(score('50 mm', evidence='150mm and 2.50mm'))
        self.assertIsNone(score('-/120/120', evidence='-/120/1200'))
        self.assertIsNone(score('FCO3520', evidence='FCO35201'))
        self.assertIsNotNone(score('50 mm', evidence='diameter 50mm'))
        self.assertIsNotNone(score('FCO3520', facets={'report':['FCO 3520']}))
        self.assertLess(score('FCO 3520', facets={'report':['FCO3520']}), score('FCO 3520', evidence='see FCO3520'))
        self.assertIsNotNone(score('pipe', fields=[('Service', 'Steel pipes')]))
        self.assertIsNone(score('gas', evidence='gasket'))

    def test_explicit_technical_facts_outweigh_incidental_mentions_and_repetition(self):
        primary = score('PVC pipe 50 mm', fields=[('Service', 'PVC pipe'), ('Service Size / Configuration', '50 mm')])
        note = score('PVC pipe 50 mm', evidence='PVC pipe 50mm. ' * 100)
        self.assertLess(primary, note)
        self.assertLess(score('concrete slab', fields=[('Barrier Construction','Concrete slab')]),
                        score('concrete slab', fields=[('Barrier Construction','Slab made of concrete')]))
        self.assertEqual(score('slab', facets={'manufacturer':['Firefly']}, evidence='slab'),
                         score('slab', facets={'manufacturer':['Snap']}, evidence='slab slab'))
        self.assertIsNone(score('copper pipe 50 mm', fields=[('Service', 'Copper pipes')]))
        self.assertLess(score('', direct=True), score('', direct=False))

    def test_public_listing_sorts_matches_before_pagination_and_ignores_input_order(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / 'library'
            data, _, _ = sample_library(root)
            data['links'] = []
            items = []
            for i, maker in enumerate(('Amber', 'Zinc', 'Amber', 'Zinc', 'Amber', 'Zinc')):
                items.append({'id': f'system-{i}', 'title': f'Installation {i}', 'summary': 'ordinary pipe',
                              'fields': [{'label': 'Manufacturer', 'value': maker},
                                         {'label': 'Service', 'value': 'Copper pipe' if i == 4 else 'Steel pipe'},
                                         {'label': 'Installation Details', 'value': 'Example with copper pipe.'}],
                              'filter_values': {}})

            def open_library(records):
                data['libraries']['technical']['items'] = records
                (root / 'library.json').write_text(json.dumps(data), encoding='utf8')
                return ReferenceLibrary(root)

            first = open_library(items)
            ids = lambda response: [item['id'] for item in response['items']]
            expected = sorted((item['id'] for item in items), key=tie_key)
            self.assertEqual(ids(first.listing('technical')), expected)
            self.assertEqual(ids(first.listing('technical', search='copper pipe'))[0], 'system-4')
            pieces = [first.listing('technical', search='copper pipe', limit='2', offset=str(n)) for n in (0, 2, 4)]
            self.assertTrue(all(p['total'] == 6 for p in pieces))
            complete = sum((ids(p) for p in pieces), [])
            self.assertEqual(len(set(complete)), 6)
            other = open_library(list(reversed(items)))
            self.assertEqual(ids(other.listing('technical')), expected)
            self.assertEqual(ids(other.listing('technical', search='copper pipe')), complete)
            self.assertEqual(set(ids(other.listing('technical', manufacturer='Amber', search='copper pipe'))),
                             {'system-0', 'system-2', 'system-4'})

    def test_list_uses_displayed_public_id_and_excludes_retired_id(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / 'library'
            data, _, _ = sample_library(root)
            source = data['libraries']['technical']['items'][0]
            source['fields'] = [{'label': 'Manufacturer', 'value': 'Trafalgar'},
                                {'label': 'ID', 'value': '70823'},
                                {'label': 'Service', 'value': 'Steel pipe'}]
            source['id'] = 'trafalgar-selector-70823'
            data['links'] = []
            (root / 'library.json').write_text(json.dumps(data), encoding='utf8')
            lib = ManualTechnicalLibrary(root, Store(Path(tmp) / 'work.sqlite3'))
            public = lib.detail('technical', source['id'])['source_code']
            self.assertTrue(public.startswith('CF-'))
            self.assertEqual([r['id'] for r in lib.listing('technical', search=public + ' pipe')['items']],
                             [source['id']])
            self.assertEqual(lib.listing('technical', search='70823')['total'], 0)
            self.assertEqual(lib.listing('technical', search=source['id'])['total'], 0)


if __name__ == '__main__':
    unittest.main()
