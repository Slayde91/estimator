"""Report links identify actual editions and never substitute a product manual."""
from copy import deepcopy
import unittest

from estimator.assessment_references import schedule_report_references, report_reference_text, _links
from estimator.calculator_report import _ScheduleReport, _register_fonts
from estimator.library_display import remove_resolved_source_notices


class Engine:
    def __init__(self, **values):
        self.values = values

    def value(self, sheet, address):
        return self.values.get(f'{sheet}!{address}', self.values.get(address, ''))


class AssessmentReferenceTests(unittest.TestCase):
    def refs(self, identity, **cells):
        return schedule_report_references(identity, Engine(**cells), 11)

    def test_direction_chooses_only_its_own_assessment(self):
        base = dict(C11='FyreWrap', AQ11='FC17299-01-1; FCO3226 Rev F')
        for direction, labels in [('Internal', ['FCO3226 Rev F']), ('External', ['FC17299-01-1']),
                                  ('Both', ['FC17299-01-1', 'FCO3226 Rev F']),
                                  ('Stair pressurisation', ['FC17299-01-1'])]:
            refs = self.refs('ductwork', **base, H11=direction)
            self.assertEqual([ref['label'] for ref in refs], labels)
            self.assertTrue(all(ref['url'] for ref in refs))
        self.assertEqual(self.refs('ductwork', **base, H11='unsupported'), [])

    def test_replaced_public_edition_is_not_linked_to_old_calculation(self):
        self.assertEqual(self.refs('ductwork', C11='MONOKOTE', AQ11='FC15909-01-2: Tables 2–4'),
                         [{'label': 'FC15909-01-2', 'url': None}])

    def test_source_is_bound_to_used_row_and_private_reports_stay_plain(self):
        self.assertEqual(self.refs('steel_intumescent', B11='FIRETEX FX5090', X11='FC20571/01/C1 p10 Table 2'),
                         [{'label': 'FC20571/01/C1', 'url': None}])
        self.assertEqual(self.refs('steel_intumescent', B11='FIRETEX FX5090', X11=''), [])
        self.assertEqual(self.refs('ductwork', C11='', AQ11='FAS230196 RIR3.2'), [])
        result = self.refs('steel_board', C11='PROMATECT 100', AT11='FC15555-01-03 Table 1')
        self.assertEqual(result[0]['label'], 'FC15555-01-03')
        self.assertIn('/cert_', result[0]['url'])
        corex = self.refs('steel_board', C11='TRAFALGAR COREX', AT11='COREX p23 | section schedule')
        self.assertEqual(corex[0]['label'], 'FAS200445 R2.0')
        unknown = self.refs('steel_board', C11='PROMATECT-XS', AT11='XS p16 section schedule')
        self.assertEqual(unknown, [{'label': 'Assessment not identified in source', 'url': None}])

    def test_xs_uses_the_assessment_explicitly_cited_by_its_actual_tables(self):
        cells = {'C11': 'PROMATECT-XS', 'AT11': 'XS p.16 | section schedule',
                 'PRODUCTS!G9': 'FAS230021'}
        expected = [{'label': 'FAS230021', 'url': None}]
        self.assertEqual(self.refs('steel_board', **cells), expected)
        cells.update(C11='promatect-xs', AT11='XS p.15 | general table')
        self.assertEqual(self.refs('steel_board', **cells), expected)
        cells['PRODUCTS!G9'] = 'Unidentified'
        self.assertEqual(self.refs('steel_board', **cells),
                         [{'label': 'Assessment not identified in source', 'url': None}])
        cells.update(AT11='', **{'PRODUCTS!G9': 'FAS230021'})
        self.assertEqual(self.refs('steel_board', **cells), [])

    def test_only_actual_report_documents_are_eligible(self):
        urls = list(_links().values())
        self.assertTrue(all(url and url.startswith('https://') for url in urls))
        self.assertFalse(any('manual' in url.lower() or 'contact' in url.lower() for url in urls))
        refs = self.refs('steel_vermiculite', B11='MONOKOTE MK-6 HY', C11='Hollow - 4 sides', X11='FAR4856 Issue 2 p9')
        self.assertEqual(refs[0]['label'], 'FAR4856 Issue 2')
        mixed = self.refs('steel_vermiculite', B11='monokote mk-6 hy', C11='hollow - 4 sides', X11='FAR4856 Issue 2 p9')
        self.assertEqual(mixed, refs)
        refs = self.refs('steel_vermiculite', B11='CAFCO 300', X11='CAFCO manual p7')
        self.assertEqual(refs[0]['label'], 'Assessment not identified in source')

    def test_export_text_is_literal_and_pdf_links_escape_text(self):
        refs = [{'label': 'FC123 <review>', 'url': 'https://example.org/report.pdf?a=1&b=2'}]
        self.assertEqual(report_reference_text(refs), 'FC123 <review>')
        self.assertIn('https://example.org', report_reference_text(refs, urls=True))
        _register_fonts()
        paragraph = _ScheduleReport({}).report_links(refs)
        self.assertIn('&lt;review&gt;', paragraph.text)
        self.assertIn('&amp;', paragraph.text)

    def test_boss_resolution_only_removes_owner_verified_notice_from_projection(self):
        notice = ('The matrix cites FAS190100 R2.1. BOSS currently lists WF FAS 190100. '
                  'Revision equivalence has not been verified.')
        original = {'id': 'boss-bf-3420', 'fields': [
            {'label': 'Report Number', 'value': 'FAS190100 R2.1'},
            {'label': 'Source Issues', 'value': notice + '\n\nSeparate size discrepancy.'}]}
        projected = deepcopy(original)
        remove_resolved_source_notices(projected)
        self.assertEqual(projected['fields'][1]['value'], 'Separate size discrepancy.')
        self.assertIn(notice, original['fields'][1]['value'])
        for identity, report in [('other', 'FAS190100 R2.1'), ('boss-other', 'FAS190100 R2.2')]:
            changed = deepcopy(original)
            changed['id'], changed['fields'][0]['value'] = identity, report
            remove_resolved_source_notices(changed)
            self.assertIn(notice, changed['fields'][1]['value'])


if __name__ == '__main__':
    unittest.main()
