import unittest
from estimator.download_filenames import download_filename,download_header,document_filename,DOCUMENT_FILENAMES
from estimator.library_report_links import pdf_report_href


class DownloadNameTests(unittest.TestCase):
    def test_all_thirteen_authored_names_and_recorded_revisions(self):
        expected={'BREAKDOWN.pdf','FULL_SCHEDULE.pdf','SPRAY_SCHEDULE.pdf','PAINT_SCHEDULE.pdf',
                  'BOARD_SCHEDULE.pdf','DUCT_SCHEDULE.pdf','FIRESTOPPING_SCHEDULE.pdf',
                  'FULL_PRODUCT_SUMMARY.pdf','SPRAY_PRODUCT_SUMMARY.pdf','PAINT_PRODUCT_SUMMARY.pdf',
                  'BOARD_PRODUCT_SUMMARY.pdf','DUCT_PRODUCT_SUMMARY.pdf','INSTALLATION_CERTIFICATE.pdf'}
        self.assertEqual(set(DOCUMENT_FILENAMES.values()),expected)
        for kind,name in DOCUMENT_FILENAMES.items():
            self.assertEqual(document_filename(kind,'old name.pdf'),name)
            for revision in [1,2,12]:
                result=name[:-4]+f'-R{revision}.pdf'
                self.assertEqual(document_filename(kind,'old name.pdf',revision),result)
                self.assertEqual(document_filename(kind,result,revision),result)
        self.assertEqual(document_filename('other','CEASEFIRE-Export-R2.xlsx',3),'Export-R3.xlsx')
        long_name=document_filename('other','x'*196+'.pdf',1000)
        self.assertEqual(len(long_name),200);self.assertTrue(long_name.endswith('-R1000.pdf'))
        for invalid in [True,0,-1,'2',1.5]:
            with self.assertRaises(ValueError):document_filename('certification','old.pdf',invalid)

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

    def test_pdf_report_links_never_publish_internal_asset_routes(self):
        route='/api/libraries/documents/report-a.pdf'
        self.assertIsNone(pdf_report_href(route,'http://127.0.0.1:8765'))
        self.assertIsNone(pdf_report_href(route))
        for value in ['/api/libraries/documents/../secret.pdf','//example.com/report.pdf','javascript:alert(1)','/api/documentation/secret',None]:
            self.assertIsNone(pdf_report_href(value))


if __name__=='__main__':unittest.main()
