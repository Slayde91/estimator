import base64
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
from pathlib import Path
import unittest
import uuid

from PIL import Image
from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.company_settings import DEFAULTS
from estimator.documentation_catalog import document_catalog, register_options
from estimator.document_theme import document_theme
from estimator.inspection_register_report import render_inspection_register
from estimator.native_dialogs import SaveSelection
from estimator.passive_fire_register import normalize_register, preserve_register_numbers, render_register_pdf
import test_certification_http as helpers


def photo():
    stream = BytesIO()
    Image.new('RGB', (320, 180), '#a44d47').save(stream, format='JPEG')
    return 'data:image/jpeg;base64,' + base64.b64encode(stream.getvalue()).decode('ascii')


def completed_entry():
    choices = register_options()
    entry = {key: choices[key][0] for key in ('seal_type', 'frl', 'substrate', 'orientation',
                                               'installation_type', 'manufacturer')}
    image = photo()
    side = {phase: [image] for phase in ('before', 'during', 'after', 'label')}
    return {**entry, 'service_types': choices['service_types'][:2], 'products': choices['products'][:2],
            'report': choices['reports'][entry['manufacturer']][0], 'location': 'Riser <01> & plant',
            'side1': {**side, 'id_number': 'SIDE-A'}, 'side2': {**side, 'id_number': 'SIDE-B'},
            'access': 'Yes', 'solution': choices['solution'][0], 'comments': 'Access blocked by wall',
            'photos': [image], 'signature': {'version': 1, 'ratio': 2, 'strokes': [[[0.1, 0.2], [0.8, 0.7]]]}}


