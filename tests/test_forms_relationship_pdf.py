from copy import deepcopy
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pypdf import PdfReader

from estimator.forms import Forms
from estimator.forms_http import FormsHTTP
from estimator.forms_pdf import render_form_pdf
from test_forms import entry, field, identifier, template


def saved_form(name, fields, values, *, orientation='portrait'):
    return {'id': identifier(), 'name': name, 'version': 1, 'created_by_name': 'Alex',
            'created_at': '2026-11-18T09:30:00Z', 'values': values,
            'template': {'id': identifier(), 'name': name, 'version': 1, 'fields': fields,
                         'settings': {'orientation': orientation}}}


class FormRelationshipPdfTests(unittest.TestCase):
    def test_appends_nested_relationships_once_with_cycles_and_original_page_layouts(self):
        child = saved_form('Inspection attachment', [field('note'), field('back', 'relationship')],
                           {'note': 'Landscape child evidence'}, orientation='landscape')
        other = saved_form('Repair attachment', [field('note'), field('duplicate', 'relationship')],
                           {'note': 'Repair evidence', 'duplicate': {'entry_id': child['id']}})
        root = saved_form('Main inspection', [
            field('linked', 'relationship'),
            field('visits', 'group', children=[field('repair', 'relationship')]),
            field('rows', 'table', columns=[field('repeat', 'relationship')])],
            {'linked': {'entry_id': child['id']}, 'visits': [{'repair': {'entry_id': other['id']}}],
             'rows': [{'repeat': {'entry_id': child['id']}}]})
        child['values']['back'] = {'entry_id': root['id']}
        records = {record['id']: record for record in (root, child, other)}
        before = deepcopy(records)
        lookups = []

        def resolve(key):
            lookups.append(key)
            return records[key]

        pdf = PdfReader(BytesIO(render_form_pdf(root, 'ocean', {}, [], resolve)))
        self.assertEqual(records, before)
        self.assertEqual(lookups, [child['id'], other['id']])
        self.assertEqual(len(pdf.pages), 3)
        for page, record in zip(pdf.pages, (root, child, other)):
            self.assertIn(record['name'], page.extract_text())
        self.assertIn('Landscape child evidence', pdf.pages[1].extract_text())
        self.assertIn('Repair evidence', pdf.pages[2].extract_text())
        self.assertGreater(pdf.pages[1].mediabox.width, pdf.pages[1].mediabox.height)
        self.assertLess(pdf.pages[2].mediabox.width, pdf.pages[2].mediabox.height)
        text = '\n'.join(page.extract_text() for page in pdf.pages)
        for key in records:
            self.assertNotIn(key, text)
        self.assertEqual([item.title for item in pdf.outline],
                         ['Main inspection', 'Inspection attachment', 'Repair attachment'])

    def test_reference_only_and_excluded_relationships_do_not_append_forms(self):
        linked = saved_form('Earlier report', [field('secret')], {'secret': 'Unappended evidence'})
        root = saved_form('Reference report', [
            field('reference', 'lookup'), field('show', 'choice'),
            field('hidden', 'relationship', hide_in_pdf=True),
            field('conditional', 'relationship', condition={'field_id': 'show', 'value': 'Yes'}),
            field('hidden_rows', 'table', hide_in_pdf=True, columns=[field('linked', 'relationship')])],
            {'reference': {'entry_id': linked['id']}, 'show': 'No',
             'hidden': {'entry_id': linked['id']}, 'conditional': {'entry_id': linked['id']},
             'hidden_rows': [{'linked': {'entry_id': linked['id']}}]})
        pdf = PdfReader(BytesIO(render_form_pdf(root, 'ocean', {}, [], lambda _: linked)))
        self.assertEqual(len(pdf.pages), 1)
        text = pdf.pages[0].extract_text()
        self.assertIn('Earlier report', text)
        self.assertIn('Alex', text)
        self.assertNotIn(linked['id'], text)
        self.assertNotIn('Unappended evidence', text)

    def test_download_rechecks_access_to_each_related_entry_and_keeps_store_unchanged(self):
        admin = {'id': 'admin', 'name': 'Administrator', 'role': 'admin'}
        viewer = {'id': 'viewer', 'name': 'Viewer', 'role': 'viewer'}
        with TemporaryDirectory() as folder:
            store = Forms(Path(folder) / 'forms.sqlite3', lambda: [admin, viewer], lambda: {})
            private_template = store.save_template(admin, template(
                name='Private attachment', roles=['admin'], fields=[field('secret')]))
            private = store.save_entry(admin, entry(private_template, {'secret': 'Restricted evidence'}))
            public_template = store.save_template(admin, template(
                name='Public inspection', fields=[field('relationship', 'relationship'), field('reference', 'lookup')]))
            public = store.save_entry(admin, entry(public_template, {
                'relationship': {'entry_id': private['id']}, 'reference': {'entry_id': private['id']}},
                status='submitted'))
            http = FormsHTTP(store)

            class Handler:
                command = 'GET'
                path = '/api/forms/entry/pdf?id=' + public['id']

                def __init__(self, user):
                    self.crm_user = user

                def send_payload(self, status, payload, mime='', headers=None):
                    self.result = status, payload, mime

            def download(user):
                handler = Handler(user)
                self.assertTrue(http.dispatch(handler, '/api/forms/entry/pdf'))
                self.assertEqual((handler.result[0], handler.result[2]), (200, 'application/pdf'))
                return PdfReader(BytesIO(handler.result[1]))

            with store.connect() as db:
                before = list(db.iterdump())
            self.assertEqual(len(download(admin).pages), 2)
            pdf = download(viewer)
            self.assertEqual(len(pdf.pages), 1)
            text = pdf.pages[0].extract_text()
            self.assertIn('Form unavailable', text)
            for forbidden in ('Private attachment', 'Restricted evidence', private['id']):
                self.assertNotIn(forbidden, text)
            with store.connect() as db:
                self.assertEqual(list(db.iterdump()), before)
            store.delete_entry(admin, {'id': private['id'], 'version': private['version']})
            self.assertEqual(len(download(admin).pages), 1)
