import unittest
from estimator.download_filenames import download_filename,download_header
from estimator.library_report_links import pdf_report_href


class DownloadNameTests(unittest.TestCase):
    def test_names_remove_brand_text_without_changing_other_names_or_extensions(self):
        for source,expected in [('CEASEFIRE-Estimate.pdf','Estimate.pdf'),
                                ('ceasefire-steel_board-schedule.xlsx','steel_board-schedule.xlsx'),
                                ('My-CEASEFIRE-Report.csv','My-Report.csv'),
                                ('CEASEFIRE.pdf','Download.pdf'),('Exact report.pdf','Exact report.pdf')]:
            self.assertEqual(download_filename(source),expected)

    def test_frozen_revision_headers_keep_inline_and_unicode_names(self):
        from estimator.project_file import project_download_header
        self.assertEqual(download_header('inline; filename="CEASEFIRE-Estimate.pdf"'),project_download_header('Estimate.pdf').replace('attachment;','inline;',1))
        header=project_download_header('CEASEFIRE-工程.pdf')
        self.assertEqual(download_header(header),project_download_header('工程.pdf'))

    def test_pdf_report_links_allow_only_known_local_asset_routes_and_valid_public_urls(self):
        route='/api/libraries/documents/report-a.pdf'
        self.assertEqual(pdf_report_href(route,'http://127.0.0.1:8765'),'http://127.0.0.1:8765'+route)
        self.assertEqual(pdf_report_href(route),route)
        for value in ['/api/libraries/documents/../secret.pdf','//example.com/report.pdf','javascript:alert(1)','/api/documentation/secret',None]:
            self.assertIsNone(pdf_report_href(value))


if __name__=='__main__':unittest.main()
