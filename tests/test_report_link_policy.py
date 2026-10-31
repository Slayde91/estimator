"""Public report navigation never exposes internal source copies."""
import unittest
from estimator.library_report_links import report_href, pdf_report_href, FIREFLY_REPORTS_URL


class ReportLinkPolicyTests(unittest.TestCase):
    def test_firefly_override_is_exact_and_keeps_other_report_families_separate(self):
        for label in ('FAS190234', 'FAS190235 RIR1.29G', 'FAS190236 Rev 2'):
            for url in (None, '/api/libraries/documents/source.pdf', 'https://systems.tbafirefly.com.au/reports'):
                self.assertEqual(report_href(label, url), 'https://systems.tbafirefly.com.au/')
        self.assertIsNone(report_href('FAS1902340', None))

    def test_internal_routes_and_private_hosts_are_never_report_hyperlinks(self):
        for url in ('/api/libraries/documents/report-a.pdf', 'http://127.0.0.1:8765/api/libraries/documents/a.pdf',
                    'http://localhost/report.pdf', 'https://10.1.1.1/report.pdf', 'https://server.local/report.pdf'):
            self.assertIsNone(report_href('TEST-123', url, user_authored=True))
            self.assertIsNone(pdf_report_href(url, 'https://public.example'))

    def test_public_and_explicit_links_remain_available(self):
        url = 'https://media.promat.com/report.pdf'
        self.assertEqual(report_href('REPORT-123', url), url)
        directed = 'https://supplier.example/approved-report'
        self.assertEqual(report_href('REPORT-123', directed, user_authored=True), directed)
        self.assertIsNone(report_href('REPORT-123', directed))
        self.assertIsNone(report_href('REPORT-123'))

    def test_legacy_firefly_url_normalizes_without_rewriting_evidence(self):
        self.assertEqual(pdf_report_href('https://systems.tbafirefly.com.au/reports'), FIREFLY_REPORTS_URL)


if __name__ == '__main__':
    unittest.main()
