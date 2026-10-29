"""Company covers retain source pages and fail before persistent settings change."""
import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, TextStringObject, ArrayObject
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS, validate_company_settings
from estimator.pdf_cover import decode_cover_pdf, prepend_cover_pdf, validate_cover_pdf
from estimator.storage import Store


def pdf_pages(*labels, size=(595, 842)):
    output = BytesIO()
    canvas = Canvas(output, pagesize=size)
    for label in labels:
        canvas.drawString(40, size[1] - 50, label)
        canvas.showPage()
    canvas.save()
    return output.getvalue()


def data_url(payload):
    return 'data:application/pdf;base64,' + base64.b64encode(payload).decode('ascii')


def altered_pdf(mutator):
    writer = PdfWriter()
    writer.append(PdfReader(BytesIO(pdf_pages('Cover'))))
    mutator(writer)
    output = BytesIO(); writer.write(output)
    return output.getvalue()


class PdfCoverTests(unittest.TestCase):
    def test_legacy_settings_normalise_optional_cover_fields(self):
        old = {key: value for key, value in DEFAULTS.items() if not key.startswith('cover_')}
        self.assertEqual(validate_company_settings(old), DEFAULTS)

    def test_no_cover_returns_exact_original_bytes(self):
        payload = pdf_pages('Body')
        self.assertIs(prepend_cover_pdf(payload), payload)
        self.assertIs(prepend_cover_pdf(payload, DEFAULTS), payload)

    def test_cover_pages_precede_body_and_preserve_vector_text(self):
        cover, body = pdf_pages('Cover one', 'Cover two'), pdf_pages('Report one', 'Report two')
        settings = {**DEFAULTS, 'cover_pdf': data_url(cover), 'cover_pdf_name': 'cover.pdf'}
        before = deepcopy(settings)
        combined = prepend_cover_pdf(body, settings)
        reader = PdfReader(BytesIO(combined))
        self.assertEqual([p.extract_text().strip() for p in reader.pages], ['Cover one', 'Cover two', 'Report one', 'Report two'])
        self.assertEqual(settings, before)
        self.assertEqual([p.extract_text().strip() for p in PdfReader(BytesIO(body)).pages], ['Report one', 'Report two'])

    def test_mixed_page_geometry_and_rotation_are_retained(self):
        cover = altered_pdf(lambda w: w.pages[0].rotate(90))
        body = pdf_pages('Landscape', size=(842, 595))
        reader = PdfReader(BytesIO(prepend_cover_pdf(body, {'cover_pdf': data_url(cover)})))
        self.assertEqual(tuple(reader.pages[0].mediabox), (0, 0, 595, 842))
        self.assertEqual(reader.pages[0].rotation, 90)
        self.assertEqual(tuple(reader.pages[1].mediabox), (0, 0, 842, 595))

    def test_cover_clear_does_not_change_previously_frozen_pdf(self):
        body = pdf_pages('Body')
        settings = {'cover_pdf': data_url(pdf_pages('Original cover'))}
        frozen = prepend_cover_pdf(body, settings)
        settings['cover_pdf'] = data_url(pdf_pages('Replacement cover'))
        replacement = prepend_cover_pdf(body, settings)
        settings['cover_pdf'] = None
        self.assertEqual([p.extract_text().strip() for p in PdfReader(BytesIO(frozen)).pages], ['Original cover', 'Body'])
        self.assertEqual([p.extract_text().strip() for p in PdfReader(BytesIO(replacement)).pages], ['Replacement cover', 'Body'])
        self.assertIs(prepend_cover_pdf(body, settings), body)

    def test_valid_cover_roundtrips_with_saved_company(self):
        value = {**DEFAULTS, 'cover_pdf': data_url(pdf_pages('Company cover')), 'cover_pdf_name': 'Company.pdf'}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'settings.sqlite3'
            self.assertEqual(Store(path).save_company_settings(value), value)
            self.assertEqual(Store(path).company_settings(), value)

    def test_legacy_contact_save_preserves_cover_and_missing_fields_are_rejected(self):
        value = {**DEFAULTS, 'cover_pdf': data_url(pdf_pages('Company cover')), 'cover_pdf_name': 'Company.pdf'}
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'settings.sqlite3')
            store.save_company_settings(value)
            old_client = {key: item for key, item in value.items() if not key.startswith('cover_')}
            old_client['phone'] = 'New phone'
            self.assertEqual(store.save_company_settings(old_client), {**value, 'phone': 'New phone'})
            with self.assertRaises(ValidationError):
                store.save_company_settings({'cover_pdf': None, 'cover_pdf_name': ''})
            self.assertEqual(store.company_settings()['cover_pdf'], value['cover_pdf'])

    def test_historical_five_key_database_settings_load_without_rewriting(self):
        import json
        old = {key: value for key, value in DEFAULTS.items() if not key.startswith('cover_')}
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'settings.sqlite3')
            literal = json.dumps(old)
            with store.connect() as db:
                db.execute("INSERT INTO app_preferences(key,value) VALUES('company_settings',?)", (literal,))
            self.assertEqual(store.company_settings(), DEFAULTS)
            with store.connect() as db:
                self.assertEqual(db.execute("SELECT value FROM app_preferences WHERE key='company_settings'").fetchone()[0], literal)

    def test_invalid_cover_cannot_replace_existing_settings(self):
        good = {**DEFAULTS, 'cover_pdf': data_url(pdf_pages('Cover')), 'cover_pdf_name': 'cover.pdf'}
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'settings.sqlite3')
            store.save_company_settings(good)
            for bad in ('data:application/pdf;base64,broken!', data_url(b'%PDF-1.7\ntruncated'), data_url(b'not a PDF'), 'data:text/html;base64,AA=='):
                with self.subTest(bad=bad), self.assertRaises(ValidationError):
                    store.save_company_settings({**good, 'cover_pdf': bad})
                self.assertEqual(store.company_settings(), good)

    def test_encrypted_and_zero_or_too_many_pages_rejected(self):
        encrypted = altered_pdf(lambda writer: writer.encrypt('password'))
        empty = BytesIO(); PdfWriter().write(empty)
        excessive = pdf_pages(*[str(n) for n in range(26)])
        for payload in (encrypted, empty.getvalue(), excessive):
            with self.subTest(size=len(payload)), self.assertRaises(ValidationError):
                decode_cover_pdf(data_url(payload))

    def test_oversized_decoded_pdf_is_rejected(self):
        with self.assertRaises(ValidationError):
            decode_cover_pdf(data_url(b'%PDF-' + b'x' * (10 * 1024 * 1024)))

    def test_scripts_automatic_actions_and_attachments_rejected(self):
        payloads = [
            altered_pdf(lambda writer: writer.add_js("app.alert('test')")),
            altered_pdf(lambda writer: writer.add_attachment('file.txt', b'test')),
            altered_pdf(lambda writer: writer._root_object.update({NameObject('/OpenAction'): DictionaryObject({NameObject('/S'): NameObject('/GoTo'), NameObject('/D'): ArrayObject()})})),
            altered_pdf(lambda writer: writer.pages[0].update({NameObject('/AA'): DictionaryObject()})),
        ]
        for payload in payloads:
            with self.subTest(size=len(payload)), self.assertRaises(ValidationError):
                decode_cover_pdf(data_url(payload))

    def test_unsafe_link_rejected_but_web_link_allowed(self):
        def linked(url):
            def mutate(writer):
                action = DictionaryObject({NameObject('/S'): NameObject('/URI'), NameObject('/URI'): TextStringObject(url)})
                writer.pages[0][NameObject('/A')] = action
            return altered_pdf(mutate)
        self.assertTrue(decode_cover_pdf(data_url(linked('https://example.test/cover'))))
        with self.assertRaises(ValidationError):
            decode_cover_pdf(data_url(linked('javascript:alert(1)')))

    def test_filename_is_metadata_only_and_no_path_is_accepted(self):
        cover = data_url(pdf_pages('Cover'))
        self.assertEqual(validate_cover_pdf(cover, '  Company cover.pdf  '), (cover, 'Company cover.pdf'))
        self.assertEqual(validate_cover_pdf(None, 'old.pdf'), (None, ''))
        for filename in ('../cover.pdf', r'C:\cover.pdf', 'line\nbreak.pdf', 'x' * 201):
            with self.subTest(filename=filename), self.assertRaises(ValidationError):
                validate_cover_pdf(cover, filename)

    def test_invalid_body_fails_without_mutating_inputs(self):
        company = {'cover_pdf': data_url(pdf_pages('Cover'))}
        saved = deepcopy(company)
        with self.assertRaises(ValidationError):
            prepend_cover_pdf(b'not a report', company)
        self.assertEqual(company, saved)


if __name__ == '__main__':
    unittest.main()
