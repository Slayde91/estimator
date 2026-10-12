"""Counted duct runs retain native one-run rows and explicit manual lengths."""
from copy import deepcopy
import json
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.schedule_rows import empty_schedule_inputs
from estimator.takeoff_model import item_result, validate_snapshot
from estimator.takeoff_transfer import mapped_values
from estimator.workbook_calculators import calculator_session
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_project as project_fixtures
from tests.test_takeoff_counts import FIELDS as STEEL_FIELDS


FIELDS = {'mark': 'Duct 1', 'level': 'Ground', 'zone': 'East', 'shape': 'rectangular',
          'width_mm': 600.1234567890123, 'height_mm': 400, 'frl': '120/120/120',
          'orientation': 'Horizontal', 'exposure': 'Internal', 'product': 'FyreWrap',
          'wall_penetrations': 0, 'floor_penetrations': 0, 'riser': False,
          'notes': 'Operator entered length in millimetres.'}
LEGACY_FIELDS = {'mark': 'Legacy grille', 'level': 'Ground', 'width_mm': 250,
                 'height_mm': 250, 'frl': '-/120/120', 'orientation': 'Horizontal'}


class DuctCountTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        # Manual lengths do not inherit calibration or PDF rotation/UserUnit.
        self.case.state = self.case.service.open(); self.case.sid = self.case.state['session_id']
        self.case.state = self.case.service.add_document(self.case.sid, self.case.doc, 0)
        self.case.command('record_render', document_id=self.case.doc['id'], page=1, success=True, warnings=[])

    def add(self, lengths=(1.1234567890123, 1.1234567890123, 2.5), **changes):
        return self.case.command('add_count_items', mode='duct', document_id=self.case.doc['id'], page=1,
            markers=[{'point': [30 + 25 * index, 40 + 5 * index], 'length_m': length}
                     for index, length in enumerate(lengths)],
            fields=deepcopy(FIELDS), appearance={'marker_shape': 'diamond', 'marker_size': 18},
            **changes)['created_item_ids']

    def item(self, identifier):
        return next(item for item in self.case.state['snapshot']['items'] if item['id'] == identifier)

    def reject(self, op, **values):
        before = deepcopy(self.case.state['snapshot']); audit = deepcopy(self.case.documents.blobs)
        with self.assertRaises(ValidationError): self.case.command(op, **values)
        self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)
        self.assertEqual(self.case.documents.blobs, audit)

    def preview(self, identifiers, inputs=None, rows=None, update=False):
        return self.case.service.preview_transfer(self.case.sid, {
            'expected_revision': self.case.state['revision'], 'calculator_id': 'ductwork',
            'inputs': inputs if inputs is not None else empty_schedule_inputs('ductwork'),
            'schedule_rows': rows if rows is not None else [11], 'item_ids': identifiers,
            'update_linked': update})

    def test_equal_lengths_create_distinct_native_runs_in_marker_order_with_complete_fields(self):
        entered_mm = 1123.4567890123
        length_m = entered_mm / 1000
        lengths = (length_m, 2.5, length_m)
        identifiers = self.add(lengths)
        items = [self.item(identifier) for identifier in identifiers]
        self.assertEqual(len(items), 3)
        self.assertEqual(len({item['count_id'] for item in items}), 1)
        self.assertEqual(len({member for item in items for member in item['member_ids']}), 3)
        for index, (item, length) in enumerate(zip(items, lengths)):
            self.assertEqual(item['mode'], 'duct'); self.assertNotIn('purpose', item)
            self.assertEqual(item['fields'], FIELDS)
            self.assertEqual(item['quantity'], 1)
            self.assertEqual(item['geometry']['kind'], 'count')
            self.assertEqual(item['geometry']['points'], [[30 + index * 25, 40 + index * 5]])
            self.assertEqual(item['measurement'], {'method': 'manual', 'length_m': length})
            result = item_result(item, self.case.state['snapshot'])
            self.assertEqual((result['length_m'], result['total_length_m'], result['issues']), (length, length, []))
        self.assertEqual(self.case.state['snapshot']['calibrations'], [])
        self.assertEqual(validate_snapshot(self.case.state['snapshot']), self.case.state['snapshot'])

    def test_steel_omitted_mode_contract_and_explicit_steel_grouping_remain_unchanged(self):
        values = {'document_id': self.case.doc['id'], 'page': 1,
                  'markers': [{'point': [30, 40], 'length_m': 1.25}, {'point': [50, 40], 'length_m': 1.25}],
                  'fields': {**STEEL_FIELDS, 'level': 'Ground', 'width_mm': 250,
                             'height_mm': 250, 'frl': '-/120/120', 'orientation': 'Horizontal'},
                  'appearance': {}}
        implicit = self.case.command('add_count_items', **values)['created_item_ids']
        explicit = self.case.command('add_count_items', mode='steel', **values)['created_item_ids']
        self.assertEqual((len(implicit), len(explicit)), (1, 1))
        first, second = self.item(implicit[0]), self.item(explicit[0])
        for name in ('mode', 'quantity', 'geometry', 'measurement', 'fields'):
            self.assertEqual(first[name], second[name])
        self.assertEqual(first['quantity'], 2)
        self.assertNotEqual(first['count_id'], second['count_id'])

    def test_invalid_modes_lengths_and_grouped_duct_forgeries_are_atomic(self):
        request = {'document_id': self.case.doc['id'], 'page': 1,
                   'markers': [{'point': [30, 40], 'length_m': 1.25}], 'fields': FIELDS, 'appearance': {}}
        for mode in ('wall', 'slab', None, True, [], {}):
            with self.subTest(mode=mode): self.reject('add_count_items', mode=mode, **request)
        for length in (None, 0, -1, True, float('nan'), float('inf'), 1e13):
            with self.subTest(length=length):
                self.reject('add_count_items', mode='duct', **{**request, 'markers': [
                    request['markers'][0], {'point': [50, 50], 'length_m': length}]})
        identifier = self.add((1.25,))[0]
        original = deepcopy(self.case.state['snapshot'])
        forged = deepcopy(original); item = forged['items'][0]
        item['quantity'] = 2; item['geometry']['points'].append([60, 70]); item['member_ids'].append(str(uuid4()))
        with self.assertRaisesRegex(ValidationError, 'own item with quantity 1'): validate_snapshot(forged)
        self.reject('update_item', item_id=identifier, changes={'quantity': 2})
        self.reject('create_item', item={name: deepcopy(self.item(identifier)[name])
                                       for name in ('mode', 'quantity', 'geometry', 'measurement', 'fields', 'count_id')})
        identifiers = self.add((1.25, 2.5))
        forged = deepcopy(self.case.state['snapshot'])
        next(item for item in forged['items'] if item['id'] == identifiers[1])['mode'] = 'steel'
        with self.assertRaisesRegex(ValidationError, 'same source, details'): validate_snapshot(forged)

    def test_continuation_adds_runs_without_replacing_confirmed_rows_and_retries_are_idempotent(self):
        identifiers = self.add((1.25, 1.25))
        for identifier in identifiers:
            self.case.command('update_item', item_id=identifier, changes={'evidence': [
                {'document_id': self.case.doc['id'], 'page': 1, 'note': 'Existing count evidence',
                 'fields': ['length_m', 'frl', 'product']}]})
        self.case.command('confirm_items', item_ids=identifiers)
        self.case.apply(self.preview(identifiers))
        before = deepcopy(self.case.state['snapshot']); calculator = deepcopy(self.case.state['calculator'])
        request = {'op': 'continue_count', 'request_id': str(uuid4()), 'expected_revision': before['revision'],
                   'item_id': identifiers[0], 'markers': [{'point': [100, 60], 'length_m': 1.25},
                                                        {'point': [120, 65], 'length_m': 2.5},
                                                        {'point': [140, 70], 'length_m': 1.25}]}
        self.case.state = self.case.service.command(self.case.sid, request)
        self.assertEqual(self.case.state, self.case.service.command(self.case.sid, request))
        created = self.case.state['created_item_ids']; self.assertEqual(len(created), 3)
        self.assertEqual(self.case.state['regrouped_item_ids'], identifiers + created)
        for previous in before['items']: self.assertEqual(self.item(previous['id']), previous)
        self.assertEqual(self.case.state['snapshot']['transfers'], before['transfers'])
        for identifier, marker in zip(created, request['markers']):
            item = self.item(identifier)
            for name in ('count_id', 'fields', 'evidence', 'appearance'):
                self.assertEqual(item[name], before['items'][0][name])
            self.assertEqual(item['quantity'], 1)
            self.assertEqual(item['geometry']['points'], [marker['point']])
            self.assertEqual(item['measurement']['length_m'], marker['length_m'])
        members = [member for item in self.case.state['snapshot']['items'] for member in item['member_ids']]
        self.assertEqual(len(set(members)), 5)
        self.assertNotIn('calculator', self.case.state)
        self.assertEqual(calculator['inputs']['CALCULATOR']['D11'], 1.25)
        self.case.command('undo')
        self.assertEqual([item['id'] for item in self.case.state['snapshot']['items']], identifiers)
        for old in before['items']:
            for name in ('member_ids', 'geometry', 'measurement', 'fields', 'count_id', 'evidence'):
                self.assertEqual(self.item(old['id'])[name], old[name])

    def test_continuation_rejects_partial_batches_and_stale_revisions_without_any_published_member(self):
        identifier = self.add((1.25,))[0]
        valid = {'point': [100, 60], 'length_m': 1.25}
        for invalid in ({'point': [0, 0], 'length_m': 1.25}, {'point': [120, 60], 'length_m': 0},
                        {'point': [120, 60], 'length_m': True}, {'point': [120, 60]},
                        {'point': [120, 60], 'length_m': 1.25, 'member_id': str(uuid4())}):
            self.reject('continue_count', item_id=identifier, markers=[valid, invalid])
        stale = self.case.state['revision']
        self.case.command('continue_count', item_id=identifier, markers=[valid])
        self.reject('continue_count', item_id=identifier, markers=[valid], expected_revision=stale)

    def test_length_edits_never_merge_duct_rows_and_shared_field_edits_require_whole_count(self):
        identifiers = self.add((1.25, 2.5)); originals = [deepcopy(self.item(identifier)) for identifier in identifiers]
        self.case.command('confirm_items', item_ids=identifiers)
        self.reject('update_item', item_id=identifiers[0], changes={'fields': {'product': 'FyreWrap Elite 1.5'}})
        self.case.command('update_count_lengths', groups=[{'member_ids': originals[1]['member_ids'], 'length_m': 1.25}])
        self.assertEqual(self.case.state['regrouped_item_ids'], identifiers)
        for original in originals:
            item = self.item(original['id'])
            self.assertEqual(item['member_ids'], original['member_ids']); self.assertEqual(item['quantity'], 1)
            self.assertEqual(item['measurement']['length_m'], 1.25)
        self.case.command('bulk_update', item_ids=identifiers, changes={'fields': {'level': 'Level 2'}})
        self.assertEqual([self.item(identifier)['fields']['level'] for identifier in identifiers], ['Level 2', 'Level 2'])
        self.assertEqual(len(self.case.state['snapshot']['items']), 2)
        self.case.command('delete_count_marker', item_id=identifiers[0], member_id=originals[0]['member_ids'][0])
        self.assertEqual([item['id'] for item in self.case.state['snapshot']['items']], [identifiers[1]])
        self.case.command('undo'); self.assertEqual(self.item(identifiers[0])['member_ids'], originals[0]['member_ids'])

    def test_transfer_keeps_separate_runs_and_matches_native_manual_inputs_without_extra_scaling(self):
        lengths = (1.1234567890123, 1.1234567890123)
        identifiers = self.add(lengths); self.case.command('confirm_items', item_ids=identifiers)
        preview = self.preview(identifiers)
        self.assertEqual([entry['row'] for entry in preview['bindings']], [11, 12])
        manual = empty_schedule_inputs('ductwork')
        for row, length in zip((11, 12), lengths):
            manual['CALCULATOR'].update({f'B{row}': '600.1234567890123x400', f'C{row}': 'FyreWrap',
                f'D{row}': length, f'E{row}': '120/120/120', f'F{row}': 0, f'G{row}': 0,
                f'H{row}': 'Internal', f'I{row}': 'Horizontal'})
            self.assertEqual(preview['inputs']['CALCULATOR'][f'D{row}'], length)
        _, actual, actual_lock = calculator_session('ductwork', preview['inputs'])
        _, expected, expected_lock = calculator_session('ductwork', manual)
        with actual_lock, expected_lock:
            for row in (11, 12):
                for column in ('J', 'K', 'L', 'M', 'N', 'O', 'R', 'V', 'W', 'X'):
                    self.assertEqual(actual.value('CALCULATOR', f'{column}{row}'),
                                     expected.value('CALCULATOR', f'{column}{row}'), (column, row))
        self.case.apply(preview)
        inputs = self.case.state['calculator']['inputs']; rows = self.case.state['calculator']['schedule_rows']
        repeated = self.preview(identifiers, inputs, rows)
        self.assertEqual(repeated['changes'], []); self.assertEqual(len(repeated['skipped']), 2)
        before = deepcopy(self.case.state['snapshot'])
        self.case.command('update_count_lengths', groups=[{'member_ids': self.item(identifiers[0])['member_ids'],
                                                        'length_m': 4.1234567890123}])
        self.case.command('confirm_items', item_ids=[identifiers[0]])
        refreshed = self.preview([identifiers[0]], inputs, rows, update=True)
        self.assertEqual(refreshed['changes'][0]['action'], 'update')
        self.assertEqual(refreshed['bindings'][0]['id'], before['transfers'][0]['id'])
        self.assertEqual(refreshed['inputs']['CALCULATOR']['D11'], 4.1234567890123)
        self.assertEqual(refreshed['inputs']['CALCULATOR']['D12'], lengths[1])

    def test_legacy_count_only_records_stay_unchanged_and_never_infer_lengths_or_transfer(self):
        identifier = self.case.command('add_standalone_count', mode='duct', document_id=self.case.doc['id'], page=1,
            markers=[{'point': [30, 40]}, {'point': [50, 60]}], fields=deepcopy(LEGACY_FIELDS),
            appearance={})['created_item_ids'][0]
        self.case.command('confirm_items', item_ids=[identifier]); original = deepcopy(self.item(identifier))
        self.add((1.25,))
        self.assertEqual(self.item(identifier), original)
        self.assertEqual(original['measurement'], None)
        result = item_result(original, self.case.state['snapshot'])
        self.assertEqual((result['total_count'], result['length_m'], result['total_length_m']), (2, None, None))
        with self.assertRaisesRegex(ValidationError, 'cannot be transferred'):
            mapped_values(original, self.case.state['snapshot'], 'ductwork', 11)
        self.reject('continue_count', item_id=identifier, markers=[{'point': [70, 70], 'length_m': 2}])
        self.reject('update_item', item_id=identifier, changes={'measurement': {'method': 'manual', 'length_m': 2}})


