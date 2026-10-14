"""Display provenance and saved-draft updates; no inferred installation sizing."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.firestopping_library import FirestoppingLibrary
from estimator.service_dimensions import (FIELD_LABEL, UNKNOWN, library_service_size_evidence,
                                          service_size_evidence, service_size_field)
from estimator.storage import Store
from test_firestopping_library import editable_library


class ServiceDimensionTests(unittest.TestCase):
    def value(self, **inputs):
        return service_size_field(inputs)['value']

    def test_diameter_uses_only_calculator_value_with_full_precision(self):
        self.assertEqual(self.value(AL=65, T='65 mm uPVC Pipe'), '65 mm')
        self.assertEqual(self.value(AL=110.0), '110 mm')
        self.assertEqual(self.value(AL=65.1234567890123), '65.1234567890123 mm')

    def test_conflicting_diameter_and_range_do_not_replace_calculator_value(self):
        self.assertEqual(self.value(AL=65, T='63mm OD HDPE Pipe with a maximum wall thickness of 4.7mm'),
            '65 mm')
        for text in ('Brass Pipes Ø50–65 mm × 0.91 mm (min)', 'Steel pipe 41 mm OD to 65 mm OD', 'Pipe up to 65 mm OD'):
            with self.subTest(text=text):
                self.assertEqual(self.value(AL=65, T=text), '65 mm')

    def test_bundle_description_is_not_parsed_or_mutated(self):
        text='1 × 3/8 + 5/8 FR pair coil with 19 mm insulation + 2 × 6 mm² 3C+E cables + 1 × Ø 18 mm condensate hose.'
        inputs={'AL':110,'T':text,'U':'Seal a 200 mm opening'}
        original=deepcopy(inputs)
        result=service_size_evidence(inputs)
        self.assertEqual(result, {'value':'110 mm','decision':'calculator_only',
            'basis':[{'column':'AL','role':'calculator_diameter','value':110}]})
        self.assertEqual(inputs,original)

    def test_tray_dimensions_are_not_wrap_board_or_bulkhead_dimensions(self):
        self.assertEqual(self.value(AQ=450, AR=50, AS=600, AW=1000, AX=1000, BB=1200, BC=900, BD=1500),
                         '450 mm wide × 50 mm deep')
        self.assertEqual(self.value(AR=50), '50 mm deep')
        self.assertEqual(self.value(AQ=450), '450 mm wide')
        self.assertEqual(self.value(AL=65, AQ=450, AR=50),
                         '65 mm\n450 mm wide × 50 mm deep')
        result=service_size_evidence({'AQ':450.1234567890123,'AR':50.9876543210987})
        self.assertEqual(result['value'],'450.1234567890123 mm wide × 50.9876543210987 mm deep')
        self.assertEqual(result['basis'],[
            {'column':'AQ','role':'cable_tray_width','value':450.1234567890123},
            {'column':'AR','role':'cable_tray_depth','value':50.9876543210987}])

    def test_explicit_service_descriptions_never_supply_missing_dimensions(self):
        for text in ('Up to 3 × Ø20 mm OD plastic conduits', 'Single 6 mm² electrical cable',
                     'Bundle of optic fibre cables, up to 30 x 30 mm', 'FyreSHIELD: 400x400 access panel',
                     'Up to DN50 copper pipe', '1 × 3/8 + 5/8 FR pair coil'):
            with self.subTest(text=text):
                self.assertEqual(self.value(T=text), UNKNOWN)
        for text in ('Copper pipe 8 mm OD up to 25 mm OD (min 0.91 mm wall thickness)',
                     'Up to 40 mm HDPE Pipe with a maximum wall thickness of 4.7mm',
                     'HDPE/AL/PEX Pipe (max OD 16 mm × 2 mm WT)',
                     '1 × 1/4” and 3/8” copper pair coil',
                     '25 mm LSZH FR HFT Electrical Conduit',
                     'PVC Stack pipes (DWV) up to 100mm',
                     'PVC junction box with up to 4 x 25mm PVC rigid or flexi conduits',
                     'Paircoil: 16 .mm OD and 9.4 .mm OD pipes with 10 .mm lagging'):
            self.assertEqual(self.value(T=text), UNKNOWN)

    def test_opening_thickness_material_and_installation_sizes_are_not_services(self):
        for text in ('Core hole of up to 32 mm diameter, filled with a bundle of RG6 cables',
                     'Downlights (Hole size from 92mm - 102mm)', 'Blank seal (batt) 450x450',
                     '600x650x700 Batt Bulkhead', 'Copper pipes with 19 mm insulation',
                     'Copper pipes with 0.91 mm wall thickness'):
            with self.subTest(text=text):
                self.assertEqual(self.value(T=text), UNKNOWN)
        self.assertEqual(self.value(U='65 mm pipe; core hole 100 mm', AM=300, AS=450, AW=65, AX=65, BB=100, BC=100, BD=100), UNKNOWN)

    def test_missing_invalid_dimensions_are_unknown_without_description_fallback(self):
        for separator in ('\n', '\\n'):
            self.assertEqual(self.value(T='65 mm uPVC pipe' + separator + '- Min 150 mm concrete wall'),
                             UNKNOWN)
        inputs={'AL':0,'AQ':None,'AR':False,'T':'Unspecified cable bundle'}
        original=deepcopy(inputs)
        self.assertEqual(service_size_field(inputs), {'label':FIELD_LABEL,'value':UNKNOWN})
        self.assertEqual(inputs, original)
        for invalid in (None, '', '65', 'bad', 0, -20, True, False, float('inf'), float('-inf'), float('nan')):
            with self.subTest(invalid=invalid):
                result=service_size_evidence({'AL':invalid,'AQ':invalid,'AR':invalid,'T':'65 mm pipe'})
                self.assertEqual(result,{'value':UNKNOWN,'decision':'unspecified','basis':[]})
        self.assertEqual(self.value(T='One Ø20 mm pipe\n- 2 × Ø18 mm hoses\n- 2 hour concrete wall'),
                         UNKNOWN)
        self.assertEqual(self.value(AL=65,K='Mixed Services',T='65 mm uPVC pipe'),'65 mm')
        for invalid in (None, [], '65 mm pipe'):
            self.assertEqual(service_size_field(invalid),{'label':FIELD_LABEL,'value':UNKNOWN})
        self.assertEqual(self.value(AL='65',AQ=450,AR=False),'450 mm wide')


class SavedServiceDimensionTests(unittest.TestCase):
    def test_save_reopen_replaces_derived_field_and_keeps_prices_and_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            data=editable_library(root/'library')
            data['libraries']['penetration']['items'][0]['estimate']['draft']['rows'][0]['inputs'].update(AL=65,T='65 mm uPVC Pipe')
            path=root/'library/library.json'
            path.write_text(json.dumps(data),encoding='utf8')
            source_bytes=path.read_bytes()
            store=Store(root/'test.sqlite3')
            library=FirestoppingLibrary(root/'library',store)
            def size(owner):
                fields=[field for field in owner.detail('penetration','pkb-001')['fields'] if field['label']==FIELD_LABEL]
                self.assertEqual(len(fields),1)
                return fields[0]['value']
            self.assertEqual(size(library),'65 mm')
            edit=library.edit('pkb-001')
            before=deepcopy(edit['draft'])
            body={name:deepcopy(edit[name]) for name in ('draft','revision','pricing_token')}
            body['draft']['rows'][0]['inputs'].update(AL=80)
            saved=library.action('pkb-001','save',body)
            reopened=FirestoppingLibrary(root/'library',store)
            self.assertEqual(size(reopened),'80 mm')
            self.assertEqual(saved['draft']['rows'][0]['inputs']['T'],'65 mm uPVC Pipe')
            self.assertEqual(saved['price']['amount'],edit['price']['amount'])
            self.assertEqual(reopened.edit('pkb-001')['draft'],saved['draft'])
            self.assertEqual(before,edit['draft'])
            body={name:deepcopy(saved[name]) for name in ('draft','revision','pricing_token')}
            body['draft']['rows'][0]['inputs'].update(AL=None,AQ=450,AR=50,T='Cable tray')
            tray_saved=library.action('pkb-001','save',body)
            reopened=FirestoppingLibrary(root/'library',store)
            self.assertEqual(size(reopened),'450 mm wide × 50 mm deep')
            self.assertEqual(reopened.edit('pkb-001')['draft'],tray_saved['draft'])
            self.assertEqual(tray_saved['pricing_token'],edit['pricing_token'])
            self.assertEqual(tray_saved['price']['amount'],edit['price']['amount'])
            self.assertEqual(path.read_bytes(),source_bytes)


class SupplierServiceStatementTests(unittest.TestCase):
    """Source literals remain separate from numerical calculation evidence."""
    def setUp(self):
        self.text = ('Core Hole of up to 75 mm with a max annular gap of 5 mm. '
                     'Filled with an assorted Power Cable Bundle of up to: '
                     'one 17 mm outside diameter cable; four 8 mm cables; '
                     'one 9 mm and two 4 mm cables; twelve 3.5 mm data cables.\\n'
                     '- Min. 120 mm thick concrete wall.')
        self.inputs = {'K': 'Power Cable Bundles', 'T': self.text}
        self.item = {'fields': [{'label': 'Item(s)', 'column': 'T',
                                'source_cell': 'T459', 'value': self.text}],
                     'sources': [{'filename': 'Original.xlsb', 'sheet': 'CALC', 'row': 459,
                                  'sha256': 'a' * 64}]}

    def evidence(self, inputs=None, item=None, source=None):
        return library_service_size_evidence(self.inputs if inputs is None else inputs,
            self.item if item is None else item, 'a' * 64 if source is None else source)

    def test_source_composite_is_verbatim_with_exact_provenance(self):
        before = deepcopy((self.inputs, self.item))
        result = self.evidence()
        self.assertEqual(result['decision'], 'source_statement')
        self.assertTrue(result['value'].endswith(self.text))
        self.assertEqual(result['basis'], [{'filename': 'Original.xlsb', 'sha256': 'a' * 64,
            'sheet': 'CALC', 'row': 459, 'column': 'T', 'source_cell': 'T459',
            'role': 'source_item_statement', 'value': self.text}])
        self.assertEqual((self.inputs, self.item), before)
        field = service_size_field(self.inputs, item=self.item, source_sha256='a' * 64)
        self.assertEqual(field['source_cell'], 'T459')
        self.assertEqual(field['source_workbook'], 'Original.xlsb')
        self.assertEqual(field['source_sha256'], 'a' * 64)

    def test_source_statement_never_becomes_numeric_service_size(self):
        self.assertEqual(service_size_evidence(self.inputs),
                         {'value': UNKNOWN, 'decision': 'unspecified', 'basis': []})
        for key in ('AL', 'AQ', 'AR'):
            self.assertNotIn(key, self.inputs)
        self.assertNotEqual(self.evidence()['value'], '75 mm')
        self.assertNotEqual(self.evidence()['value'], '17 mm')

    def test_calculator_dimensions_have_precedence_even_over_conflicting_source(self):
        for values in ({'AL': 65.1234567890123}, {'AQ': 450, 'AR': 50}):
            inputs = {**self.inputs, **values}
            self.assertEqual(self.evidence(inputs), service_size_evidence(inputs))
            self.assertEqual(service_size_field(inputs, item=self.item, source_sha256='a' * 64),
                             service_size_field(inputs))

    def test_complete_ranges_opening_conditions_and_blank_seals_are_not_reinterpreted(self):
        for text in ('Pipe 8 mm OD up to 25 mm OD (minimum wall thickness 0.91 mm).',
                     'Cable 6 mm² cross section; core hole up to 32 mm.',
                     'Core hole up to 32 mm diameter, filled with up to 14 CAT5e cables.',
                     'Blank seal (batt) 450x450', '600x650x700 Batt Bulkhead',
                     'Mixed Fibre Optic Cable Bundle',
                     '1 × 3/8 + 5/8 pair coil with 19 mm insulation.\n- Min 100 mm wall'):
            with self.subTest(text=text):
                item = deepcopy(self.item)
                item['fields'][0]['value'] = text
                result = self.evidence({'T': text}, item)
                self.assertTrue(result['value'].endswith(text))
                self.assertEqual(result['basis'][0]['value'], text)
                self.assertNotIn('diameter_mm', result)

    def test_source_version_row_cell_and_text_must_match_exactly(self):
        changes = [lambda item: item['sources'][0].update(sha256='b' * 64),
                   lambda item: item['sources'][0].update(sheet='OTHER'),
                   lambda item: item['sources'][0].update(row=458),
                   lambda item: item['sources'][0].update(row=True),
                   lambda item: item['sources'][0].update(row=0),
                   lambda item: item['sources'][0].update(filename=''),
                   lambda item: item['fields'][0].update(source_cell='T458'),
                   lambda item: item['fields'][0].update(value='Different current description'),
                   lambda item: item['fields'][0].update(column='U'),
                   lambda item: item['sources'].append(deepcopy(item['sources'][0])),
                   lambda item: item['fields'].append(deepcopy(item['fields'][0]))]
        for change in changes:
            with self.subTest(change=change):
                item = deepcopy(self.item)
                change(item)
                self.assertEqual(self.evidence(item=item)['decision'], 'unspecified')
        for source in ('bad', '', 'A' * 64, 123):
            self.assertEqual(self.evidence(source=source)['decision'], 'unspecified')
        for text in ('', None, ' ', 'Edited source statement'):
            self.assertEqual(self.evidence({'T': text})['decision'], 'unspecified')

    def test_saved_edit_cannot_be_relabelled_as_original_workbook_text(self):
        item = deepcopy(self.item)
        item.update(library_id='FL-ID-001', title='Example', filter_values={})
        edit = {'draft': {'rows': [{'inputs': {'T': 'My 200 mm pipe', 'K': 'Plastic Pipes'}}]},
                'amount': 100, 'updated_at': '2026-10-14'}
        FirestoppingLibrary._apply_edit(item, edit, source_sha256='a' * 64)
        field = next(field for field in item['fields'] if field['label'] == FIELD_LABEL)
        self.assertEqual(field, {'label': FIELD_LABEL, 'value': UNKNOWN})
        self.assertEqual(next(field['value'] for field in item['fields'] if field.get('column') == 'T'),
                         'My 200 mm pipe')

    def test_unchanged_saved_statement_keeps_its_original_source_conditions(self):
        item = deepcopy(self.item)
        item.update(library_id='FL-ID-001', title='Example', filter_values={})
        edit = {'draft': {'rows': [{'inputs': self.inputs}]},
                'amount': 100, 'updated_at': '2026-10-14'}
        FirestoppingLibrary._apply_edit(item, edit, source_sha256='a' * 64)
        field = next(field for field in item['fields'] if field['label'] == FIELD_LABEL)
        self.assertEqual(field['source_cell'], 'T459')
        self.assertTrue(field['value'].endswith(self.text))

    def test_library_read_projects_source_statement_without_changing_inputs_prices_or_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data = editable_library(root / 'library')
            item = data['libraries']['penetration']['items'][0]
            item['sources'] = deepcopy(self.item['sources'])
            item['fields'].extend(deepcopy(self.item['fields']))
            item['estimate']['draft']['rows'][0]['inputs'].update(self.inputs)
            path = root / 'library/library.json'
            path.write_text(json.dumps(data), encoding='utf8')
            original = path.read_bytes()
            draft = deepcopy(item['estimate']['draft'])
            library = FirestoppingLibrary(root / 'library', Store(root / 'test.sqlite3'))
            for owner in (library, FirestoppingLibrary(root / 'library', library.edits.store)):
                detail = owner.detail('penetration', item['id'])
                fields = [field for field in detail['fields'] if field['label'] == FIELD_LABEL]
                self.assertEqual(len(fields), 1)
                self.assertTrue(fields[0]['value'].endswith(self.text))
                self.assertEqual(detail['price']['amount'], item['price']['amount'])
                self.assertEqual(detail['price']['currency'], item['price']['currency'])
                self.assertEqual(owner._load()['_records']['penetration'][item['id']]['estimate']['draft'], draft)
            self.assertEqual(path.read_bytes(), original)


if __name__=='__main__':
    unittest.main()
