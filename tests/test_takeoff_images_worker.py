"""Synthetic image-source retention, occurrence provenance and fail-closed limits."""

from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from uuid import UUID
import zlib

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, BooleanObject, DictionaryObject, EncodedStreamObject, NameObject, NumberObject, RectangleObject, TextStringObject

from estimator import takeoff_image_worker as worker


def stream(data, **fields):
    value = EncodedStreamObject(); value._data = data
    for key, item in fields.items():
        value[NameObject('/'+key)] = item
    return value


def image(data=None, width=2, height=1, color='/DeviceRGB', filter='/FlateDecode'):
    raw = zlib.compress(bytes([255, 0, 0, 0, 255, 0])) if data is None else data
    value = stream(raw, Type=NameObject('/XObject'), Subtype=NameObject('/Image'), Width=NumberObject(width),
                   Height=NumberObject(height), BitsPerComponent=NumberObject(8), ColorSpace=NameObject(color))
    if filter:
        value[NameObject('/Filter')] = NameObject(filter)
    return value


def pdf(writer):
    output = BytesIO(); writer.write(output); return output.getvalue()


def make_pdf(content=b'q 40 0 0 20 10 20 cm /Im Do Q', source=None, pages=1, form=False):
    writer = PdfWriter(); reference = writer._add_object(source or image())
    objects = DictionaryObject({NameObject('/Im'): reference})
    if form:
        value = stream(b'q 5 0 0 6 0 0 cm /Im Do Q', Type=NameObject('/XObject'), Subtype=NameObject('/Form'),
                       BBox=RectangleObject([0, 0, 10, 10]), Matrix=ArrayObject([NumberObject(v) for v in [2, 0, 0, 2, 3, 4]]),
                       Resources=DictionaryObject({NameObject('/XObject'): objects}))
        objects = DictionaryObject({NameObject('/Fm'): writer._add_object(value)})
    for index in range(pages):
        page = writer.add_blank_page(width=200, height=200)
        page[NameObject('/Resources')] = writer._add_object(DictionaryObject({NameObject('/XObject'): writer._add_object(objects)}))
        page[NameObject('/Contents')] = writer._add_object(stream(content))
        if index == 1:
            page.cropbox = RectangleObject([5, 7, 195, 190]); page.rotate(90)
            page[NameObject('/UserUnit')] = NumberObject(2)
    return pdf(writer)


class TakeoffImageWorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.sequence = 0

    def extract(self, data, **kwargs):
        self.sequence += 1
        source = self.root/f'source-{self.sequence}.pdf'; source.write_bytes(data)
        target = self.root/f'extraction-{self.sequence}'
        result = worker.extract_images(source, target, sha256(data).hexdigest(), **kwargs)
        for entry in result['files']:
            path = target/entry['relative_path']
            self.assertRegex(entry['relative_path'], r'^(originals|renditions|decoder)/[a-f0-9]{64}\.(bin|png)$')
            self.assertEqual(path.stat().st_size, entry['size'])
            self.assertEqual(sha256(path.read_bytes()).hexdigest(), entry['sha256'])
        self.assertEqual({str(p.relative_to(target)).replace('\\', '/') for p in target.rglob('*') if p.is_file()},
                         {entry['relative_path'] for entry in result['files']})
        return result, target

    def test_repeated_xobject_retains_original_stream_and_distinct_paint_occurrences(self):
        original = image()
        data = make_pdf(b'q 40 0 0 20 10 20 cm /Im Do Q q 40 0 0 20 70 20 cm /Im Do Q', source=original, pages=2)
        result, target = self.extract(data, page_count=2)
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['coverage']['complete_pages'], [1, 2])
        self.assertEqual(len(result['assets']), 1)
        self.assertEqual(len(result['occurrences']), 4)
        self.assertEqual(len({occ['id'] for occ in result['occurrences']}), 4)
        asset = result['assets'][0]
        self.assertEqual(str(UUID(asset['id'])), asset['id'])
        self.assertEqual((target/asset['original']['relative_path']).read_bytes(), original._data)
        self.assertEqual(asset['original']['kind'], 'encoded-image-stream')
        self.assertTrue(asset['rendition']['derivative']); self.assertFalse(asset['rendition']['page_composite'])
        with Image.open(target/asset['rendition']['relative_path']) as rendered:
            self.assertEqual(list(rendered.get_flattened_data()), [(255, 0, 0), (0, 255, 0)])
        first, _, second, _ = result['occurrences']
        self.assertEqual(first['ctm'], [40, 0, 0, 20, 10, 20])
        self.assertEqual(first['quad_pdf'], second['quad_pdf'])
        self.assertEqual(second['rotation'], 90); self.assertEqual(second['user_unit'], 2)
        self.assertEqual(second['page_boxes']['crop_box'], [5, 7, 195, 190])
        repeated, _ = self.extract(data, page_count=2)
        self.assertEqual([a['id'] for a in repeated['assets']], [a['id'] for a in result['assets']])
        self.assertEqual([a['id'] for a in repeated['occurrences']], [a['id'] for a in result['occurrences']])

    def test_recursive_form_placements_are_composed_for_each_invocation(self):
        result, _ = self.extract(make_pdf(b'q 1 0 0 1 10 20 cm /Fm Do Q q 1 0 0 1 30 40 cm /Fm Do Q', form=True))
        self.assertEqual(result['issues'], [])
        self.assertEqual(len(result['assets']), 1)
        self.assertEqual([occ['ctm'] for occ in result['occurrences']], [[10, 0, 0, 12, 13, 24], [10, 0, 0, 12, 33, 44]])
        self.assertIn('/Fm', result['occurrences'][0]['operator_path'])
        self.assertEqual(result['occurrences'][0]['clip_context'][-1]['kind'], 'form-bbox')

    def test_inline_original_keeps_exact_whitespace_and_enclosing_encoded_stream(self):
        inline = b'BI /W 2 /H 1 /BPC 8 /CS /RGB /F /AHx ID   ff0000 00ff00 > EI'
        content = b'q 40 0 0 20 10 20 cm '+inline+b' Q'
        result, target = self.extract(make_pdf(content))
        self.assertEqual(result['issues'], [])
        asset = result['assets'][0]; original = asset['original']
        self.assertEqual(original['kind'], 'inline-decoded-content-span')
        self.assertEqual((target/original['relative_path']).read_bytes(), inline)
        enclosing = original['enclosing_streams'][0]['encoded_stream']
        self.assertEqual((target/enclosing['relative_path']).read_bytes(), content)
        self.assertEqual(content[original['decoded_start']:original['decoded_end']], inline)
        self.assertTrue(original['decoder_payload']['may_be_normalized'])
        self.assertNotEqual((target/original['decoder_payload']['relative_path']).read_bytes(), inline)
        self.assertEqual(asset['source_locator']['original_settings']['type'], 'dictionary')
        self.assertIsNotNone(asset['rendition'])

    def test_same_bytes_with_different_color_metadata_are_not_the_same_asset(self):
        writer = PdfWriter(); raw = zlib.compress(bytes([1, 2, 3, 4, 5, 6]))
        rgb = writer._add_object(image(raw)); gray = writer._add_object(image(raw, width=6, color='/DeviceGray'))
        page = writer.add_blank_page(width=200, height=200)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/A'): rgb, NameObject('/B'): gray})})
        page[NameObject('/Contents')] = writer._add_object(stream(b'q 30 0 0 30 10 10 cm /A Do Q q 30 0 0 30 50 10 cm /B Do Q'))
        result, _ = self.extract(pdf(writer))
        self.assertEqual(result['issues'], []); self.assertEqual(len(result['assets']), 2)
        self.assertEqual(result['assets'][0]['original']['sha256'], result['assets'][1]['original']['sha256'])
        self.assertNotEqual(result['assets'][0]['id'], result['assets'][1]['id'])

    def test_corrupt_image_retains_original_and_reports_partial_coverage(self):
        source = image(b'broken jpeg', filter='/DCTDecode')
        result, target = self.extract(make_pdf(source=source))
        self.assertEqual(result['pages'][0]['status'], 'partial')
        asset = result['assets'][0]
        self.assertEqual((target/asset['original']['relative_path']).read_bytes(), b'broken jpeg')
        self.assertIsNone(asset['rendition'])
        self.assertIn('IMAGE_DECODE_FAILED', {issue['code'] for issue in asset['issues']})
        self.assertEqual(result['coverage']['failed_pages'], [1])

    def test_unsupported_masks_colors_and_filters_never_create_approved_renditions(self):
        mask = image(); mask[NameObject('/SMask')] = image(color='/DeviceGray', width=6)
        for source, code in ((mask, 'UNSUPPORTED_IMAGE_MASK'), (image(color='/DeviceCMYK'), 'UNSUPPORTED_COLOR_SPACE'),
                             (image(filter='/JBIG2Decode'), 'UNSUPPORTED_IMAGE_FILTER')):
            with self.subTest(code=code):
                result, _ = self.extract(make_pdf(source=source)); asset = result['assets'][0]
                self.assertIsNone(asset['rendition']); self.assertIn(code, {issue['code'] for issue in asset['issues']})
                self.assertEqual(result['pages'][0]['status'], 'partial')
                if code == 'UNSUPPORTED_IMAGE_MASK':
                    self.assertIn('/SMask', asset['metadata']['entries'])

    def test_pixel_limit_is_checked_before_decoding_and_never_downsamples(self):
        with patch.object(EncodedStreamObject, 'decode_as_image', side_effect=AssertionError('Must not decode oversized image')):
            result, _ = self.extract(make_pdf(source=image(width=4001, height=4000)))
        self.assertEqual(result['assets'][0]['issues'][0]['code'], 'IMAGE_PIXEL_LIMIT')
        self.assertIsNone(result['assets'][0]['rendition'])

    def test_image_optional_content_is_retained_but_never_marked_verified(self):
        source = image()
        source[NameObject('/OC')] = DictionaryObject({NameObject('/Type'): NameObject('/OCG'), NameObject('/Name'): TextStringObject('Hidden source layer')})
        result, _ = self.extract(make_pdf(source=source))
        self.assertEqual(result['pages'][0]['status'], 'partial')
        self.assertEqual(result['occurrences'][0]['appearance_status'], 'unverified')
        self.assertIn('UNSUPPORTED_IMAGE_APPEARANCE', {issue['code'] for issue in result['assets'][0]['issues']})
        self.assertIn('/OC', result['assets'][0]['metadata']['entries'])

    def test_form_local_type3_glyph_images_cannot_claim_complete_page_coverage(self):
        writer = PdfWriter()
        font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type3'),
                                 NameObject('/CharProcs'): DictionaryObject({NameObject('/A'): writer._add_object(stream(b'0 0 d0 /Im Do'))})})
        form = stream(b'BT /F0 12 Tf (A) Tj ET', Subtype=NameObject('/Form'), BBox=RectangleObject([0, 0, 100, 100]),
                      Resources=DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F0'): writer._add_object(font)}),
                                                   NameObject('/XObject'): DictionaryObject({NameObject('/Im'): writer._add_object(image())})}))
        page = writer.add_blank_page(width=200, height=200)
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject({NameObject('/Fm'): writer._add_object(form)})})
        page[NameObject('/Contents')] = writer._add_object(stream(b'/Fm Do'))
        result, _ = self.extract(pdf(writer))
        self.assertEqual(result['occurrences'], [])
        self.assertEqual(result['pages'][0]['status'], 'partial')
        self.assertIn('TYPE3_GLYPHS_UNINSPECTED', {issue['code'] for issue in result['pages'][0]['issues']})

    def test_alternate_and_opi_image_appearance_remains_unverified(self):
        for key in ('/Alternates', '/OPI'):
            with self.subTest(key=key):
                source = image()
                source[NameObject(key)] = (ArrayObject([DictionaryObject({NameObject('/Image'): image(),
                    NameObject('/DefaultForPrinting'): BooleanObject(True)})]) if key == '/Alternates' else DictionaryObject())
                result, _ = self.extract(make_pdf(source=source))
                self.assertEqual(result['pages'][0]['status'], 'partial')
                self.assertEqual(result['occurrences'][0]['appearance_status'], 'unverified')
                self.assertIn('UNSUPPORTED_IMAGE_APPEARANCE', {issue['code'] for issue in result['assets'][0]['issues']})
                self.assertIn(key, result['assets'][0]['metadata']['entries'])

    def test_repeated_unknown_appearance_contexts_are_bounded_and_deduplicated(self):
        result, _ = self.extract(make_pdf(b'q '+b'/Unknown gs '*2000+b'40 0 0 20 10 20 cm /Im Do Q'))
        self.assertEqual(result['pages'][0]['status'], 'partial')
        self.assertEqual(len(result['occurrences'][0]['issues']), 1)
        self.assertEqual(result['occurrences'][0]['issues'][0]['code'], 'UNSUPPORTED_APPEARANCE_CONTEXT')

    def test_text_clipping_is_not_mistaken_for_an_unclipped_image(self):
        content = b'BT /F1 12 Tf 7 Tr 10 20 Td (X) Tj ET q 40 0 0 20 10 20 cm /Im Do Q'
        result, _ = self.extract(make_pdf(content))
        self.assertEqual(result['pages'][0]['status'], 'partial')
        self.assertIn('UNSUPPORTED_TEXT_CLIPPING', {issue['code'] for issue in result['occurrences'][0]['issues']})

    def test_resource_default_color_spaces_are_explicitly_unverified(self):
        writer = PdfWriter(); source = writer._add_object(image())
        page = writer.add_blank_page(width=200, height=200)
        colors = DictionaryObject({NameObject('/DefaultRGB'): ArrayObject([NameObject('/CalRGB'), DictionaryObject()])})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/ColorSpace'): colors,
                                    NameObject('/XObject'): DictionaryObject({NameObject('/Im'): source})})
        page[NameObject('/Contents')] = writer._add_object(stream(b'q 40 0 0 20 10 20 cm /Im Do Q'))
        result, _ = self.extract(pdf(writer))
        self.assertEqual(result['pages'][0]['status'], 'partial')
        self.assertIn('UNSUPPORTED_DEFAULT_COLOR_SPACE', {issue['code'] for issue in result['occurrences'][0]['issues']})

    def test_empty_original_content_stream_is_retained_as_zero_byte_evidence(self):
        result, target = self.extract(make_pdf(b''))
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['occurrences'], [])
        retained = next(entry for entry in result['files'] if entry['size'] == 0)
        self.assertEqual(retained['sha256'], sha256(b'').hexdigest())
        self.assertEqual((target/retained['relative_path']).read_bytes(), b'')

    def test_clipping_patterns_and_partial_range_are_explicit(self):
        result, _ = self.extract(make_pdf(b'q 0 0 10 10 re W n 40 0 0 20 10 20 cm /Im Do Q', pages=2), page_count=1)
        self.assertEqual(result['coverage']['unrequested_pages'], [2])
        self.assertEqual(result['pages'][0]['status'], 'partial')
        self.assertIn('UNSUPPORTED_CLIPPING', {issue['code'] for issue in result['occurrences'][0]['issues']})
        result, _ = self.extract(make_pdf(b'/UninspectedPattern scn'))
        self.assertEqual(result['occurrences'], [])
        self.assertEqual(result['pages'][0]['status'], 'partial')

    def test_operator_occurrence_and_output_limits_fail_without_claiming_complete_coverage(self):
        for constant, maximum in (('MAX_OPERATORS', 1), ('MAX_OCCURRENCES', 1), ('MAX_OUTPUT_BYTES', 1)):
            with self.subTest(constant=constant), patch.object(worker, constant, maximum):
                result, _ = self.extract(make_pdf(b'q 40 0 0 20 10 20 cm /Im Do /Im Do Q'))
            self.assertEqual(result['pages'][0]['status'], 'failed')
            self.assertTrue(result['issues'])

    def test_source_mismatch_existing_output_and_encryption_reject_before_publication(self):
        source = self.root/'source.pdf'; source.write_bytes(make_pdf())
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            worker.extract_images(source, self.root/'bad', '0'*64)
        self.assertFalse((self.root/'bad').exists())
        with self.assertRaisesRegex(ValueError, 'requested source pages'):
            worker.extract_images(source, self.root/'range', sha256(source.read_bytes()).hexdigest(), 1, 2)
        self.assertFalse((self.root/'range').exists())
        with self.assertRaisesRegex(ValueError, 'new private'):
            worker.extract_images(source, self.root, sha256(source.read_bytes()).hexdigest())
        writer = PdfWriter(); writer.add_blank_page(width=100, height=100); writer.encrypt('secret'); source.write_bytes(pdf(writer))
        with self.assertRaisesRegex(ValueError, 'Encrypted'):
            worker.extract_images(source, self.root/'encrypted', sha256(source.read_bytes()).hexdigest())

    def test_real_disposable_worker_emits_bounded_hash_manifest(self):
        data = make_pdf(); source = self.root/'source.pdf'; source.write_bytes(data); target = self.root/'child'
        result = subprocess.run([sys.executable, '-I', str(Path(worker.__file__).absolute()), str(source), str(target),
                                 sha256(data).hexdigest(), '1', '1'], capture_output=True, timeout=40, check=True)
        manifest = json.loads(result.stdout)
        self.assertNotIn('error', manifest, result.stderr.decode(errors='replace'))
        self.assertEqual(manifest['issues'], [])
        self.assertEqual(manifest['source']['sha256'], sha256(data).hexdigest())
        self.assertEqual(manifest['extraction']['pypdf_version'], '6.10.0')


if __name__ == '__main__':
    unittest.main()