class DuctCountProjectTests(unittest.TestCase):
    def test_real_save_reopen_preserves_manual_and_legacy_counts_originals_and_calculators(self):
        case = project_fixtures.TakeoffProjectTests(); case.setUpClass(); case.setUp()
        self.addCleanup(case.doCleanups)
        def command(op, **values):
            case.session = case.service.command(case.session['session_id'], {'op': op, 'request_id': str(uuid4()),
                'expected_revision': case.session['revision'], **values})
            return case.session
        document = case.session['snapshot']['documents'][0]
        command('record_render', document_id=document['id'], page=1, success=True, warnings=[])
        command('add_standalone_count', mode='duct', document_id=document['id'], page=1,
            markers=[{'point': [80, 80]}, {'point': [120, 100]}], fields=deepcopy(LEGACY_FIELDS), appearance={})
        legacy = deepcopy(case.session['snapshot']['items'][0])
        identifiers = command('add_count_items', mode='duct', document_id=document['id'], page=1,
            markers=[{'point': [160, 80], 'length_m': 3.1234567890123},
                     {'point': [200, 100], 'length_m': 3.1234567890123}],
            fields=deepcopy(FIELDS), appearance={'marker_shape': 'square'})['created_item_ids']
        command('confirm_items', item_ids=identifiers)
        originals = [deepcopy(item) for item in case.session['snapshot']['items']]
        command('continue_count', item_id=identifiers[0],
                markers=[{'point': [240, 110], 'length_m': 5.1234567890123}])
        snapshot = deepcopy(case.session['snapshot'])
        self.assertEqual(snapshot['items'][0], legacy)
        case.request.update(takeoffs=snapshot, takeoffs_session_id=case.session['session_id'])
        case.library.save_as(case.request); saved = json.loads(case.target.read_bytes())
        self.assertEqual(saved['takeoffs']['items'], snapshot['items'])
        for key in ('estimate', 'calculators'): self.assertEqual(saved[key], json.loads(case.legacy)[key])
        case.dialogs.opened = str(case.target); reopened = case.library.open_file()
        self.assertEqual(reopened['takeoffs']['items'], snapshot['items'])
        self.assertEqual(reopened['takeoffs_issues'], [])
        self.assertEqual(case.documents.document_path(document).read_bytes(), case.pdf)
        for previous in originals:
            current = next(item for item in reopened['takeoffs']['items'] if item['id'] == previous['id'])
            for name in ('member_ids', 'geometry', 'measurement', 'fields', 'evidence'):
                self.assertEqual(current[name], previous[name])


if __name__ == '__main__': unittest.main()
