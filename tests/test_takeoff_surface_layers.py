"""Explicit surface layers multiply net area without creating physical members."""
from copy import deepcopy
import csv
from io import BytesIO, StringIO
import math
import unittest
from uuid import uuid4

from openpyxl import load_workbook

from estimator.catalog import ValidationError
from estimator.takeoff_exports import HEADERS, export_workspace
from estimator.takeoff_model import area_layers, item_digest, item_result, validate_snapshot
from estimator.takeoff_transfer import mapped_values
from tests import test_takeoff_area as fixtures


class TakeoffSurfaceLayersTests(unittest.TestCase):
    def setUp(self):
        self.area = fixtures.TakeoffAreaTests(); self.area.setUp()
        self.addCleanup(self.area.doCleanups)
        self.case = self.area.case

    def proposal(self, mode='wall', layers=2):
        item = self.area.proposal(mode)
        item['fields'] = {'mark': 'W-NEW' if mode == 'wall' else 'F-NEW',
                          'substrate': 'Concrete', 'frl': '120/120/120', 'layers': layers}
        item['evidence'][0]['fields'] = ['layers', 'total_area_m2']
        return item

    def current(self, identifier):
        return self.area.current(identifier)

    def rows(self, payload, name='Current Takeoffs'):
        workbook = load_workbook(BytesIO(payload)); self.addCleanup(workbook.close)
        values = list(workbook[name].values)
        return [dict(zip(values[0], row)) for row in values[1:]], values[0]

    def export(self, confirmation='all', mode='walls_floors'):
        state = self.case.state['snapshot']
        return self.case.service.export_workspace(self.case.sid, 'schedule-xlsx',
            {'expected_revision': state['revision'], 'mode': mode, 'confirmation': confirmation})

    def test_absent_layers_preserve_exact_legacy_item_digest_receipt_and_export_schema(self):
        identifier = self.area.create(); self.case.confirm(identifier)
        before = deepcopy(self.case.state['snapshot'])
        original = deepcopy(self.current(identifier))
        digest = item_digest(original, before)
        self.assertEqual(area_layers(original), 1)
        result = item_result(original, before)
        self.assertEqual((result['net_area_m2'], result['layers'], result['total_area_m2']), (48, 1, 48))
        self.assertEqual(original['confirmation']['checks']['engine'], 'takeoffs-area-v1')
        self.assertNotIn('layers', original['confirmation']['checks'])
        self.assertNotIn('total_area_m2', original['confirmation']['checks'])
        self.assertNotIn('layers', original['fields'])
        restored = validate_snapshot(before)
        self.assertEqual(restored, before)
        self.assertEqual(item_digest(restored['items'][0], restored), digest)
        self.assertEqual(self.case.service.open(before, source_path='verified.json')['snapshot']['items'][0], original)
        payload = self.case.service.export(self.case.sid, 'csv', [identifier])[0]
        self.assertEqual(tuple(next(csv.reader(StringIO(payload.decode('utf-8-sig'))))), HEADERS)
        self.assertNotIn('Number of layers', self.rows(self.export()[0])[1])
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_new_wall_floor_confirm_without_hidden_properties_and_keep_one_member(self):
        for mode, layers in (('wall', 2), ('slab', 3)):
            with self.subTest(mode=mode):
                identifier = self.area.create(self.proposal(mode, layers))
                item = deepcopy(self.current(identifier))
                result = item_result(item, self.case.state['snapshot'])
                self.assertEqual(result, {'id': identifier, 'gross_area_m2': 50, 'excluded_area_m2': 2,
                                         'net_area_m2': 48, 'layers': layers, 'total_area_m2': 48*layers, 'issues': []})
                self.case.confirm(identifier)
                current = self.current(identifier)
                self.assertEqual((current['quantity'], len(current['member_ids'])), (1, 1))
                for key in ('geometry', 'measurement', 'fields', 'evidence', 'member_ids'):
                    self.assertEqual(current[key], item[key])
                self.assertEqual(current['confirmation']['checks'], {'engine': 'takeoffs-area-v2', 'quantity': 1,
                    'gross_area_m2': 50, 'excluded_area_m2': 2, 'net_area_m2': 48,
                    'layers': layers, 'total_area_m2': 48*layers, 'evidence_verified': True, 'issues': []})
                self.assertTrue({'treatment', 'surface_basis', 'surface_citation'}.isdisjoint(current['fields']))

    def test_invalid_layers_and_non_surface_layers_fail_atomically(self):
        before = deepcopy(self.case.state['snapshot'])
        for value in (None, True, False, 0, -1, 1.0, 1.5, '2', '', math.inf, math.nan, 10**12+1):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                self.area.create(self.proposal(layers=value))
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        for mode in ('steel', 'duct'):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValidationError, 'Number of layers'):
                self.case.create(mode, fields={'layers': 2})
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_simplified_surfaces_still_require_human_fields_and_verified_measurement(self):
        for field, value in (('mark', ''), ('substrate', ' '), ('frl', '120')):
            proposal = self.proposal(); proposal['fields'][field] = value
            identifier = self.area.create(proposal)
            with self.subTest(field=field), self.assertRaises(ValidationError):
                self.case.command('confirm_items', item_ids=[identifier])
        proposal = self.proposal(); proposal['measurement'] = None
        identifier = self.area.create(proposal)
        with self.assertRaisesRegex(ValidationError, 'calibration'):
            self.case.command('confirm_items', item_ids=[identifier])
        identifier = self.area.create(self.proposal())
        self.case.documents.blocked = True
        with self.assertRaisesRegex(ValidationError, 'Changed source'):
            self.case.command('confirm_items', item_ids=[identifier])

    def test_layer_change_invalidates_confirmation_preserves_legacy_facts_and_undo(self):
        identifier = self.area.create(); self.case.confirm(identifier)
        original = deepcopy(self.current(identifier))
        self.case.command('update_item', item_id=identifier, changes={'fields': {'layers': 2}})
        current = self.current(identifier)
        self.assertEqual(current['state'], 'draft'); self.assertIsNone(current['confirmation'])
        for key in ('geometry', 'measurement', 'member_ids', 'evidence', 'quantity'):
            self.assertEqual(current[key], original[key])
        for key, value in original['fields'].items():
            self.assertEqual(current['fields'][key], value)
        self.assertNotEqual(item_digest(current, self.case.state['snapshot']), original['confirmation']['digest'])
        self.case.confirm(identifier)
        self.assertEqual(self.current(identifier)['confirmation']['checks']['engine'], 'takeoffs-area-v2')
        self.case.command('update_item', item_id=identifier, changes={'fields': {'layers': 4}})
        self.assertEqual(item_result(self.current(identifier), self.case.state['snapshot'])['total_area_m2'], 192)
        self.case.command('undo')
        current = self.current(identifier)
        self.assertEqual(current['fields']['layers'], 2)
        self.assertEqual(current['geometry'], original['geometry'])
        self.assertEqual(item_result(current, self.case.state['snapshot'])['net_area_m2'], 48)

    def test_v2_receipts_reject_wrong_layers_total_and_unregistered_consistent_forgery(self):
        identifier = self.area.create(self.proposal()); self.case.confirm(identifier)
        before = deepcopy(self.case.state['snapshot'])
        for changes in ({'layers': 3, 'total_area_m2': 144}, {'total_area_m2': 97}, {'engine': 'takeoffs-area-v1'}, {'layers': True}):
            changed = deepcopy(before); changed['items'][0]['confirmation']['checks'].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                validate_snapshot(changed)
        forged = deepcopy(before); forged['items'][0]['confirmation']['id'] = str(uuid4())
        request = {'expected_revision': forged['revision'], 'mode': 'walls_floors', 'confirmation': 'unconfirmed'}
        rows, _ = self.rows(export_workspace(forged, request, 'schedule-xlsx', documents=self.case.documents, store=self.case.store)[0])
        self.assertEqual([row['Item ID'] for row in rows], [identifier])
        self.assertEqual(rows[0]['Confirmation'], 'Unconfirmed')
        self.assertEqual(self.case.service.open(forged, source_path='verified.json')['snapshot']['items'][0]['state'], 'reviewed')

    def test_layer_total_overflow_blocks_confirmation_and_transfer_remains_unsupported(self):
        calibration = deepcopy(self.case.state['snapshot']['calibrations'][0])
        calibration.update(id=str(uuid4()), distance_m=10**6)
        self.case.command('add_calibration', calibration=calibration)
        proposal = self.proposal(layers=10**12); proposal['measurement']['calibration_id'] = calibration['id']
        identifier = self.area.create(proposal)
        result = item_result(self.current(identifier), self.case.state['snapshot'])
        self.assertIsNone(result['total_area_m2']); self.assertTrue(result['issues'])
        with self.assertRaisesRegex(ValidationError, 'Total surface area'):
            self.case.command('confirm_items', item_ids=[identifier])
        identifier = self.area.create(self.proposal()); self.case.confirm(identifier)
        for calculator in ('steel_vermiculite', 'steel_board', 'ductwork'):
            with self.subTest(calculator=calculator), self.assertRaisesRegex(ValidationError, 'no approved calculator transfer'):
                mapped_values(self.current(identifier), self.case.state['snapshot'], calculator, 10)

    def test_all_export_categories_keep_precise_net_layers_total_and_original_native_types(self):
        wall = self.area.create(self.proposal('wall', 2)); self.case.confirm(wall)
        proposal = self.proposal('slab', 3)
        proposal['geometry']['points'][1][0] = proposal['geometry']['points'][2][0] = 120.1234567890123
        floor = self.area.create(proposal)
        before = deepcopy(self.case.state['snapshot'])
        for category, expected in (('all', [wall, floor]), ('confirmed', [wall]), ('unconfirmed', [floor])):
            rows, headers = self.rows(self.export(category)[0])
            self.assertEqual([row['Item ID'] for row in rows], expected)
            self.assertEqual(headers[-2:], ('Number of layers', 'Total area m2'))
            for row in rows:
                item = self.current(row['Item ID']); result = item_result(item, before)
                for column, key in (('Gross area m2', 'gross_area_m2'), ('Excluded area m2', 'excluded_area_m2'),
                                    ('Net area m2', 'net_area_m2'), ('Number of layers', 'layers'), ('Total area m2', 'total_area_m2')):
                    self.assertEqual(row[column], result[key])
                self.assertEqual(row['Quantity'], 1); self.assertEqual(row['Mode'], item['mode'])
                self.assertEqual(row['Source SHA-256'], self.case.doc['sha256'])
        for mode, identifier in (('wall', wall), ('slab', floor)):
            rows, _ = self.rows(self.export(mode=mode)[0])
            self.assertEqual([row['Item ID'] for row in rows], [identifier])
            self.assertEqual(rows[0]['Total area m2'], item_result(self.current(identifier), before)['total_area_m2'])
        payload = self.case.service.export(self.case.sid, 'csv', [wall])[0]
        row = next(csv.DictReader(StringIO(payload.decode('utf-8-sig'))))
        self.assertEqual((int(row['Number of layers']), float(row['Net area m2']), float(row['Total area m2'])), (2, 48, 96))
        rows, _ = self.rows(self.case.service.export(self.case.sid, 'xlsx', [wall])[0], 'Confirmed Takeoffs')
        self.assertEqual((rows[0]['Number of layers'], rows[0]['Total area m2']), (2, 96))
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)


if __name__ == '__main__': unittest.main()
