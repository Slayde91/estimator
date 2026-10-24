"""Takeoff aggregation remains independent from calculator row repetition."""

from copy import deepcopy
import unittest

from estimator.catalog import ValidationError
from estimator.takeoff_model import digest, validate_snapshot
from estimator.takeoff_transfer import row_values, transfer_preview
from estimator.workbook_calculators import calculator_session, source_model
from tests import test_takeoff_workspace as fixtures


class TakeoffQuantityTransferTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def board_item(self, quantity=3, length=7.123456789012345):
        identity = self.case.create(quantity=quantity,
            measurement={'method': 'cited', 'length_m': length, 'citation': 'Plan dimension'},
            fields={'mark': 'B17', 'section': '100UC15', 'member_type': 'Beam',
                    'exposure': 'Re-entrant - 3 sides', 'fire_period_min': 120,
                    'critical_temperature': 620, 'product': 'TRAFALGAR COREX', 'sides': 3})
        self.case.confirm(identity)
        return identity

    def test_grouped_board_members_keep_aggregated_length_and_unit_row_quantity(self):
        length = 7.123456789012345
        identity = self.board_item(length=length)
        before = deepcopy(self.case.state['snapshot'])
        preview = self.case.preview(identity, 'steel_board')
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        values = preview['inputs']['CALCULATOR']
        self.assertEqual(values['F9'], length * 3)
        self.assertEqual(values['CJ9'], 1)
        binding = preview['bindings'][0]
        self.assertEqual(binding['values']['CJ9'], 1)
        self.assertEqual(binding['input_hash'], digest(binding['values']))
        self.assertEqual(binding['source_sha256'], source_model('steel_board')['source']['sha256'])
        one_run = deepcopy(preview['inputs'])
        one_run['CALCULATOR']['F9'] = length
        _, actual, actual_lock = calculator_session('steel_board', preview['inputs'])
        _, one, one_lock = calculator_session('steel_board', one_run)
        with actual_lock, one_lock:
            self.assertEqual(actual.value('CALCULATOR', 'AR9'), 'CLADDING ESTIMATE')
            for column in ('AD', 'AE', 'AF', 'AL', 'AM'):
                self.assertAlmostEqual(actual.value('CALCULATOR', column + '9'),
                                       one.value('CALCULATOR', column + '9') * 3, places=11)
        self.case.apply(preview)
        self.assertEqual(self.case.state['snapshot']['items'][0]['quantity'], 3)
        self.assertEqual(self.case.state['snapshot']['items'][0]['member_ids'], before['items'][0]['member_ids'])
        self.case.command('update_item', item_id=identity, changes={'quantity': 2})
        self.case.confirm(identity)
        refresh = self.case.preview(identity, 'steel_board', inputs=preview['inputs'],
                                    rows=preview['schedule_rows'], update=True)
        self.assertEqual(refresh['inputs']['CALCULATOR']['F9'], length * 2)
        self.assertEqual(refresh['inputs']['CALCULATOR']['CJ9'], 1)
        self.assertEqual(refresh['bindings'][0]['id'], binding['id'])

    def test_single_duct_run_transfers_unit_quantity_and_exact_hand_takeoff(self):
        identity = self.case.create('duct', quantity=1)
        self.case.command('update_item', item_id=identity, changes={'fields': {
            'width_mm': 250, 'height_mm': 250, 'orientation': 'Both',
            'wall_penetrations': 1, 'floor_penetrations': 1}})
        self.case.confirm(identity)
        before = deepcopy(self.case.state['snapshot'])
        preview = self.case.preview(identity, 'ductwork')
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        values = preview['inputs']['CALCULATOR']
        self.assertEqual((values['D11'], values['CM11'], values['F11'], values['G11']), (10, 1, 1, 1))
        self.assertEqual(preview['bindings'][0]['values']['CM11'], 1)
        _, engine, lock = calculator_session('ductwork', preview['inputs'])
        with lock:
            self.assertEqual(engine.value('CALCULATOR', 'K11'), 10)
            self.assertAlmostEqual(engine.value('CALCULATOR', 'N11'), 27.8096, places=8)
        self.case.apply(preview)
        drafts = {'ductwork': {key: deepcopy(self.case.state['calculator'][key])
                              for key in ('inputs', 'schedule_rows')}}
        request = {'expected_revision': self.case.state['revision'], 'calculator_drafts': drafts}
        linked = self.case.service.linked_register_results(self.case.sid, request)['linked_results'][identity][0]
        self.assertEqual(linked['status'], 'Current')
        drafts['ductwork']['inputs']['CALCULATOR']['CM11'] = 2
        edited = self.case.service.linked_register_results(self.case.sid, request)['linked_results'][identity][0]
        self.assertEqual(edited['status'], 'Unavailable')
        self.assertIsNone(edited['duct_surface_m2'])

    def test_old_row_hashes_omit_only_genuinely_absent_added_quantity(self):
        for calculator, row, old_columns, quantity_column in (
            ('steel_board', 9, 'ABCDEFGHIJKLMNOPQRSTUVWX', 'CJ'),
            ('ductwork', 11, 'BCDEFGHI', 'CM'),
        ):
            with self.subTest(calculator=calculator):
                cells = {'C' + str(row): 'Historical product', 'F' + str(row): 0}
                inputs = {'CALCULATOR': cells}
                original = deepcopy(inputs)
                # Literal pre-Quantity columns are an independent old-format
                # oracle, rather than another call to the current row mapper.
                expected = {column + str(row): cells.get(column + str(row)) for column in old_columns}
                schedule = source_model(calculator)['schedule']
                actual = row_values(inputs, schedule, row)
                self.assertEqual(actual, expected)
                self.assertEqual(digest(actual), digest(expected))
                self.assertEqual(inputs, original)
                address = quantity_column + str(row)
                for value in (None, 1):
                    explicit = {'CALCULATOR': {**cells, address: value}}
                    expected_explicit = {**expected, address: value}
                    self.assertEqual(row_values(explicit, schedule, row), expected_explicit)
                    self.assertNotEqual(digest(expected_explicit), digest(expected))

    def test_old_board_binding_refresh_retains_omitted_quantity_and_binding_id(self):
        identity = self.board_item()
        preview = self.case.preview(identity, 'steel_board')
        legacy_inputs = deepcopy(preview['inputs'])
        legacy_inputs['CALCULATOR'].pop('CJ9')
        binding = deepcopy(preview['bindings'][0])
        binding['values'].pop('CJ9')
        binding['input_hash'] = digest(binding['values'])
        snapshot = deepcopy(self.case.state['snapshot'])
        snapshot['transfers'].append(binding)
        before = deepcopy(snapshot)
        result = transfer_preview(snapshot, {
            'expected_revision': snapshot['revision'], 'calculator_id': 'steel_board',
            'inputs': legacy_inputs, 'schedule_rows': preview['schedule_rows'],
            'item_ids': [identity], 'update_linked': True})
        self.assertEqual(result['changes'], [{'item_id': identity, 'row': 9, 'action': 'unchanged'}])
        self.assertEqual(result['bindings'][0], binding)
        self.assertNotIn('CJ9', result['inputs']['CALCULATOR'])
        self.assertEqual(snapshot, before)

    def test_board_patch_additional_slot_requires_its_exact_quantity_address(self):
        identity = self.board_item()
        binding = deepcopy(self.case.preview(identity, 'steel_board')['bindings'][0])
        self.assertEqual(len(binding['values']), 25)
        self.assertEqual(binding['values']['CJ9'], 1)
        snapshot = deepcopy(self.case.state['snapshot'])
        snapshot['transfers'].append(binding)
        validate_snapshot(snapshot)
        legacy = deepcopy(snapshot)
        legacy['transfers'][0]['values'].pop('CJ9')
        legacy['transfers'][0]['input_hash'] = digest(legacy['transfers'][0]['values'])
        validate_snapshot(legacy)
        for keep_quantity, extra_address in ((True, 'AZ9'), (False, 'AZ9'), (False, 'CJ10')):
            with self.subTest(keep_quantity=keep_quantity, extra_address=extra_address):
                invalid = deepcopy(snapshot)
                patch = invalid['transfers'][0]['values']
                if not keep_quantity:
                    patch.pop('CJ9')
                patch[extra_address] = 1
                invalid['transfers'][0]['input_hash'] = digest(patch)
                with self.assertRaisesRegex(ValidationError, 'bounded input patch'):
                    validate_snapshot(invalid)


if __name__ == '__main__':
    unittest.main()