class PassiveFireRegisterTests(unittest.TestCase):
    def test_custom_inspection_round_trip_and_both_exports_without_library_item(self):
        entry = {**completed_entry(), 'custom_entry': True, 'technical_item_id': '', 'report': 'MAN-590',
                 'technical_filters': {'substrate':'Concrete/masonry wall', 'orientation':'Vertical',
                                       'manufacturer':'Independent supplier', 'type':'Core hole',
                                       'category':'Plumbing', 'services':'Copper Pipes', 'frl':'-/90/90'}}
        historic = {key: entry.pop(key) for key in ('seal_type', 'installation_type', 'service_types')}
        draft = normalize_register({'entries':[entry]})
        self.assertEqual(normalize_register(draft), draft)
        for old_category in ('HVAC', 'Mechanical'):
            old = {**entry, 'technical_filters':{**entry['technical_filters'], 'category':old_category}}
            self.assertEqual(normalize_register({'entries':[old]})['entries'][0]['technical_filters']['category'],
                             'HVAC & Mechanical')
        inspection = render_register_pdf(draft, {}, company=DEFAULTS)
        register = render_inspection_register(draft, {}, library=None, company=DEFAULTS)
        for pdf in [inspection, register]:
            words = ' '.join(page.extract_text() for page in PdfReader(BytesIO(pdf)).pages)
            words = ' '.join(words.split())
            for value in ['Independent supplier', 'Plumbing', 'Copper Pipes', 'MAN-590', 'Concrete/masonry wall']:
                self.assertIn(value, words)
            for label in ('Seal type', 'Installation type', 'Service type'):
                self.assertNotIn(label, words)
        previous = normalize_register({'entries': [{**entry, **historic}]})
        reopened = normalize_register(previous)
        for key, value in historic.items():
            self.assertEqual(reopened['entries'][0][key], value)
        old_pdf = PdfReader(BytesIO(render_register_pdf(reopened, {}, company=DEFAULTS)))
        old_text = ' '.join(' '.join(page.extract_text() for page in old_pdf.pages).split())
        for key, label in [('seal_type', 'Seal type'), ('installation_type', 'Installation type'),
                           ('service_types', 'Service type')]:
            value = historic[key]
            self.assertIn(label + ' ' + (', '.join(value) if isinstance(value, list) else value), old_text)
        for changes, message in [({'technical_item_id':'a-system'}, 'cannot also reference'),
                                 ({'custom_entry':'true'}, 'checkbox'),
                                 ({'products':[]}, 'Products'),
                                 ({'technical_filters':{**entry['technical_filters'], 'services':''}}, 'Services')]:
            with self.subTest(message=message), self.assertRaisesRegex(ValidationError, message):
                render_register_pdf({'entries':[{**entry, **changes}]}, {}, company=DEFAULTS)

    def assert_red_table_grids(self, page):
        """Return (column dividers, row rules) for each table fragment on this fixture page."""
        grids = []
        dividers = set()
        horizontal = 0
        stroke = (0, 0, 0)
        operations = page.get_contents().operations
        for index, (values, op) in enumerate(operations):
            if op == b'RG':
                stroke = tuple(round(channel * 255) for channel in values)
            elif op == b'S':
                end, shape = operations[index - 1]
                if shape == b're':
                    self.assertEqual(stroke, (189, 0, 24), 'outer frame')
                    grids.append((len(dividers), horizontal))
                    dividers.clear()
                    horizontal = 0
                elif shape == b'l':
                    start, move = operations[index - 2]
                    # Gridlines are table-local. Page rules start at a margin,
                    # link underlines start inside a cell and the signature is diagonal.
                    if move == b'm' and start[0] == end[0]:
                        self.assertEqual(stroke, (189, 0, 24), 'column divider')
                        dividers.add(start[0])
                    elif move == b'm' and start[0] == 0 and start[1] == end[1]:
                        self.assertEqual(stroke, (189, 0, 24), 'row divider')
                        horizontal += 1
        self.assertTrue(grids, 'each page fragment has an outer frame')
        return grids

    def test_inspection_and_register_pdf_table_strokes_use_classifire_red(self):
        from tempfile import TemporaryDirectory
        from estimator.reference_library import ReferenceLibrary
        from technical_item_fixture_data import technical_library

        entry = {**completed_entry(), 'technical_item_id': 'report-a-v1'}
        entry['side1']['before'] = entry['side1']['before'] * 15
        with TemporaryDirectory() as folder, document_theme('ocean'):
            root = Path(folder) / 'technical'
            technical_library(root)
            for render in (render_register_pdf, render_inspection_register):
                with self.subTest(render=render.__name__):
                    pdf = render({'entries': [entry]}, {'project_no': 'PX', 'client': 'ACME'},
                                 library=ReferenceLibrary(root), company=DEFAULTS)
                    pages = PdfReader(BytesIO(pdf)).pages
                    self.assertGreater(len(pages), 1)
                    grids = [grid for page in pages for grid in self.assert_red_table_grids(page)]
                    columns, row_rules = zip(*grids)
                    if render is render_register_pdf:
                        # One single-column photo panel follows the two-column project and inspection tables.
                        self.assertGreater(len(columns), 4)
                        self.assertEqual(columns[:3], (1, 1, 0))
                        self.assertEqual(columns[3:], (1,) * (len(columns) - 3))
                        self.assertTrue(all(count > 0 for count in row_rules[:3]))
                        self.assertGreater(sum(row_rules[3:]), 0)
                    else:
                        # Project details plus all thirteen columns on every page.
                        self.assertEqual(columns, (1,) + (12,) * len(pages))
                        self.assertTrue(all(count > 0 for count in row_rules))

    def test_persistent_numbers_survive_migration_deletion_and_reordering(self):
        old = {'entries':[{}, {'side1':{'id_number':'old-023'},'side2':{'id_number':'old-B'}}]}
        numbered = normalize_register(old)
        a,b = numbered['entries']
        self.assertEqual((a['side1']['id_number'],a['side2']['id_number']),('001','001-2'))
        self.assertEqual((b['side1']['id_number'],b['side2']['previous_id']),('002','old-B'))
        self.assertEqual(normalize_register(old),numbered)
        self.assertEqual(normalize_register(numbered),numbered)
        preserve_register_numbers(old,numbered)
        moved = {**numbered,'entries':[b,a]}
        preserve_register_numbers(numbered,moved)
        removed = {**numbered,'entries':[a]}
        preserve_register_numbers(moved,removed)
        with self.assertRaises(ValidationError):
            preserve_register_numbers(removed,{'entries':[a],'next_number':2})
        with self.assertRaises(ValidationError):
            preserve_register_numbers(removed,numbered)
        with self.assertRaises(ValidationError):
            preserve_register_numbers(numbered,old)
        for change in ({'number':1},{'entry_id':a['entry_id']},{'side1':{**b['side1'],'id_number':'003'}}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                normalize_register({**numbered,'entries':[a,{**b,**change}]})
        with self.assertRaises(ValidationError):
            preserve_register_numbers(numbered, {**numbered,'entries':[a,{**b,'side1':{**b['side1'],'previous_id':'Changed'}}]})
        for invalid in (None,{'entries':1,'next_number':2},{'entries':[None],'next_number':2},
                        {'entries':[{'number':1}],'next_number':2},{'entries':[],'next_number':1_000_000_000}):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                preserve_register_numbers(numbered,invalid)
        preserve_register_numbers(removed,{'entries':[],'next_number':128})
        imported = {'entries':[],'next_number':1_000_001}
        preserve_register_numbers(imported,{'entries':[],'next_number':1_000_002})

    def test_signing_details_round_trip_without_inventing_metadata_for_older_entries(self):
        signed = {'signature': completed_entry()['signature']}
        details = {'member_id': str(uuid.uuid4()), 'name': 'Inspector A', 'date': '2026-10-04'}
        draft = normalize_register({'entries': [{**signed, 'signature_details': details}, signed, {}]})
        self.assertEqual(draft['entries'][0]['signature_details'], details)
        for entry in draft['entries'][1:]:
            self.assertNotIn('signature_details', entry)
        self.assertEqual(normalize_register(draft), draft)
        for invalid in (
            {'signature_details': details},
            {**signed, 'signature_details': {**details, 'name': ' '}},
            {**signed, 'signature_details': {**details, 'member_id': 'not-a-member-id'}},
            {**signed, 'signature_details': {**details, 'date': '2026-02-30'}},
            {**signed, 'signature_details': {**details, 'date': ''}},
            {**signed, 'signature_details': {**details, 'company': 'Unknown key'}},
        ):
            with self.subTest(entry=invalid), self.assertRaises(ValidationError):
                normalize_register({'entries': [invalid]})

    def test_incomplete_drafts_round_trip_and_only_complete_entries_export(self):
        draft = normalize_register({'entries': [{}, {'location': 'First floor'}]})
        self.assertEqual(normalize_register(draft), draft)
        self.assertIsNone(draft['entries'][0]['signature'])
        self.assertEqual(draft['entries'][0]['side2']['before'], [])
        with self.assertRaisesRegex(ValidationError, 'Penetration ID 001:.*Location.*Signature'):
            render_register_pdf(draft, {}, company=DEFAULTS)
        after_deletion = normalize_register({'entries': [completed_entry(), {}, {'access': 'Yes'}]})
        del after_deletion['entries'][1]
        with self.assertRaisesRegex(ValidationError, 'Penetration ID 003 / 003-2:.*Location.*Signature'):
            render_register_pdf(after_deletion, {}, company=DEFAULTS)
        with self.assertRaisesRegex(ValidationError, 'Add a register entry'):
            render_register_pdf({'entries': []}, {}, company=DEFAULTS)

    def test_all_access_branches_render_entered_evidence_and_project_identity(self):
        entry = completed_entry()
        entry['comments'] = 'First <site note>\nSecond & final note'
        entry['signature_details'] = {'member_id': str(uuid.uuid4()), 'name': 'Inspector <A> & Brown', 'date': '2026-11-15'}
        for access, included, excluded in [
            ('Yes', 'SIDE-B', 'Additional photos'),
            ('No', 'Additional photos', 'SIDE-B'),
            ('NA', 'Topside only', 'SIDE-B'),
        ]:
            with self.subTest(access=access):
                current = {**entry, 'access': access}
                source = {'entries': [current, {**current, 'location': 'Basement west'}]}
                payload = render_register_pdf(source, {'project_no': 'PN-TEST'}, company=DEFAULTS)
                pages = PdfReader(BytesIO(payload)).pages
                content = '\n'.join(page.extract_text() for page in pages)
                self.assertGreaterEqual(len(pages), 2)
                self.assertEqual(content.count('PN-TEST'), 1)
                self.assertNotIn('Project details', content)
                self.assertNotRegex(content, r'Entry \d+ of \d+')
                ids = '001 / 001-2' if access == 'Yes' else '001'
                lines = ' '.join(content.split())
                self.assertIn(f'Penetration ID {ids} ', lines)
                self.assertIn('Comments First <site note> Second & final note Name Inspector <A> & Brown Date 15/11/2026 Signature', lines)
                for value in ('PN-TEST', 'Riser <01> & plant', 'Signature', 'Basement west',
                              'Side 1 - 001','Side 1 - 002',
                              'SIDE-A', 'Before', 'During', 'After', 'Label', included,
                              entry['report'], entry['products'][0]):
                    self.assertIn(value, content)
                self.assertNotIn(excluded, content)
                if access=='Yes':
                    self.assertIn('Side 2 - 001-2', content)
                self.assertTrue(any(image.image.size == (320, 180) for page in pages for image in page.images))

    def test_inspection_places_one_during_after_and_label_photo_beside_details(self):
        entry = completed_entry()
        entry['side1']['during'] = entry['side1']['during'] * 2
        pdf = PdfReader(BytesIO(render_register_pdf({'entries': [entry]}, {}, company=DEFAULTS)))
        positions = {}
        for number, page in enumerate(pdf.pages):
            def locate(text, matrix, text_matrix, font, size):
                name = text.strip()
                if name in ('Location', 'Signature') or name.startswith(('Side 1 -', 'Side 2 -')):
                    x, y = text_matrix[4:6]
                    point = (number, x * matrix[0] + y * matrix[2] + matrix[4],
                             x * matrix[1] + y * matrix[3] + matrix[5])
                    self.assertNotIn(name, positions)
                    positions[name] = point
            page.extract_text(visitor_text=locate)
        first_page, table_x, _ = positions['Location']
        signature_page, _, signature_y = positions['Signature']
        promoted = {'Side 1 - 001 - During (1/2)', 'Side 1 - 001 - After', 'Side 1 - 001 - Label'}
        self.assertEqual(len(positions), 11)
        for label in promoted:
            page, x, y = positions.pop(label)
            self.assertEqual(page, first_page)
            self.assertGreater(x, table_x + 200)
            self.assertGreater(y, signature_y)
        for label, (page, _, y) in positions.items():
            if label.startswith('Side '):
                self.assertTrue(page > signature_page or page == signature_page and y < signature_y, label)

    def test_long_comments_paginate_before_signature_and_legacy_entries_default_to_blank(self):
        entry = completed_entry()
        del entry['comments']
        saved = normalize_register({'entries': [entry]})
        self.assertEqual(saved['entries'][0]['comments'], '')
        blank_pdf = PdfReader(BytesIO(render_register_pdf(saved, {}, company=DEFAULTS)))
        self.assertNotIn('Comments', ' '.join(page.extract_text() for page in blank_pdf.pages))
        note_lines = [f'Site note line {index:03d}' for index in range(1, 101)]
        saved['entries'][0]['comments'] = '\n'.join(note_lines)
        self.assertEqual(normalize_register(saved), saved)
        commented_pdf = PdfReader(BytesIO(render_register_pdf(saved, {}, company=DEFAULTS)))
        text = ' '.join(page.extract_text() for page in commented_pdf.pages)
        self.assertTrue(all(text.count(line) == 1 for line in note_lines))
        self.assertLess(text.index(note_lines[-1]), text.index('Signature'))

    def test_selected_technical_item_exports_source_fields_links_tables_and_only_site_photos(self):
        from tempfile import TemporaryDirectory
        from unittest.mock import patch
        from estimator.reference_library import ReferenceLibrary
        from technical_item_fixture_data import technical_library, REPORT_URL
        with TemporaryDirectory() as folder:
            root = Path(folder) / 'technical'
            data = technical_library(root)
            record = data['libraries']['technical']['items'][0]
            record['fields'].extend([
                {'label': 'Barrier Construction', 'value': 'Concrete wall or plasterboard wall'},
                {'label': 'Service', 'value': 'Copper pipe'},
                {'label': 'ID', 'value': 'V2'},
                {'label': 'Service Wrap', 'value': 'Source wrap instructions'},
                {'label': 'Local Protection', 'value': 'Source local protection instructions'},
            ])
            data['libraries']['technical']['filters'].append({'key': 'orientation', 'label': 'Orientation'})
            record['filter_values']['orientation'] = ['Vertical']
            (root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
            library = ReferenceLibrary(root)
            entry = {**completed_entry(), 'technical_item_id': 'report-a-v1'}
            for key in ('seal_type','frl','products','report','service_types','manufacturer','orientation','substrate','installation_type'):
                entry.pop(key)
            entry['technical_filters'] = {'substrate': 'Concrete/masonry wall', 'type': 'Core hole',
                                          'orientation': 'Vertical', 'manufacturer': 'Synthetic manufacturer',
                                          'category': 'Plumbing & Hydraulic'}
            draft = normalize_register({'entries': [entry]})
            self.assertEqual(draft['entries'][0]['technical_item_id'], 'report-a-v1')
            with patch.object(library, 'asset', side_effect=AssertionError('Technical images are never read for the register')):
                pdf = PdfReader(BytesIO(render_register_pdf(draft, {}, library=library, company=DEFAULTS)))
            text = ' '.join(' '.join(page.extract_text().split()) for page in pdf.pages)
            self.assertIn('Location Riser <01> & plant Substrate Concrete/masonry wall Type Core hole', text)
            self.assertIn('Penetration ID 001 / 001-2 System ID V2 Category Plumbing & Hydraulic Service Copper pipe', text)
            self.assertIn('Report Number Unlinked source report Access to the other side Yes Comments Access blocked by wall Name — Date — Signature', text)
            for omitted in ('Field Value', 'Barrier Construction', 'Service Wrap', 'Local Protection',
                            'Installation Details', 'Retain original conditions.'):
                self.assertNotIn(omitted, text)
            self.assertEqual(pdf.metadata.title, 'Passive Fire Inspections')
            stale = {**entry, 'technical_filters': {'orientation': 'Horizontal'}}
            with self.assertRaisesRegex(ValidationError, 'no longer matches'):
                render_register_pdf({'entries': [stale]}, {}, library=library, company=DEFAULTS)
            choices = {**entry['technical_filters'], 'services': 'Copper Pipes', 'frl': '-/90/90'}
            old_unsigned = normalize_register({'entries': [{**entry, 'signature': None}]})
            self.assertEqual(old_unsigned['entries'][0]['technical_filters'],
                             {**entry['technical_filters'], 'services': '', 'frl': ''})
            for facet in choices:
                with self.subTest(missing=facet):
                    partial = {**entry, 'technical_filters': {**choices, facet: ''}}
                    saved = normalize_register({'entries': [partial]})
                    self.assertEqual(saved['entries'][0]['technical_filters'][facet], '')
                    with self.assertRaisesRegex(ValidationError, 'Penetration ID 001 / 001-2: complete'):
                        render_register_pdf(saved, {}, library=library, company=DEFAULTS)
            for facet in ('services', 'frl'):
                with self.subTest(stale=facet), self.assertRaisesRegex(ValidationError, 'no longer matches'):
                    render_register_pdf({'entries': [{**entry, 'technical_filters': {**choices, facet: 'Unrelated'}}]},
                                        {}, library=library, company=DEFAULTS)
            older = {k: value for k, value in entry.items() if k != 'technical_filters'}
            old_pdf = PdfReader(BytesIO(render_register_pdf({'entries': [older]}, {}, library=library, company=DEFAULTS)))
            old_text = ' '.join(' '.join(page.extract_text().split()) for page in old_pdf.pages)
            self.assertIn('Substrate Not selected (library options:', old_text)
            self.assertIn('Orientation Vertical Manufacturer Synthetic manufacturer', old_text)
            for value in ('Synthetic manufacturer', 'Literal source text', 'SYN-123', 'Copper pipe', 'Steel pipe',
                          'Side 1 - 001 - Before', 'Side 2 - 001-2 - After'):
                self.assertIn(value, text)
            self.assertNotIn('Hidden source metadata', text)
            self.assertNotIn('Source diagram', text)
            self.assertNotIn('Diagrams & Figures', text)
            self.assertNotIn('Reference figures:', text)
            self.assertTrue(any(annot.get_object().get('/A', {}).get('/URI') == REPORT_URL
                                for page in pdf.pages for annot in page.get('/Annots', [])))
            sizes = {image.image.size for page in pdf.pages for image in page.images}
            self.assertIn((320, 180), sizes)
            self.assertNotIn((640, 360), sizes)
            for key, message in [('', 'Technical Library item'), ('removed-item', 'unavailable'), ('../path', 'Invalid library reference')]:
                with self.subTest(key=key), self.assertRaisesRegex(ValidationError, message):
                    render_register_pdf({'entries': [{**entry, 'technical_item_id': key}]}, {}, library=library, company=DEFAULTS)
            missing = normalize_register({'entries': [entry, {}, {**entry, 'technical_item_id': 'removed-item'}]})
            del missing['entries'][1]
            for render in (render_register_pdf, render_inspection_register):
                with self.subTest(render=render.__name__), self.assertRaisesRegex(
                        ValidationError, 'Penetration ID 003 / 003-2:.*unavailable'):
                    render(missing, {}, library=library, company=DEFAULTS)

    def test_conditional_requirements_and_closed_template_choices(self):
        entry = completed_entry()
        cases = [
            ({'side2': {'id_number': '1'}}, 'Side 2 before'),
            ({'access': 'No', 'photos': []}, 'Additional photos'),
            ({'access': 'NA', 'solution': ''}, 'Solution'),
            ({'manufacturer': 'HILTI'}, 'matching the manufacturer'),
            ({'report': ''}, 'Report'),
            ({'signature': None}, 'Signature'),
            ({'frl': 'UNLISTED'}, 'listed FRL'),
            ({'products': ['unlisted']}, 'listed Products'),
            ({'access': 'NA', 'solution': 'invalid'}, 'listed solution'),
        ]
        for changes, message in cases:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValidationError, message):
                render_register_pdf({'entries': [{**entry, **changes}]}, {}, company=DEFAULTS)
        choices = register_options()
        no_report = next(name for name in choices['manufacturer'] if name not in choices['reports'])
        verified = {**entry, 'manufacturer': no_report, 'report': ''}
        self.assertTrue(render_register_pdf({'entries': [verified]}, {}, company=DEFAULTS).startswith(b'%PDF'))

    def test_invalid_structure_and_photos_are_rejected_even_on_inactive_side(self):
        for entry in ({'extra': 1}, {'signature': 'Joe'}, {'side1': []},
                      {'side2': {'before': ['file:///photo.jpg']}},
                      {'side1': {'during': ['data:image/jpeg;base64,eA==']}},
                      {'photos': [photo()] * 21}, {'products': ['X', 'X']},
                      {'location': '\ud800'}):
            with self.subTest(keys=list(entry)), self.assertRaises(ValidationError):
                normalize_register({'entries': [entry]})
        with self.assertRaisesRegex(ValidationError, '200 entries'):
            normalize_register({'entries': [{}] * 201})


class PassiveFireRegisterHTTPTests(unittest.TestCase):
    setUp = helpers.CertificationHTTPTests.setUp
    tearDown = helpers.CertificationHTTPTests.tearDown
    request = helpers.CertificationHTTPTests.request
    json = helpers.CertificationHTTPTests.json
    created_workspace = helpers.CertificationHTTPTests.created_workspace

    def test_racing_windows_cannot_commit_the_same_register_number_twice(self):
        project = Path(self.temp.name) / 'Numbered register.cf.json'
        self.chooser.selection = SaveSelection(str(project),None)
        self.json('POST','/api/project/save-as',{'estimate':helpers.project_estimate(title='Register test'),
            'passive_fire_register':{'entries':[{'location':'First'}]}})
        self.chooser.opened = str(project)
        saved = json.loads(project.read_bytes())
        windows = [self.json('POST','/api/project/open',{}) for _ in range(2)]
        def add(window):
            register = window['passive_fire_register']
            number = register['next_number']
            second = deepcopy(register['entries'][0])
            second.update(number=number,entry_id=str(uuid.uuid4()),location='Second')
            second['side1']['id_number'] = f'{number:03d}'
            second['side2']['id_number'] = f'{number:03d}-2'
            register['entries'].append(second)
            register['next_number'] += 1
            body = {'save_token':window['file']['save_token'],'estimate':saved['estimate'],
                'calculators':{key:{'inputs':row['inputs']} for key,row in window['calculators'].items()},
                'passive_fire_register':register}
            return self.request('POST','/api/project/save',body)[0]
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(add,windows))
        self.assertEqual(sorted(results),[200,400])
        persisted = json.loads(project.read_bytes())['passive_fire_register']
        self.assertEqual(persisted['next_number'],3)
        self.assertEqual([item['side1']['id_number'] for item in persisted['entries']],['001','002'])

    def test_pdf_route_freezes_new_revision_and_replays_exact_bytes(self):
        route = '/api/project/passive-fire-register.pdf'
        workspace = self.created_workspace()['workspace_id']
        headers = {'X-Estimator-Documentation-Workspace': workspace,
                   'X-Estimator-Documentation-Request': str(uuid.uuid4())}
        entry = completed_entry()
        body = {'register': {'entries': [entry]}, 'project_details': {'project_no': 'AC-123'}}
        status, response, pdf = self.request('POST', route, body, headers)
        self.assertEqual(status, 200, pdf[:200])
        self.assertEqual(response['Content-Type'], 'application/pdf')
        self.assertEqual(self.request('POST', route, body, headers)[2], pdf)
        retained = self.json('GET', '/api/documentation?workspace=' + workspace)
        self.assertEqual([row['kind'] for row in retained['items']], ['passive_fire_register.pdf'])
        self.assertEqual(self.request('GET', retained['items'][0]['url'])[2], pdf)
        changed = deepcopy(body)
        changed['register']['entries'][0]['location'] = 'Another floor'
        self.assertEqual(self.request('POST', route, changed, headers)[0], 409)
        status, _, error = self.request('POST', route, {'register': {'entries': [{}]}})
        self.assertEqual(status, 400)
        self.assertIn('Penetration ID 001: complete', json.loads(error)['error'])

    def test_catalog_order_and_template_options_are_identical_for_both_editions(self):
        for edition in ('full', 'standard'):
            catalog = document_catalog(edition)
            ids = [row['id'] for row in catalog]
            row = catalog[ids.index('firestopping.schedule.pdf') + 1]
            self.assertEqual(row['id'], 'passive_fire_register.pdf')
            self.assertEqual(row['label'], 'Passive Fire Inspections')
            self.assertEqual(row['spec']['options'], register_options())

    def test_native_save_and_reopen_preserve_incomplete_evidence_and_older_client_cannot_erase_it(self):
        target = Path(self.temp.name) / 'Register project.cf.json'
        self.chooser.selection = SaveSelection(str(target), None)
        draft = {'entries': [{'location': 'Level 3', 'side2': {'after': [photo()]}}]}
        estimate = helpers.project_estimate(title='Portable register')
        self.json('POST', '/api/project/save-as', {'estimate': estimate, 'passive_fire_register': draft})
        source = target.read_bytes()
        self.chooser.opened = str(target)
        loaded = self.json('POST', '/api/project/open', {})
        self.assertEqual(loaded['passive_fire_register'], normalize_register(draft))
        previous_client = {'save_token': loaded['file']['save_token'], 'estimate': json.loads(source)['estimate'],
                           'calculators': {key: {'inputs': row['inputs']} for key, row in loaded['calculators'].items()}}
        result = self.json('POST', '/api/project/save', previous_client, expected=400)
        self.assertIn('register', result['error'])
        self.assertEqual(target.read_bytes(), source)
