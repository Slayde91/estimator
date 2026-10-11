"""Automatic text/image Stamp sizing and local resize retain quantity authority."""
from copy import deepcopy
from io import BytesIO
import base64
import math
import unittest

from PIL import Image
from estimator.catalog import ValidationError
from estimator.takeoff_graphics import graphic_font_size, validate_history
from estimator.takeoff_stamp_layout import stamp_layout, validate_stamp_fit
from estimator.takeoff_textbox_layout import validate_textbox_fit
from tests import test_takeoff_workspace as fixtures


class StampLayoutTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)

    def value(self, **changes):
        case = self.case
        return {'mode': 'wall', 'document_id': case.doc['id'], 'source_sha256': case.doc['sha256'],
                'page': 1, 'anchor_pdf': [110, 70], 'display_rotation': 0, 'text': 'REVIEWED', 'appearance': {}, **changes}

    def test_atomic_text_stamp_centred_for_all_rotations_and_retained_crop_userunit(self):
        case = self.case
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                before = deepcopy(case.state['snapshot'])
                value = self.value(display_rotation=rotation, appearance={'font_size': 9, 'opacity': .756789123})
                prepared = stamp_layout(before, value)
                reply = case.command('create_stamp', stamp=value)
                record = reply['snapshot']['graphics']['records'][-1]
                self.assertEqual(record['geometry'], prepared['graphic']['geometry'])
                self.assertEqual(record['appearance']['font_size'], 9)
                self.assertEqual(record['appearance']['opacity'], .756789123)
                self.assertEqual(reply['stamp_layout'], prepared['layout'])
                quad = record['geometry']['quad_pdf']
                for axis in (0, 1): self.assertAlmostEqual(sum(p[axis] for p in quad)/4, value['anchor_pdf'][axis])
                self.assertAlmostEqual(math.dist(quad[0], quad[1])*2, reply['stamp_layout']['width_pt'])
                self.assertTrue(all(10 <= x <= 210 and 20 <= y <= 120 for x, y in quad))
                for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
                    self.assertEqual(reply['snapshot'][key], before[key])
                validate_stamp_fit(record, reply['snapshot'])

    def test_image_sizing_preserves_canonical_pixels_and_aspect_without_paths(self):
        output = BytesIO(); Image.new('RGB', (320, 160), '#123456').save(output, format='PNG')
        upload = {'mime_type': 'image/png', 'content_base64': base64.b64encode(output.getvalue()).decode('ascii')}
        value = self.value(text='', stamp_image=upload)
        reply = self.case.command('create_stamp', stamp=value)
        record = reply['snapshot']['graphics']['records'][0]
        self.assertEqual((record['stamp_image']['width'], record['stamp_image']['height']), (320, 160))
        self.assertAlmostEqual((reply['stamp_layout']['width_pt']-12)/(reply['stamp_layout']['height_pt']-12), 2, delta=1e-7)
        self.assertNotIn('text_scale', record['geometry'])

    def test_invalid_text_source_rotation_image_and_edge_fail_atomically(self):
        before = deepcopy(self.case.state['snapshot'])
        for changes in ({'anchor_pdf': [10, 20]}, {'text': 'bad\nline'}, {'text': '\U0001F984'},
                        {'source_sha256': 'b'*64}, {'display_rotation': 45}, {'text': ' '},
                        {'stamp_image': {'mime_type': 'image/svg+xml', 'content_base64': 'AQID'}}, {'text': 'x'*81}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.case.command('create_stamp', stamp=self.value(**changes))
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'], before)

    def test_local_resized_textbox_scales_font_without_rewriting_rich_content_or_appearance(self):
        case = self.case
        content = {'version': 1, 'blocks': [{'kind': 'paragraph', 'runs': [{'text': 'Rich', 'bold': True, 'italic': True, 'underline': True}]}]}
        value = self.value(text='Rich', text_content=content, anchor_pdf=[70, 90], appearance={'font_size': 9})
        case.command('create_textbox', textbox=value)
        old = deepcopy(case.state['snapshot']['graphics']['records'][0]); origin = old['geometry']['quad_pdf'][0]
        geometry = {'quad_pdf': [[origin[i]+(point[i]-origin[i])*1.5 for i in (0, 1)] for point in old['geometry']['quad_pdf']], 'text_scale': 1.5}
        case.command('update_graphic', graphic_id=old['id'], changes={'geometry': geometry})
        record = case.state['snapshot']['graphics']['records'][0]
        self.assertEqual(record['appearance'], old['appearance']); self.assertEqual(record['text_content'], content)
        self.assertEqual(graphic_font_size(record), 13.5); validate_textbox_fit(record, case.state['snapshot'])
        for bad in (0, -1, float('inf'), True, .0001, 1001):
            retained = deepcopy(case.state['snapshot'])
            with self.assertRaises(ValidationError): case.command('update_graphic', graphic_id=record['id'], changes={'geometry': {**geometry, 'text_scale': bad}})
            self.assertEqual(case.service.get(case.sid)['snapshot'], retained)

    def test_stamp_history_cannot_masquerade_as_shape_or_change_quantity_state(self):
        reply = self.case.command('create_stamp', stamp=self.value())
        event = deepcopy(self.case.documents.get_blob(reply['snapshot']['audit_head']))
        validate_history(event)
        event['after']['graphics']['records'][0]['kind'] = 'rectangle'
        with self.assertRaises(ValidationError): validate_history(event)
        event['after'] = deepcopy(reply['snapshot']); event['after']['transfers'].append({'fabricated': True})
        with self.assertRaises(ValidationError): validate_history(event)


if __name__ == '__main__': unittest.main()
