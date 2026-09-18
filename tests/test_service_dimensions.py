"""Display provenance and saved-draft updates; no inferred installation sizing."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.firestopping_library import FirestoppingLibrary
from estimator.service_dimensions import FIELD_LABEL, UNKNOWN, service_size_evidence, service_size_field
from estimator.storage import Store
from test_firestopping_library import editable_library


class ServiceDimensionTests(unittest.TestCase):
    def value(self, **inputs):
        return service_size_field(inputs)['value']

    def test_clear_matching_pipe_and_actual_calculator_precision(self):
        self.assertEqual(self.value(AL=65, T='65 mm uPVC Pipe'), '65 mm diameter')
        self.assertEqual(self.value(AL=65.1234567890123), 'Diameter used in calculation: 65.1234567890123 mm')

    def test_conflicting_diameter_and_range_keep_literal_description(self):
        self.assertEqual(self.value(AL=65, T='63mm OD HDPE Pipe with a maximum wall thickness of 4.7mm'),
            'Diameter used in calculation: 65 mm\nDescribed service: 63mm OD HDPE Pipe with a maximum wall thickness of 4.7mm')
        for text in ('Brass Pipes Ø50–65 mm × 0.91 mm (min)', 'Steel pipe 41 mm OD to 65 mm OD', 'Pipe up to 65 mm OD'):
            with self.subTest(text=text):
                self.assertEqual(self.value(AL=65, T=text), 'Diameter used in calculation: 65 mm\nDescribed service: ' + text)

    def test_bundle_preserves_fractions_quantities_and_component_units(self):
        text='1 × 3/8 + 5/8 FR pair coil with 19 mm insulation + 2 × 6 mm² 3C+E cables + 1 × Ø 18 mm condensate hose.'
        result=service_size_evidence({'AL':110,'T':text})
        self.assertEqual(result['value'], 'Diameter used in calculation: 110 mm\nDescribed service: ' + text)
        self.assertEqual({entry['column'] for entry in result['basis']}, {'AL','T'})
        self.assertNotIn('110 mm diameter', result['value'])

    def test_tray_dimensions_are_not_wrap_board_or_bulkhead_dimensions(self):
        self.assertEqual(self.value(AQ=450, AR=50, AS=600, AW=1000, AX=1000, BB=1200, BC=900, BD=1500),
                         'Cable tray: 450 mm wide × 50 mm deep')
        self.assertEqual(self.value(AR=50), 'Cable tray: 50 mm deep')
        self.assertEqual(self.value(AL=65, AQ=450, AR=50),
                         'Diameter used in calculation: 65 mm\nCable tray: 450 mm wide × 50 mm deep')

    def test_explicit_service_descriptions_are_literal_without_conversion(self):
        for text in ('Up to 3 × Ø20 mm OD plastic conduits', 'Single 6 mm² electrical cable',
                     'Bundle of optic fibre cables, up to 30 x 30 mm', 'FyreSHIELD: 400x400 access panel',
                     'Up to DN50 copper pipe', '1 × 3/8 + 5/8 FR pair coil'):
            with self.subTest(text=text):
                self.assertEqual(self.value(T=text), 'Described service: ' + text)
        for text in ('Copper pipe 8 mm OD up to 25 mm OD (min 0.91 mm wall thickness)',
                     'Up to 40 mm HDPE Pipe with a maximum wall thickness of 4.7mm',
                     'HDPE/AL/PEX Pipe (max OD 16 mm × 2 mm WT)',
                     '1 × 1/4” and 3/8” copper pair coil',
                     '25 mm LSZH FR HFT Electrical Conduit',
                     'PVC Stack pipes (DWV) up to 100mm',
                     'PVC junction box with up to 4 x 25mm PVC rigid or flexi conduits',
                     'Paircoil: 16 .mm OD and 9.4 .mm OD pipes with 10 .mm lagging'):
            self.assertEqual(self.value(T=text), 'Described service: ' + text)

    def test_opening_thickness_material_and_installation_sizes_are_not_services(self):
        for text in ('Core hole of up to 32 mm diameter, filled with a bundle of RG6 cables',
                     'Downlights (Hole size from 92mm - 102mm)', 'Blank seal (batt) 450x450',
                     '600x650x700 Batt Bulkhead', 'Copper pipes with 19 mm insulation',
                     'Copper pipes with 0.91 mm wall thickness'):
            with self.subTest(text=text):
                self.assertEqual(self.value(T=text), UNKNOWN)
        self.assertEqual(self.value(U='65 mm pipe; core hole 100 mm', AM=300, AS=450, AW=65, AX=65, BB=100, BC=100, BD=100), UNKNOWN)

    def test_substrate_note_and_zero_null_boolean_inputs_remain_distinct(self):
        for separator in ('\n', '\\n'):
            self.assertEqual(self.value(T='65 mm uPVC pipe' + separator + '- Min 150 mm concrete wall'),
                             'Described service: 65 mm uPVC pipe')
        inputs={'AL':0,'AQ':None,'AR':False,'T':'Unspecified cable bundle'}
        original=deepcopy(inputs)
        self.assertEqual(service_size_field(inputs), {'label':FIELD_LABEL,'value':UNKNOWN})
        self.assertEqual(inputs, original)
        self.assertEqual(self.value(AL=-20), UNKNOWN)
        self.assertEqual(self.value(T='One Ø20 mm pipe\n- 2 × Ø18 mm hoses\n- 2 hour concrete wall'),
                         'Described service: One Ø20 mm pipe\n- 2 × Ø18 mm hoses')
        self.assertIn('Diameter used in calculation', self.value(AL=65,K='Mixed Services',T='65 mm uPVC pipe'))


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
            self.assertEqual(size(library),'65 mm diameter')
            edit=library.edit('pkb-001')
            before=deepcopy(edit['draft'])
            body={name:deepcopy(edit[name]) for name in ('draft','revision','pricing_token')}
            body['draft']['rows'][0]['inputs'].update(AL=80,T='80 mm uPVC Pipe')
            saved=library.action('pkb-001','save',body)
            reopened=FirestoppingLibrary(root/'library',store)
            self.assertEqual(size(reopened),'80 mm diameter')
            self.assertEqual(saved['price']['amount'],edit['price']['amount'])
            self.assertEqual(reopened.edit('pkb-001')['draft'],saved['draft'])
            self.assertEqual(before,edit['draft'])
            body={name:deepcopy(saved[name]) for name in ('draft','revision','pricing_token')}
            body['draft']['rows'][0]['inputs'].update(AL=None,AQ=450,AR=50,T='Cable tray')
            library.action('pkb-001','save',body)
            self.assertEqual(size(FirestoppingLibrary(root/'library',store)),'Cable tray: 450 mm wide × 50 mm deep')
            self.assertEqual(path.read_bytes(),source_bytes)


if __name__=='__main__':
    unittest.main()
