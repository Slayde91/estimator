"""Public report/reference consumers share one read-only catalogue policy."""

from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from uuid import UUID

from openpyxl import load_workbook
from pypdf import PdfReader

from estimator.penetration_calculator import calculate
from estimator.penetration_references import resolve_schedule_references
from estimator.reference_library import ReferenceLibrary, ReferenceNotFound
from estimator.register_references import physical_contexts
from estimator.takeoff_physical import apply_change, new_graph, preview_change
from estimator.technical_item_exports import (
    build_technical_item_xlsx, prepare_technical_item, render_technical_item_pdf,
)
from tests.test_reference_library import sample_library


REPORT = 'FAS200221 R3.0'
REPORT_URL = 'https://tfire.com.au/documents/FyreSHIELD-Range-Test-Report'
EXISTING_REPORT = 'EXISTING-42 Rev B'
EXISTING_URL = 'https://tfire.com.au/documents/existing-report.pdf'


def fingerprint_tree(root):
    return {str(path.relative_to(root)): sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if path.is_file()}


def pdf_links(reader):
    return [annotation.get_object()['/A']['/URI']
            for page in reader.pages for annotation in page.get('/Annots', [])
            if '/A' in annotation.get_object() and '/URI' in annotation.get_object()['/A']]


class FyreShieldReferenceIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'library'
        data, _, _ = sample_library(self.root)
        other_pdf = b'%PDF-1.4\nSynthetic second source document.\n%%EOF'
        (self.root / 'documents/report-b.pdf').write_bytes(other_pdf)
        data['documents'].append({'id': 'report-b', 'filename': 'Second source document.pdf',
                                  'sha256': sha256(other_pdf).hexdigest(), 'pages': 1})
        technical = data['libraries']['technical']
        technical['filters'] = [{'key': key, 'label': label} for key, label in (
            ('report', 'Report'), ('manufacturer', 'Manufacturer'),
            ('category', 'Category'), ('services', 'Services'),
            ('orientation', 'Orientation'), ('frl', 'FRL'),
        )]

        def record(key, product, *, manufacturer='Trafalgar'):
            return {'id': key, 'title': product + ' — access panel',
                    'fields': [{'label': 'Manufacturer', 'value': manufacturer},
                               {'label': 'System Products', 'value': product},
                               {'label': 'Service', 'value': 'Access Panel'},
                               {'label': 'Barrier Type', 'value': 'Wall'},
                               {'label': 'Barrier Construction', 'value': 'Concrete wall'},
                               {'label': 'FRL', 'value': '-/120/120'},
                               {'label': 'Installation Details', 'value': 'Synthetic installation conditions remain unchanged.'}],
                    'filter_values': {'manufacturer': [manufacturer], 'category': ['Access Panel'],
                                      'services': ['N/A'], 'orientation': ['Vertical'],
                                      'frl': ['-/120/120']}}

        # Sixty distinct source alternatives remain distinct systems. The range
        # report must be available for every alternative, not only a card title.
        self.shield_ids = [f'trafalgar-selector-{8000 + number}' for number in range(60)]
        families = ('FyreSHIELD', 'FyreSHIELD Plus', 'FyreSHIELD Screw Fixed', 'FyreSHIELD Plus Screw Fixed')
        technical['items'] = [record(key, families[number % len(families)])
                              for number, key in enumerate(self.shield_ids)]
        for number, item in enumerate(technical['items']):
            item['fields'].append({'label': 'Service Size / Configuration',
                                   'value': f'Synthetic variant {number + 1}; retain its own conditions.'})
            # Different imported diagrams can cite different source PDFs. The
            # assigned range report keeps its verified external link regardless.
            item['sources'] = [{'document_id': 'report-a' if number % 2 else 'report-b',
                                'filename': 'Synthetic retained source.pdf', 'page': 1}]
        technical['items'][0]['fields'].append({
            'label': 'Report Number', 'value': EXISTING_REPORT,
            'report_links': [{'label': EXISTING_REPORT, 'url': EXISTING_URL}],
        })
        technical['items'][0]['filter_values']['report'] = [EXISTING_REPORT]
        self.removed_ids = [f'trafalgar-selector-{9000 + number}' for number in range(4)]
        technical['items'].extend(record(key, product) for key, product in zip(
            self.removed_ids, ('FRSS', 'FRSS', 'FRSS Screw Fixed', 'FRSS Screw Fixed')))
        # Incidental prose is not a product identity and must not trigger removal
        # or report assignment for an unrelated manufacturer's system.
        unrelated = record('unrelated-other-system', 'Other Product', manufacturer='Other manufacturer')
        unrelated['fields'][-1]['value'] = 'Reference mentions FRSS and FyreSHIELD without identifying this system.'
        technical['items'].append(unrelated)
        data['links'] = [
            {'penetration_id': 'pkb-001', 'technical_id': key, 'relationship': 'Synthetic explicit source link'}
            for key in (self.shield_ids[1], self.shield_ids[2])
        ] + [{'penetration_id': 'pkb-002', 'technical_id': self.removed_ids[0],
              'relationship': 'Retained source association to an excluded catalogue item'}]
        (self.root / 'library.json').write_text(json.dumps(data), encoding='utf-8')
        self.source = deepcopy(data)
        self.before_files = fingerprint_tree(self.root)
        self.library = ReferenceLibrary(self.root)

    def tearDown(self):
        self.assertEqual(fingerprint_tree(self.root), self.before_files,
                         'Reference queries and exports must not rewrite the supplied library or assets.')
        self.assertEqual(json.loads((self.root / 'library.json').read_text(encoding='utf-8')), self.source)

    def resolve(self, **metadata):
        draft = {'globals': {}, 'rows': [{'id': 'line-1',
                 'inputs': {'J': 'Access Panel', 'K': 'N/A', 'M': 'Vertical', 'O': 2}, **metadata}]}
        before = deepcopy(draft)
        quantities = calculate(draft)['rows']
        result = resolve_schedule_references(draft, self.library)['row_references']['line-1']
        self.assertEqual(draft, before)
        self.assertEqual(calculate(draft)['rows'], quantities)
        return result

    def test_report_filter_finds_every_variant_and_retains_previous_report(self):
        listing = self.library.listing('technical', report=REPORT, limit='100')
        self.assertEqual(listing['total'], 60)
        self.assertEqual({item['id'] for item in listing['items']}, set(self.shield_ids))
        reports = next(entry['options'] for entry in listing['filters'] if entry['key'] == 'report')
        self.assertEqual(sum(option['value'] == REPORT for option in reports), 1)
        self.assertIn(EXISTING_REPORT, [option['value'] for option in reports])
        self.assertEqual([item['id'] for item in self.library.listing('technical', report=EXISTING_REPORT)['items']],
                         [self.shield_ids[0]])
        for key in self.shield_ids:
            with self.subTest(key=key):
                item = self.library.detail('technical', key)
                links = [link for field in item['fields'] for link in field.get('report_links', [])]
                self.assertEqual(links.count({'label': REPORT, 'url': REPORT_URL}), 1)
        self.assertEqual(self.library.listing('technical', search=REPORT, limit='100')['total'], 60)
        other = self.library.detail('technical', 'unrelated-other-system')
        self.assertFalse(any(field['label'] == 'Report Number' for field in other['fields']))

    def test_technical_pdf_and_xlsx_export_exact_report_hyperlinks(self):
        for key, expected in ((self.shield_ids[1], [(REPORT, REPORT_URL)]),
                              (self.shield_ids[0], [(EXISTING_REPORT, EXISTING_URL), (REPORT, REPORT_URL)])):
            with self.subTest(key=key):
                snapshot = prepare_technical_item({'id': key}, library=self.library)
                before = deepcopy(snapshot)
                workbook = load_workbook(BytesIO(build_technical_item_xlsx(snapshot)))
                try:
                    linked = [(cell.value, cell.hyperlink.target)
                              for sheet in workbook for row in sheet for cell in row if cell.hyperlink]
                    self.assertEqual(linked, expected)
                    self.assertFalse(any(cell.data_type == 'f' for sheet in workbook for row in sheet for cell in row))
                finally:
                    workbook.close()
                reader = PdfReader(BytesIO(render_technical_item_pdf(snapshot)))
                self.assertEqual(pdf_links(reader), [url for _, url in expected])
                text = '\n'.join(page.extract_text() for page in reader.pages)
                for label, _ in expected:
                    self.assertIn(label, text)
                self.assertIn('Synthetic installation conditions remain unchanged.', text)
                self.assertEqual(snapshot, before)

    def test_firestop_library_takeoff_and_explicit_selections_share_report_and_systems(self):
        selected = [self.shield_ids[1], self.shield_ids[2]]
        for metadata, basis in (({'library_item_id': 'pkb-001'}, 'library'),
                                ({'takeoff_reference_ids': selected}, 'takeoff'),
                                ({'technical_reference_ids': selected}, 'selected')):
            with self.subTest(basis=basis):
                result = self.resolve(**metadata)
                self.assertEqual(result['basis'], basis)
                self.assertEqual(result['reports'], [{'label': REPORT, 'url': REPORT_URL}])
                self.assertEqual([(system['id'], system['number']) for system in result['systems']],
                                 [(selected[0], 1), (selected[1], 2)])
        manual = self.resolve(report_reference=REPORT)
        self.assertEqual(manual['reports'], [{'label': REPORT, 'url': REPORT_URL}])
        self.assertEqual(manual['systems'], [], 'Choosing a report must not choose an installation system.')
        self.assertEqual(manual['initial_filters']['report'], REPORT)
        self.assertIsNone(manual['missing_report'])

    def test_takeoff_physical_context_resolves_the_same_public_references_without_mutation(self):
        for scope, version in (('defect_reports', 2), ('service_plans', 3)):
            with self.subTest(scope=scope):
                uid = lambda number: str(UUID(int=number))
                graph = new_graph(uid(100), uid(101), version=version)
                entities = [('defect', 1, {})] if version == 2 else []
                entities += [('barrier', 2, {'defect_id': uid(1)} if version == 2 else {}),
                             ('service', 3, {'barrier_id': uid(2), 'quantity': 2})]
                for kind, number, extra in entities:
                    command = {'op': 'create', 'kind': kind, 'entity': {
                        'id': uid(number), 'fields': {}, 'evidence': [],
                        'uncertainty': {'state': 'not_assessed', 'note': ''}, **extra}}
                    preview = preview_change(graph, command)
                    graph = apply_change(graph, command, expected_revision=graph['revision'],
                                         preview_digest=preview['preview_digest'])['graph']
                snapshot = {'physical' if version == 2 else 'service_plans': graph,
                            'library_assignments': {'records': [{'scope': scope,
                                'library': {'id': 'pkb-001'}, 'members': [{'id': uid(3)}]}]}}
                before = deepcopy(snapshot)
                contexts = physical_contexts(snapshot, scope, [uid(3)])
                result = self.library.register_references(contexts)['row_references'][uid(3)]
                self.assertEqual(result['reports'], [{'label': REPORT, 'url': REPORT_URL}])
                self.assertEqual([item['id'] for item in result['systems']], self.shield_ids[1:3])
                self.assertEqual(snapshot, before)

    def test_excluded_frss_cannot_be_opened_exported_filtered_or_resolved(self):
        self.assertEqual(self.library.listing('technical', search='FRSS')['total'], 1,
                         'The unrelated record mentioning FRSS remains; the four FRSS systems do not.')
        visible = {item['id'] for item in self.library.listing('technical', limit='100')['items']}
        self.assertTrue(set(self.removed_ids).isdisjoint(visible))
        self.assertEqual(visible, set(self.shield_ids) | {'unrelated-other-system'})
        for key in self.removed_ids:
            with self.subTest(key=key):
                with self.assertRaises(ReferenceNotFound):
                    self.library.detail('technical', key)
                with self.assertRaises(ReferenceNotFound):
                    prepare_technical_item({'id': key}, library=self.library)
                for field in ('technical_reference_ids', 'takeoff_reference_ids'):
                    result = self.resolve(**{field: [key]})
                    self.assertEqual(result['systems'], [])
                    self.assertEqual(result['reports'], [])
                    self.assertEqual(result['missing_ids'], [key])
        inherited = self.resolve(library_item_id='pkb-002')
        self.assertEqual(inherited['systems'], [])
        self.assertEqual(inherited['reports'], [])
        takeoff = self.library.register_references({'removed': [{'library_ids': ['pkb-002']}]})
        self.assertEqual(takeoff['row_references']['removed']['systems'], [])
        self.assertEqual(takeoff['row_references']['removed']['reports'], [])


if __name__ == '__main__':
    unittest.main()
