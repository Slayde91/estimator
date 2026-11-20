"""Service-specific installation wording and its original evidence across library entry points."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.storage import Store
from estimator.technical_item_exports import build_technical_item_xlsx, prepare_technical_item, render_technical_item_pdf
from estimator.technical_library_edits import FACETS, ManualTechnicalLibrary
from estimator.technical_prose import public_prose_fields
from estimator.technical_service_instructions import present_service_instructions
from scripts.import_boss_matrix import bind_review
from test_firestopping_library import editable_library


SIZE = 'Service Size / Configuration'
INSTALL = 'Installation Details'
REPORT = 'FC10266-01-5'
GENERIC = '5. Where required, wrap the SuperSTOPPER and services to the correct length (SEE PAGE 2).'
BEFORE = '4. Fit the specimen plug.'
AFTER = '6. Inspect the plug.'
WRAP_NOTE = 'Full insulation ratings require TWrap.'
CABLE = 'NBN Fibre Optic Cable'
SERVICE_TEXT = CABLE + ' - 300mm TWrap required.'


def service_fields():
    return [
        {'label': SIZE, 'value': '', 'table': {
            'columns': ['Service Type', 'Service Detail', 'TWrap Length', 'FRL'],
            'rows': [['Comms Cables', CABLE, '300mm', '-/120/120']]}},
        {'label': 'FRL', 'value': '-/120/120'},
        {'label': 'Service Wrap', 'value': '', 'table_links': [{'field': SIZE, 'table_index': 0}]},
        {'label': INSTALL, 'value': '\n'.join((BEFORE, GENERIC, AFTER))},
        {'label': 'Source Options', 'value': WRAP_NOTE},
        {'label': 'Report Number', 'value': REPORT},
    ]


def by_label(fields):
    return {field['label']: field for field in fields}


class ServiceInstructionProjectionTests(unittest.TestCase):
    def test_reviewed_blank_wall_batt_method_returns_to_installation_details(self):
        method = ('Two double-layer FyreBATT arrangements are shown for a blank wall opening. '
                  'In concrete or solid masonry, friction-fit both layers together anywhere within the wall thickness. '
                  'In concrete or hollow masonry, friction-fit the two layers at opposite sides, flush with the wall faces.')
        fields = [
            {'label': 'Report Number', 'value': 'FAS 210023'},
            {'label': 'System Products', 'value': 'FyreBATT 60'},
            {'label': 'Service', 'value': 'Blank Opening'},
            {'label': 'Barrier Construction', 'value': 'Concrete/Masonry'},
            {'label': 'Local Protection', 'value': method, 'source_labels': [INSTALL]},
        ]
        source = deepcopy(fields)
        result = by_label(present_service_instructions(fields))
        self.assertEqual(result[INSTALL], {'label': INSTALL, 'value': method, 'source_labels': [INSTALL]})
        self.assertNotIn('Local Protection', result)
        self.assertEqual(fields, source)
        fields[3]['value'] = 'Plasterboard'
        self.assertEqual(present_service_instructions(fields), fields)

    def test_steel_retains_only_the_selected_service_detail(self):
        fields = service_fields()
        fields[0]['table']['rows'][0][:2] = ['Bare Metal Pipes', 'Steel up to NB50']
        result = by_label(present_service_instructions(fields))
        self.assertEqual(result[SIZE]['value'], 'Steel up to NB50')
        self.assertNotIn('table', result[SIZE])
        self.assertIn('300mm', result[INSTALL]['value'].replace(' ', ''))

    def test_selected_wrap_lengths_and_no_wrap_only_replace_the_generic_step(self):
        for length in ('400mm', '450mm', '600mm', 'No Wrap'):
            with self.subTest(length=length):
                fields = service_fields()
                table = fields[0]['table']
                table['rows'][0][1:3] = ['Sample service', length]
                if length == 'No Wrap':
                    # The wrap-free variant still retains the original wrapped length in its evidence table.
                    table['rows'][0][1:3] = [CABLE, '300mm']
                    table['columns'][-1] = 'FRL - Wrap Free'
                    by_label(fields)['Service Wrap']['value'] = length
                source = deepcopy(fields)
                result = by_label(present_service_instructions(fields))
                steps = result[INSTALL]['value'].splitlines()
                self.assertEqual((steps[0], steps[-1]), (BEFORE, AFTER))
                self.assertTrue(steps[1].startswith('5. '))
                self.assertNotIn('Where required', steps[1])
                if length == 'No Wrap':
                    self.assertRegex(steps[1], r'(?i)no (?:service )?TWrap (?:is )?required')
                    self.assertNotIn('300mm TWrap required.', result[SIZE]['value'])
                else:
                    self.assertIn(length, steps[1].replace(' ', ''))
                self.assertNotIn('Source Options', result)
                self.assertEqual(fields, source)
        fields = service_fields()
        by_label(fields)[INSTALL]['value'] = BEFORE + '\n5. Retain the specified casing fixings.\n' + AFTER
        result = by_label(present_service_instructions(fields))
        self.assertEqual(result[INSTALL]['value'], by_label(fields)[INSTALL]['value'])
        self.assertEqual(result['Source Options']['value'], WRAP_NOTE)

    def test_both_page_scoped_steps_use_the_assessed_length_and_keep_casing_conditions(self):
        fields = service_fields()
        options = 'Fit the three-sided casing wrap with the specified steel fixings.'
        by_label(fields)['Source Options']['value'] = WRAP_NOTE + '\n\n' + options
        by_label(fields)[INSTALL]['value'] = '\n'.join((
            BEFORE,
            'Page 1: ' + GENERIC.replace('SEE PAGE 2', 'as per Techical Manual FRL tables'),
            'Page 2: ' + GENERIC.replace('SEE PAGE 2', 'as per FRL table'),
            AFTER))
        result = by_label(present_service_instructions(fields))
        instructions = result[INSTALL]['value']
        self.assertNotIn('Where required', instructions)
        self.assertTrue(instructions.startswith(BEFORE))
        self.assertTrue(instructions.endswith(AFTER))
        for page in (1, 2):
            self.assertRegex(instructions, rf'Page {page}: 5\. [^\n]*300\s*mm')
        notes = result.get('Source Options', {}).get('value', '')
        self.assertNotIn(WRAP_NOTE, notes)
        self.assertIn(options, instructions + '\n' + notes)

    def test_patch_condition_moves_without_losing_other_options_or_seal_values(self):
        patch = ('The source Hebel arrangement includes a 13 mm FR plasterboard patch overlapping the penetration '
                 'by at least 100 mm. Its table does not describe an unpatched wall.')
        aac = 'The entry names WALSC, but that product is not explicitly identified in the source drawing.'
        depth = 'The annular gap and FyreFLEX depth are indicated without numerical values.'
        fields = [
            {'label': INSTALL, 'value': '1. Prepare the wall.\n2. Fit the sample assembly.'},
            {'label': 'Source Options', 'value': patch + '\n\nRetain the separate floor condition.'},
            {'label': 'Source Issues', 'value': '\n\n'.join((aac, depth, 'The specimen fixing is unresolved.'))},
            {'label': 'Seal Depth / Fillet Size', 'value': 'Fill to a depth of 22 mm.'},
        ]
        result = by_label(present_service_instructions(fields))
        self.assertRegex(result[INSTALL]['value'], r'13\s*mm.*plasterboard patch.*100\s*mm')
        self.assertIn('2. Fit the sample assembly.', result[INSTALL]['value'])
        self.assertEqual(result['Source Options']['value'], 'Retain the separate floor condition.')
        self.assertEqual(result['Source Issues']['value'], 'The specimen fixing is unresolved.')
        self.assertEqual(result['Seal Depth / Fillet Size'], fields[3])

    def test_distinct_services_keep_their_paired_wraps_and_ratings(self):
        fields = service_fields()
        table = fields[0]['table']
        table['rows'] = [['Cables', 'Example service A', '400mm', '-/90/90'],
                         ['Cables', 'Example service B', '600mm', '-/120/120']]
        result = by_label(present_service_instructions(fields))
        self.assertEqual(result[SIZE]['table'], table)
        step = result[INSTALL]['value'].splitlines()[1]
        self.assertRegex(step, r'Example service A[^.]*400\s*mm')
        self.assertRegex(step, r'Example service B[^.]*600\s*mm')
        self.assertEqual(result['Service Wrap']['table_links'], fields[2]['table_links'])

    def test_unrelated_manufacturer_retains_its_own_fields(self):
        fields = service_fields()
        foreign = {'fields': fields, 'filter_values': {'manufacturer': ['Sample independent supplier']}}
        self.assertEqual(public_prose_fields(foreign), fields)

    def test_nbn_detail_editor_title_save_and_both_document_formats(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            library_root = root / 'library'
            data = editable_library(library_root)
            technical = data['libraries']['technical']
            technical['filters'] = [{'key': key, 'label': label} for key, label in FACETS]
            record = technical['items'][0]
            record['fields'] = service_fields() + [{'label': 'Barrier Construction', 'value': 'Concrete wall.'}]
            by_label(record['fields'])['FRL'].update(
                value='-/120/120 — observed source service ratings (Service Size / Configuration table 1).\n\n'
                      'Source configuration ratings remain subject to the stated barrier construction and installation conditions.',
                table_links=[{'field': SIZE, 'table_index': 0}])
            record['filter_values'] = {'report': [REPORT], 'substrate': ['Concrete/masonry wall'],
                'orientation': ['Vertical'], 'manufacturer': ['Trafalgar'], 'type': ['Core hole'],
                'category': ['Electrical & Communications'], 'services': ['Communications Cables'], 'frl': ['-/120/120']}
            bind_review(record)
            source_file = library_root / 'library.json'
            source_file.write_text(json.dumps(data), encoding='utf-8')
            source_bytes = source_file.read_bytes()
            library = ManualTechnicalLibrary(library_root, Store(root / 'state.sqlite3'))
            key = record['id']
            original = by_label(library.technical_edit(key, for_display=False)['record']['fields'])
            editor = library.technical_edit(key)
            snapshot = prepare_technical_item({'id': key}, library=library)
            for item in (library.detail('technical', key), editor['record'], snapshot):
                fields = by_label(item['fields'])
                self.assertEqual(fields[SIZE]['value'], SERVICE_TEXT)
                self.assertNotIn('Source Options', fields)
                self.assertNotIn('table', fields[SIZE])
                self.assertFalse(any(f.get('table_links') for f in fields.values()))
                self.assertRegex(fields[INSTALL]['value'], r'5\. [^\n]*300\s*mm')
            self.assertEqual(snapshot['tables'], [])
            pdf = PdfReader(BytesIO(render_technical_item_pdf(snapshot)))
            pdf_text = ' '.join(' '.join(page.extract_text() for page in pdf.pages).split())
            workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)), read_only=True)
            try:
                self.assertFalse(any(name.startswith('Installation Table') for name in workbook.sheetnames))
                book_text = ' '.join(str(cell) for row in workbook['Item Details'].values for cell in row)
            finally:
                workbook.close()
            for text in (pdf_text, book_text):
                self.assertIn(SERVICE_TEXT.replace(' ', ''), text.replace(' ', ''))
                self.assertRegex(text, r'5\. [^\n]*300\s*mm')
                for removed in ('Source Options', WRAP_NOTE, 'Where required', 'Service Size / Configuration table 1'):
                    self.assertNotIn(removed, text)

            edited = editor['record']
            body = {'revision': editor['revision'], 'source_sha256': editor['source_sha256'], 'request_key': None,
                    'title': 'Updated fixture title', 'facets': {key: edited['filter_values'][key] for key, _ in FACETS},
                    'fields': [{'label': field['label'], 'value': field.get('value', '')} for field in edited['fields']],
                    'report': {'number': REPORT, 'url': ''}}
            library.technical_save(key, body)
            stored = library.technical_edits.read()[0][key]['record']
            self.assertEqual(stored['title'], body['title'])
            raw = by_label(stored['fields'])
            for label in (SIZE, 'Service Wrap', INSTALL, 'Source Options', 'FRL'):
                self.assertEqual(raw[label], original[label])
            self.assertEqual(by_label(library.detail('technical', key)['fields'])[SIZE]['value'], SERVICE_TEXT)
            current = library.technical_edit(key)
            body.update(revision=current['revision'], source_sha256=current['source_sha256'],
                        fields=[{'label': f['label'], 'value': f.get('value', '')} for f in current['record']['fields']])
            body['facets']['frl'] = ['-/90/90']
            library.technical_save(key, body)
            changed = library.technical_edits.read()[0][key]['record']
            self.assertEqual(changed['filter_values']['frl'], ['-/90/90'])
            self.assertEqual(by_label(changed['fields'])['FRL'], {'label': 'FRL', 'value': '-/90/90'})
            self.assertEqual(source_file.read_bytes(), source_bytes)
