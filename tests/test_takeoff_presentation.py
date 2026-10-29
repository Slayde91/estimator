"""Colour presentation never changes the native calculator or item authority."""
from copy import deepcopy
import json
import math
import unittest
from uuid import uuid4

from estimator.catalog import ValidationError
from estimator.takeoff_model import validate_snapshot, item_digest
from estimator.takeoff_presentation import PALETTE, thickness_colour, apply_presentation, effective_appearance, legend_rows, dft_micron_text
from tests import test_takeoff_workspace as fixtures


class DrawingPresentationTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def test_exact_palette_nearest_rounding_and_open_ended_pine(self):
        self.assertEqual(len(PALETTE), 40)
        for index, (_, colour) in enumerate(PALETTE):
            self.assertEqual(thickness_colour(index*2+1), colour)
            self.assertEqual(thickness_colour(index*2+2), colour)
        for value, expected in [(14.49, '#78CC0C'), (14.5, '#D86000'), (15, '#D86000'), (35, '#CC0000'), (78.49, '#236778'), (78.5, '#184B3E'), (80, '#184B3E'), (1000, '#184B3E'), (.1, '#6C4848')]:
            self.assertEqual(thickness_colour(value), expected)
        for value in (None, 0, -1, float('nan'), float('inf'), True, '15'):
            self.assertIsNone(thickness_colour(value))

    def test_partial_palette_and_exact_restore_preserve_confirmation_and_receipts(self):
        identifier = self.case.create(appearance={'stroke_color': '#123456', 'fill_color': '#ABCDEF', 'stroke_width': 3})
        self.case.confirm(identifier)
        self.case.apply(self.case.preview(identifier))
        unknown = self.case.create()
        before = deepcopy(self.case.state['snapshot']); snapshot = deepcopy(before)
        linked = {identifier: [{'calculator_id': 'steel_vermiculite', 'status': 'Current', 'estimating_thickness_mm': 15.25}]}
        request = {'op': 'toggle_thickness_colours', 'document_id': self.case.doc['id'], 'calculator_id': 'steel_vermiculite'}
        apply_presentation(snapshot, request, linked); validate_snapshot(snapshot)
        item = snapshot['items'][0]
        self.assertEqual(snapshot['items'], before['items']); self.assertEqual(snapshot['transfers'], before['transfers'])
        self.assertEqual(item_digest(item, snapshot), item_digest(before['items'][0], before))
        self.assertEqual(effective_appearance(snapshot, item, linked)['stroke_color'], '#D86000')
        self.assertEqual(effective_appearance(snapshot, item, {})['stroke_color'], '#123456')
        self.assertIsNone(snapshot['drawing_presentation']['colour_modes'][0]['originals'][1]['colour'])
        item['appearance'].update(stroke_color='#FFFFFF', fill_color='#000000')
        apply_presentation(snapshot, request)
        self.assertEqual(item['appearance']['stroke_color'], '#123456'); self.assertEqual(item['appearance']['fill_color'], '#ABCDEF')
        self.assertEqual(item['confirmation'], before['items'][0]['confirmation'])
        self.assertEqual(snapshot['transfers'], before['transfers']); validate_snapshot(snapshot)
        self.assertEqual(snapshot['items'][1]['id'], unknown)

    def test_dft_palette_has_exact_250_micron_bins_without_changing_other_calculators(self):
        self.assertEqual(dft_micron_text(1.007), '1007')
        self.assertEqual(dft_micron_text(1.007, 1007.1234567890123), '1007.1234567890123')
        self.assertEqual(dft_micron_text(1e-7), '0.0001')
        for index, (_, colour) in enumerate(PALETTE):
            boundary = (index + 1) / 4
            for value in (boundary, math.nextafter(boundary, 0)):
                self.assertEqual(thickness_colour(value, 'steel_intumescent', palette_version=2), colour)
            above = math.nextafter(boundary, math.inf)
            self.assertEqual(thickness_colour(above, 'steel_intumescent', palette_version=2),
                             PALETTE[index + 1][1] if index < 39 else None)
        self.assertEqual(thickness_colour(.548, 'steel_intumescent', palette_version=2), PALETTE[2][1])
        for value in (None, 0, -1, float('nan'), float('inf'), True, '0.25', 10.00000001):
            self.assertIsNone(thickness_colour(value, 'steel_intumescent', palette_version=2))
        for calculator in ('steel_board', 'steel_vermiculite'):
            for value in (.548, 14.5, 30, 80, 1000):
                self.assertEqual(thickness_colour(value, calculator, palette_version=2), thickness_colour(value))

    def test_legacy_saved_colour_mode_keeps_its_palette_until_restore_and_new_toggle(self):
        identifier = self.case.create(appearance={'stroke_color': '#123456', 'fill_color': '#ABCDEF', 'font_color': '#123456'})
        before = deepcopy(self.case.state['snapshot']); snapshot = deepcopy(before)
        linked = {identifier: [{'calculator_id': 'steel_intumescent', 'status': 'Current',
                               'intumescent_thickness_mm': .548, 'intumescent_dft_um': 548}]}
        request = {'op': 'toggle_thickness_colours', 'document_id': self.case.doc['id'], 'calculator_id': 'steel_intumescent'}
        apply_presentation(snapshot, request, linked)
        mode = snapshot['drawing_presentation']['colour_modes'][0]
        mode.pop('palette_version'); mode['originals'][0]['colour'] = thickness_colour(.548)
        restored = json.loads(json.dumps(snapshot)); validate_snapshot(restored)
        self.assertNotIn('palette_version', restored['drawing_presentation']['colour_modes'][0])
        self.assertEqual(effective_appearance(restored, restored['items'][0], linked)['stroke_color'], PALETTE[0][1])
        apply_presentation(restored, request)
        self.assertEqual(restored['items'], before['items'])
        apply_presentation(restored, request, linked); validate_snapshot(restored)
        self.assertEqual(restored['drawing_presentation']['colour_modes'][0]['palette_version'], 2)
        self.assertEqual(effective_appearance(restored, restored['items'][0], linked)['stroke_color'], PALETTE[2][1])
        self.assertEqual(restored['items'], before['items']); self.assertEqual(restored['transfers'], before['transfers'])
        for bad in (True, 0, 3, '2'):
            invalid = deepcopy(restored); invalid['drawing_presentation']['colour_modes'][0]['palette_version'] = bad
            with self.assertRaisesRegex(ValidationError, 'palette version'):
                validate_snapshot(invalid)
        invalid = deepcopy(restored); invalid['drawing_presentation']['colour_modes'][0]['originals'][0]['colour'] = PALETTE[0][1]
        with self.assertRaisesRegex(ValidationError, 'reference palette'):
            validate_snapshot(invalid)

    def test_dft_range_native_mixed_sources_and_stale_guards_are_independent(self):
        ids = [self.case.create(appearance={'stroke_color': '#123456'}) for _ in range(4)]
        snapshot = deepcopy(self.case.state['snapshot']); before = deepcopy(snapshot)
        linked = {ids[0]: [{'calculator_id': 'steel_intumescent', 'status': 'Current', 'intumescent_thickness_mm': .548, 'intumescent_dft_um': 548}],
                  ids[1]: [{'calculator_id': 'steel_board', 'status': 'Current', 'total_thickness_mm': 30}],
                  ids[2]: [{'calculator_id': 'steel_intumescent', 'status': 'Current', 'intumescent_thickness_mm': 10.000125, 'intumescent_dft_um': 10000.125}],
                  ids[3]: [{'calculator_id': 'steel_intumescent', 'status': 'Current', 'intumescent_thickness_mm': 0}]}
        apply_presentation(snapshot, {'op': 'toggle_thickness_colours', 'document_id': self.case.doc['id'], 'calculator_id': 'steel_vermiculite'}, linked)
        validate_snapshot(snapshot)
        rows = snapshot['drawing_presentation']['colour_modes'][0]['originals']
        self.assertEqual([row['calculator_id'] for row in rows[:3]], ['steel_intumescent', 'steel_board', 'steel_intumescent'])
        self.assertEqual([row['colour'] for row in rows], [PALETTE[2][1], thickness_colour(30), None, None])
        self.assertEqual(rows[2]['thickness_mm'], 10.000125)
        self.assertEqual(effective_appearance(snapshot, snapshot['items'][2], linked)['stroke_color'], '#123456')
        legend = {'document_id': self.case.doc['id'], 'page': 1, 'mode': 'steel'}
        for viewer in (False, True):
            descriptions = legend_rows(snapshot, legend, {}, linked, viewer=viewer, calculator_id='steel_board')
            self.assertIn('548 µm', descriptions[0]['text']); self.assertIn('30 mm', descriptions[1]['text'])
            self.assertIn('10000.125 µm (outside 0–10,000 µm colour scale)', descriptions[2]['text'])
            self.assertIn('Thickness missing/unavailable', descriptions[3]['text'])
        changed = deepcopy(linked); changed[ids[0]][0]['intumescent_thickness_mm'] = .549
        self.assertEqual(effective_appearance(snapshot, snapshot['items'][0], changed)['stroke_color'], '#123456')
        changed[ids[0]][0]['status'] = 'Unavailable'
        self.assertEqual(effective_appearance(snapshot, snapshot['items'][0], changed)['stroke_color'], '#123456')
        snapshot['items'][0]['fields']['mark'] = 'Changed source'
        self.assertEqual(effective_appearance(snapshot, snapshot['items'][0], linked)['stroke_color'], '#123456')
        self.assertEqual(snapshot['items'][1:], before['items'][1:]); self.assertEqual(snapshot['transfers'], before['transfers'])

    def test_native_toggle_is_audited_idempotent_and_rejects_stale_revision(self):
        identifier = self.case.create(); self.case.confirm(identifier); self.case.apply(self.case.preview(identifier))
        native = self.case.state['calculator']; drafts = {'steel_vermiculite': {key: native[key] for key in ('inputs', 'schedule_rows')}}
        before = deepcopy(self.case.state['snapshot'])
        request = {'op': 'toggle_thickness_colours', 'expected_revision': before['revision'], 'request_id': str(uuid4()),
                   'document_id': self.case.doc['id'], 'calculator_id': 'steel_vermiculite', 'calculator_drafts': drafts}
        reply = self.case.service.command(self.case.sid, request)
        self.assertEqual(reply, self.case.service.command(self.case.sid, request))
        self.assertEqual(reply['snapshot']['items'], before['items']); self.assertEqual(reply['snapshot']['transfers'], before['transfers'])
        self.assertNotEqual(reply['snapshot']['audit_head'], before['audit_head'])
        with self.assertRaises(ValidationError):
            self.case.service.command(self.case.sid, {**request, 'request_id': str(uuid4())})

    def test_mixed_spray_and_board_drawings_use_each_current_native_source(self):
        spray = self.case.create(); board = self.case.create()
        snapshot = deepcopy(self.case.state['snapshot'])
        linked = {spray: [{'calculator_id': 'steel_vermiculite', 'status': 'Current', 'estimating_thickness_mm': 14.5}],
                  board: [{'calculator_id': 'steel_board', 'status': 'Current', 'total_thickness_mm': 30}]}
        apply_presentation(snapshot, {'op': 'toggle_thickness_colours', 'document_id': self.case.doc['id'], 'calculator_id': 'steel_vermiculite'}, linked)
        validate_snapshot(snapshot)
        originals = snapshot['drawing_presentation']['colour_modes'][0]['originals']
        self.assertEqual([row['calculator_id'] for row in originals], ['steel_vermiculite', 'steel_board'])
        self.assertEqual([row['colour'] for row in originals], ['#D86000', '#C7AD85'])
        self.assertEqual(effective_appearance(snapshot, snapshot['items'][1], linked)['stroke_color'], '#C7AD85')
        self.assertEqual(effective_appearance(snapshot, snapshot['items'][1], {})['stroke_color'], '#FF0000')

    def test_legend_portable_bounds_isolation_and_exact_native_thickness(self):
        identifier = self.case.create('duct'); snapshot = deepcopy(self.case.state['snapshot'])
        legend = {'id': str(uuid4()), 'document_id': self.case.doc['id'], 'page': 1, 'mode': 'duct', 'point': [40, 90],
                  'width': 100, 'height': 60, 'visible': True, 'appearance': {'stroke_color': '#123456', 'fill_color': '#FFFFFF'}}
        apply_presentation(snapshot, {'op': 'set_legend', 'legend': legend}); validate_snapshot(snapshot)
        linked = {identifier: [{'calculator_id': 'ductwork', 'status': 'Current', 'duct_thickness_mm': 38.125}]}
        rows = legend_rows(snapshot, legend, {identifier: {'total_length_m': 20}}, linked)
        self.assertIn('600 x 400 mm', rows[0]['text']); self.assertIn('20 m', rows[0]['text']); self.assertIn('38.125 mm', rows[0]['text'])
        self.assertEqual(legend_rows(snapshot, {**legend, 'mode': 'steel'}, {}, linked), [])
        for changes in ({'point': [0, 0]}, {'width': 1}, {'appearance': {'stroke_color': 'url(bad)'}}):
            with self.assertRaises(ValidationError):
                apply_presentation(deepcopy(snapshot), {'op': 'set_legend', 'legend': {**legend, **changes}})


if __name__ == '__main__':
    unittest.main()
