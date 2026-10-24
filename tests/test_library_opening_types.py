"""Synthetic discovery rules; no supplier evidence belongs in these fixtures."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from estimator.library_opening_types import OPENING_TYPES, opening_type, opening_type_evidence
from estimator.library_substrates import substrate_options
from estimator.reference_library import ReferenceLibrary
from tests.test_reference_library import sample_library


def item(**fields):
    return {'fields': [{'label': key.replace('_', ' '), 'value': value} for key, value in fields.items()]}


class OpeningTypeTests(unittest.TestCase):
    def test_selected_products_and_installed_components_count_from_attributed_fields(self):
        for label, value in (
            ('System Products', 'FyreBOARD Maxilite, sealant'),
            ('System Products', 'BOSS FlexiBatt and coating'),
            ('System Products', 'PROMASEAL Bulkhead Batt'),
            ('Installation Details', 'Install two layers of batt into the aperture.'),
            ('Installation Details', 'Cut 50 mm board strips and fix around the opening.'),
            ('Local Protection', 'Seal the annular gap to the full depth of FIREFLYBatt.'),
            ('Service Wrap', 'Wrap on both faces of the batt seal.'),
            ('Barrier Construction', 'FyreBATT bulkhead wall'),
            ('Joint Treatment', 'Glue the joints between the board pieces.'),
            ('Installation Details', 'Patch the opening with plasterboard.'),
            ('Installation Details', 'The local thickening uses a COREX board patch.'),
            ('Installation Details', 'The particleboard around the service must be replaced with INEX floor 19.'),
            ('Installation Details', 'Frame the opening with studs and line it with plasterboard.'),
            ('Installation Details', 'Line the opening with fire-rated plasterboard as drawn.'),
            ('Installation Details', 'Fix the PROMASIL 1100 Super board over the wall opening around the service.'),
            ('Installation Details', 'Fix two layers of plasterboard to one side of the wall, extending 100 mm beyond the opening.'),
            ('System Products', 'Intubatt'),
            ('System Products', 'Ryanbatts'),
        ):
            with self.subTest(label=label, value=value):
                raw = {'fields': [{'label': label, 'value': value}]}
                before = deepcopy(raw)
                self.assertEqual(opening_type(raw), OPENING_TYPES[1])
                self.assertEqual(opening_type_evidence(raw)[0]['field'], label)
                self.assertEqual(raw, before)

    def test_substrate_words_headings_prose_and_unscoped_tables_are_not_components(self):
        cases = [item(Barrier_Construction='Two layers of plasterboard on a stud wall.'),
                 item(Installation_Details='Seal through the full depth of plasterboard wall lining.'),
                 item(Installation_Details='Sealant applied around the plasterboard wall.'),
                 item(Barrier_Construction='COREX plasterboard wall'),
                 item(Barrier_Construction='PROMATECT board wall on steel studs'),
                 item(Barrier_Construction='INEX floor 19'),
                 item(Barrier_Construction='Plasterboard stud wall with insulation batts in the cavity.'),
                 item(Installation_Details='Construct the stud wall with mineral wool batt cavity insulation.'),
                 item(Installation_Details='For a pipe through a COREX shaft wall, apply sealant around the pipe.'),
                 item(Installation_Details='The separating element can be built-up using batt or board.'),
                 item(Service='A keyboard cable and battery conduit'),
                 item(Installation_Details='Check the cardboard carton, switchboard and battery.'),
                 {'title': 'Board batt report', 'summary': 'Board installation', 'fields': []},
                 item(**{'Board component': 'Sealant only'}),
                 item(Source_Options='Other systems use batt or board.'),
                 item(FRL='Board wall -/120/120'),
                 {'fields': [{'label': 'System Products', 'value': 'Sealant',
                              'table': {'columns': ['Board', 'Material'], 'rows': [['Batt', 'Board']]}}]},
                 item(Installation_Details='Refer to board report 123.'),
                 item(Installation_Details='Use a temporary board as removable formwork.')]
        for raw in cases:
            with self.subTest(raw=raw):
                self.assertEqual(opening_type(raw), OPENING_TYPES[0])

    def test_material_scoped_negatives_and_independent_positive_clauses(self):
        for value in ('No batt is required.', 'Without any board.', 'Batt is not required.',
                      'Do not use board.', 'Omit the batt.', 'No batt or board is required.',
                      'Board or batt are not required.', 'Board is not to be used.',
                      'No mineral wool batt is required.', 'Sealant only; board not used.'):
            with self.subTest(value=value):
                self.assertEqual(opening_type(item(Installation_Details=value)), OPENING_TYPES[0])
        for value in ('No board is required; install batt into the opening.',
                      'Install batt without a board.', 'Must not install without batt.',
                      'The system must not be installed without batt.', 'Do not omit board.',
                      'Without mesh, install batt.', 'No primer is required, fit board.'):
            with self.subTest(value=value):
                self.assertEqual(opening_type(item(Installation_Details=value)), OPENING_TYPES[1])

    def test_empty_records_have_one_safe_default_without_claiming_approval(self):
        for raw in ({}, {'fields': []}, item(System_Products=''), item(System_Products='Sealant')):
            self.assertEqual(opening_type(raw), 'Core hole')
            self.assertEqual(opening_type_evidence(raw), [])

    def test_substrate_options_keep_every_exact_value_in_alphabetical_groups(self):
        values = ['Z wall', 'B floor', 'A wall', 'A ceiling', 'Saved custom', 'A floor']
        options = substrate_options(values)
        self.assertEqual([row['value'] for row in options],
                         ['A wall', 'Z wall', 'A floor', 'B floor', 'A ceiling', 'Saved custom'])
        self.assertEqual([row['group'] for row in options],
                         ['Walls', 'Walls', 'Floors', 'Floors', 'Ceilings', 'Other'])
        self.assertEqual({row['value'] for row in options}, set(values))

    def test_runtime_type_and_grouped_substrate_filters_are_conjunctive_and_preserve_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'library'
            data, _, _ = sample_library(root)
            records = data['libraries']['technical']['items']
            records[0]['fields'] += [{'label': 'Barrier Construction', 'value': 'Concrete wall'},
                                     {'label': 'System Products', 'value': 'Sealant'}]
            for identifier, product, barrier in (('batt-record', 'FIREFLYBatt', 'Concrete wall'),
                                                  ('floor-record', 'FIREFLYBatt', 'Concrete floor')):
                records.append({'id': identifier, 'title': identifier,
                                'fields': [{'label': 'System Products', 'value': product},
                                           {'label': 'Barrier Construction', 'value': barrier}],
                                'filter_values': {'report': ['Sample report']}})
            payload = json.dumps(data).encode()
            (root / 'library.json').write_bytes(payload)
            library = ReferenceLibrary(root)
            full = library.listing('technical')
            facets = {row['key']: row for row in full['filters']}
            self.assertEqual([row['value'] for row in facets['type']['options']], list(OPENING_TYPES))
            self.assertEqual([row['group'] for row in facets['substrate']['options']], ['Walls', 'Floors'])
            selected = library.listing('technical', report='Sample report',
                                       substrate='Concrete/masonry wall', type='Oversized core hole')
            self.assertEqual([row['id'] for row in selected['items']], ['batt-record'])
            self.assertEqual(library.listing('technical', type='Core hole')['total'], 1)
            self.assertEqual(library.listing('technical', type='Saved missing type')['total'], 0)
            self.assertNotIn('type', {row['key'] for row in library.listing('penetration')['filters']})
            self.assertEqual((root / 'library.json').read_bytes(), payload)
            self.assertEqual(data, json.loads(payload))


if __name__ == '__main__':
    unittest.main()
