"""Register export preserves explicit hierarchy, precision and original drafts."""
from copy import deepcopy
from io import BytesIO
import unittest
from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.takeoff_physical_exports import MATRIX_HEADERS, matrix_rows, export_physical_graph
from tests import test_takeoff_physical_v2_exports as fixtures
from tests.test_takeoff_physical import uid


class PassiveFireMatrixTests(unittest.TestCase):
    def fixture(self):
        case = fixtures.PhysicalV2ExportTests(); case.setUp()
        return case

    def test_active_leaf_rows_inherit_parents_without_invented_counts(self):
        case = self.fixture()
        case.add('defect', 5, fields={'location': 'Empty defect'})
        case.change({'op':'update','entity_id':uid(1),'changes':{'fields':{
            **case.graph['defects'][0]['fields'], 'location':'L02'}}})
        case.change({'op':'update','entity_id':uid(2),'changes':{'fields':{
            'location':'Legacy upper floor', 'substrate':'Concrete', 'orientation':'Horizontal'}}})
        case.change({'op':'update','entity_id':uid(3),'changes':{'fields':{
            'service':'Electrical & Communications','service_type':'Cable tray','size':'123.456789'},'quantity':7}})
        before = deepcopy(case.graph)
        rows = matrix_rows(case.graph)
        self.assertEqual(rows[0], ['D-0001','B-0001','S-0001','L02','120/120/120',
            'Concrete','Horizontal','Electrical & Communications','Cable tray',7,'123.456789'])
        self.assertEqual(rows[1][0:3], ['D-0001','B-0002',''])
        self.assertEqual(rows[1][3], 'L02')
        self.assertEqual(rows[1][9], '')
        self.assertEqual(rows[2][0:4], ['D-0002','','','Empty defect'])
        self.assertEqual(rows[2][9], '')
        self.assertEqual(case.graph, before)
        self.assertEqual(case.graph['barriers'][0]['fields']['location'], 'Legacy upper floor')
        case.change({'op':'delete','entity_id':uid(2),'cascade':True})
        self.assertFalse(any('S-0001' in row or 'B-0001' in row for row in matrix_rows(case.graph)))

    def test_pdf_has_exact_columns_title_literal_text_and_deterministic_bytes(self):
        case = self.fixture()
        case.change({'op':'update','entity_id':uid(3),'changes':{'fields':{
            'service':'Mechanical','service_type':'<Pipe & cable>','size':'12.345678901'}}})
        before = deepcopy(case.graph)
        payload, mime, filename = export_physical_graph(case.graph, 'pdf')
        self.assertEqual((mime,filename), ('application/pdf','Passive_Fire_Matrix.pdf'))
        self.assertEqual(payload, export_physical_graph(case.graph,'pdf')[0])
        reader = PdfReader(BytesIO(payload)); text = ' '.join(reader.pages[0].extract_text().split())
        self.assertEqual(reader.metadata.title, 'Passive_Fire_Matrix')
        for header in MATRIX_HEADERS: self.assertIn(header, text)
        for value in ('<Pipe & cable>','12.345678901','UNAPPROVED DRAFT'): self.assertIn(value,text)
        self.assertNotIn('TAKEOFF LEGEND',text)
        self.assertEqual(case.graph,before)

    def test_many_rows_repeat_headings_and_long_fields_remain_readable(self):
        case = self.fixture()
        for number in range(10,70):
            case.add('service',number,2,fields={'service_type':f'Pipe {number}'},quantity=number)
        payload=export_physical_graph(case.graph,'pdf')[0]; pages=PdfReader(BytesIO(payload)).pages
        self.assertGreater(len(pages),1)
        for page in pages:
            text=' '.join(page.extract_text().split())
            for label in MATRIX_HEADERS:self.assertIn(label,text)
        case.change({'op':'update','entity_id':uid(3),'changes':{'fields':{'service_type':'X'*2000}}})
        long_text=''.join(
            ''.join(page.extract_text().split()) for page in PdfReader(BytesIO(export_physical_graph(case.graph,'pdf')[0])).pages)
        self.assertIn('X'*2000,long_text)

    def test_legacy_graph_is_not_flattened_into_unrelated_current_ids(self):
        from estimator.takeoff_physical import new_graph
        with self.assertRaises(ValidationError): export_physical_graph(new_graph(uid(100),uid(200),version=1),'pdf')


if __name__ == '__main__': unittest.main()
