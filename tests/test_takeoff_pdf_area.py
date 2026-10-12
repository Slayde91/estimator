"""Independent calibrated PDF areas never acquire register or transfer authority."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import math
import unittest
from uuid import uuid4

from pypdf import PdfReader
from estimator.catalog import ValidationError
from estimator.takeoff_area import _inside
from estimator.takeoff_graphics import graphic_geometry_cost, validate_graphics, validate_history
from estimator.takeoff_model import validate_snapshot
from tests import test_takeoff_workspace as fixtures
from tests import test_takeoff_project as projects


class PDFOnlyAreaTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.TakeoffWorkspaceTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def proposal(self, **changes):
        case = self.case
        return {'mode': 'steel', 'document_id': case.doc['id'], 'source_sha256': case.doc['sha256'],
                'page': 1, 'kind': 'area', 'geometry': {'points': [[20, 30], [120, 30], [120, 80], [20, 80]],
                'exclusions': [{'id': str(uuid4()), 'points': [[40, 40], [60, 40], [60, 50], [40, 50]], 'note': 'Opening'}]},
                'text': '', 'appearance': {}, 'calibration_id': case.calibration_id, **changes}

    def create(self, **changes):
        return self.case.command('create_graphic', graphic=self.proposal(**changes))['created_graphic_id']

    def record(self, identifier):
        return next(value for value in self.case.state['snapshot']['graphics']['records'] if value['id'] == identifier)

    def result(self, identifier):
        return next(value for value in self.case.state['pdf_measure_results'] if value['id'] == identifier)

    def test_all_workspaces_reuse_exact_surface_calculation_and_keep_authority_unchanged(self):
        case = self.case; before = deepcopy(case.state['snapshot'])
        for mode in ('steel', 'duct', 'wall', 'slab', 'defect_reports', 'service_plans'):
            identifier = self.create(mode=mode); result = self.result(identifier); record = self.record(identifier)
            self.assertEqual(result['status'], 'current')
            self.assertEqual((result['gross_area_m2'], result['excluded_area_m2'], result['net_area_m2']), (50, 2, 48))
            self.assertEqual(result['issues'], [])
            self.assertTrue(_inside(result['label_point_pdf'], record['geometry']['points']))
            self.assertFalse(_inside(result['label_point_pdf'], record['geometry']['exclusions'][0]['points']))
            self.assertEqual(graphic_geometry_cost(record), 8)
            self.assertEqual(set(record), {'id','version','mode','document_id','source_sha256','page','kind','geometry','text','appearance','calibration_id'})
            for key in ('items', 'calibrations', 'transfers', 'documents', 'render_checks'):
                self.assertEqual(case.state['snapshot'][key], before[key])
            self.assertEqual(case.state['item_results'], [])
            self.assertNotIn('physical', case.state['snapshot']); self.assertNotIn('service_plans', case.state['snapshot'])

    def test_fractional_area_keeps_full_precision_and_render_metadata_cannot_change_measurement(self):
        points = [[20.125, 30.875], [120.3333, 30.875], [120.3333, 81.2345], [20.125, 81.2345]]
        identifier = self.create(geometry={'points': points, 'exclusions': []})
        expected = (120.3333-20.125)*(81.2345-30.875)*.1*.1
        self.assertEqual(self.result(identifier)['net_area_m2'], expected)
        self.assertNotEqual(expected, round(expected, 2))
        from estimator.takeoff_pdf_measure import measure_result
        for rotation in (0, 90, 180, 270):
            for unit in (1, 2, 5):
                state = deepcopy(self.case.state['snapshot']); state['documents'][0]['pages'][0].update(rotation=rotation,user_unit=unit)
                self.assertEqual(measure_result(self.record(identifier), state)['net_area_m2'], expected)

    def test_hole_move_removal_and_undo_keep_one_graphic_identity(self):
        case=self.case; identifier=self.create(); original=deepcopy(self.record(identifier)); revision=case.state['revision']
        geometry=deepcopy(original['geometry']); geometry['exclusions'][0]['points'][2]=[70,50]
        case.command('update_graphic', graphic_id=identifier, changes={'geometry':geometry})
        self.assertEqual(case.state['revision'], revision+1); self.assertEqual(self.result(identifier)['net_area_m2'],47.5)
        self.assertEqual(self.record(identifier)['geometry']['exclusions'][0]['id'], original['geometry']['exclusions'][0]['id'])
        geometry=deepcopy(self.record(identifier)['geometry']); geometry['exclusions']=[]
        case.command('update_graphic', graphic_id=identifier, changes={'geometry':geometry})
        self.assertEqual(self.result(identifier)['net_area_m2'],50)
        case.command('undo'); self.assertEqual(self.result(identifier)['net_area_m2'],47.5)
        case.command('delete_graphic', graphic_id=identifier); self.assertEqual(case.state['pdf_measure_results'],[])
        case.command('undo'); self.assertEqual(self.result(identifier)['id'],identifier)
        self.assertGreater(self.record(identifier)['version'],original['version'])
        self.assertEqual(case.state['snapshot']['items'],[])

    def test_invalid_topology_hole_associations_and_bounds_fail_atomically(self):
        before=deepcopy(self.case.state['snapshot']); valid=self.proposal(); hole=valid['geometry']['exclusions'][0]
        geometries=[
            {'points':[[20,30],[120,80],[20,80],[120,30]],'exclusions':[]},
            {'points':[[20,30],[120,30],[120,30],[20,80]],'exclusions':[]},
            {'points':[[20,30],[120,30],[120,80],[20,80]],'exclusions':[{**hole,'points':[[10,40],[60,40],[60,50],[10,50]]}]},
            {'points':[[20,30],[120,30],[120,80],[20,80]],'exclusions':[{**hole,'points':[[20,40],[60,40],[60,50],[20,50]]}]},
            {'points':[[20,30],[120,30],[120,80],[20,80]],'exclusions':[hole,{**hole,'id':str(uuid4())}]},
            {'points':[[20,30],[220,30],[220,80],[20,80]],'exclusions':[]},
            {'points':[[20,30],[120,30],[120,80],[20,80]],'exclusions':[hole,{**hole}]},
            {'points':[[20,30],[120,30],[120,80],[20,80]],'exclusions':[],'net_area_m2':50},
        ]
        for geometry in geometries:
            with self.subTest(geometry=geometry),self.assertRaises(ValidationError):self.create(geometry=geometry)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'],before)
        for extra in ({'kind':'area-exclusion'},{'quantity':1},{'calibration_id':str(uuid4())},{'source_sha256':'b'*64},{'text':'Unbound area claim'}):
            with self.subTest(extra=extra),self.assertRaises(ValidationError):self.create(**extra)
            self.assertEqual(self.case.service.get(self.case.sid)['snapshot'],before)
        missing=self.proposal();del missing['calibration_id']
        with self.assertRaises(ValidationError):self.case.command('create_graphic',graphic=missing)

    def test_hole_ids_cannot_collide_with_register_or_source_identities(self):
        identifier=self.create(); before=deepcopy(self.case.state['snapshot'])
        for identity in (self.case.doc['id'], self.case.calibration_id,identifier):
            state=deepcopy(before);state['graphics']['records'][0]['geometry']['exclusions'][0]['id']=identity
            with self.subTest(identity=identity),self.assertRaisesRegex(ValidationError,'unique and separate'):validate_graphics(state)

    def test_closed_boundary_and_contained_viewports_block_page_scale(self):
        case=self.case; viewport=str(uuid4())
        case.command('add_calibration',calibration={'id':viewport,'document_id':case.doc['id'],'page':1,
            'points':[[80,50],[100,50]],'distance_m':20,'uniform_scale':True,'region':[80,50,20,10]})
        before=deepcopy(case.state['snapshot'])
        # No outer vertex lies in the viewport and no edge crosses it: the
        # polygon interior still encloses a region with a different scale.
        with self.assertRaisesRegex(ValidationError,'another viewport'):self.create()
        self.assertEqual(case.service.get(case.sid)['snapshot'],before)
        # The implicit closing edge also intersects the selected inset.
        with self.assertRaises(ValidationError):self.create(geometry={'points':[[70,45],[110,45],[70,65]],'exclusions':[]})
        self.create(calibration_id=viewport,geometry={'points':[[82,52],[98,52],[98,58],[82,58]],'exclusions':[]})
        self.assertEqual(case.state['pdf_measure_results'][0]['net_area_m2'],96)

    def test_retired_scale_invalidates_area_and_explicit_rebind_recalculates_scale_squared(self):
        case=self.case; identifier=self.create(); original=deepcopy(case.state['snapshot']['graphics'])
        reply=case.command('update_calibration',calibration_id=case.calibration_id,changes={'distance_m':20})
        self.assertEqual(case.state['snapshot']['graphics'],original)
        result=self.result(identifier);self.assertEqual(result['status'],'needs_review')
        for name in ('gross_area_m2','excluded_area_m2','net_area_m2','label_point_pdf'):self.assertIsNone(result[name])
        self.assertEqual(result['issues'][0]['code'],'PDF_AREA_SCALE_REVIEW');validate_snapshot(case.state['snapshot'])
        before=deepcopy(case.state['snapshot'])
        with self.assertRaises(ValidationError):case.command('update_graphic',graphic_id=identifier,changes={'geometry':deepcopy(original['records'][0]['geometry'])})
        self.assertEqual(case.service.get(case.sid)['snapshot'],before)
        case.command('update_graphic',graphic_id=identifier,changes={'calibration_id':reply['revised_calibration_id']})
        self.assertEqual(self.result(identifier)['net_area_m2'],192)

    def test_visual_audit_cannot_smuggle_area_to_register_or_rebind_tool(self):
        identifier=self.create();snapshot=self.case.state['snapshot'];event=deepcopy(self.case.documents.get_blob(snapshot['audit_head']))
        event['after']['items'].append({'id':str(uuid4())})
        with self.assertRaisesRegex(ValidationError,'cannot change measurements'):validate_history(event)
        self.case.command('update_graphic',graphic_id=identifier,changes={'appearance':{'opacity':.5}})
        event=deepcopy(self.case.documents.get_blob(self.case.state['snapshot']['audit_head']))
        event['after']['graphics']['records'][0]['kind']='polygon'
        with self.assertRaisesRegex(ValidationError,'source or tool identity'):validate_history(event)

    def test_confirmed_calculator_items_and_transfer_records_stay_exact(self):
        case=self.case;item=case.create();case.confirm(item);before=deepcopy(case.state['snapshot']);results=deepcopy(case.state['item_results'])
        self.create()
        for key in ('items','transfers'):self.assertEqual(case.state['snapshot'][key],before[key])
        self.assertEqual(case.state['item_results'],results)


class PDFOnlyAreaPortableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):projects.TakeoffProjectTests.setUpClass()

    def setUp(self):
        self.case=projects.TakeoffProjectTests();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.doc=self.case.session['snapshot']['documents'][0]

    def command(self,op,**values):
        case=self.case;case.session=case.service.command(case.session['session_id'],{'op':op,'expected_revision':case.session['revision'],'request_id':str(uuid4()),**values});return case.session

    def test_marked_pdf_has_net_area_all_rings_save_reopen_and_no_register_rows(self):
        case=self.case;calibration=str(uuid4());hole=str(uuid4())
        self.command('add_calibration',calibration={'id':calibration,'document_id':self.doc['id'],'page':1,'points':[[50,300],[450,300]],'distance_m':8.35,'uniform_scale':True})
        identifier=self.command('create_graphic',graphic={'mode':'steel','document_id':self.doc['id'],'source_sha256':self.doc['sha256'],'page':1,'kind':'area',
            'geometry':{'points':[[50,100],[450,100],[450,300],[50,300]],'exclusions':[{'id':hole,'points':[[100,150],[200,150],[200,200],[100,200]],'note':'Opening'}]},
            'text':'','appearance':{'fill_enabled':True},'calibration_id':calibration})['created_graphic_id']
        before=deepcopy(case.session['snapshot']);result=case.session['pdf_measure_results'][0]
        self.assertAlmostEqual(result['net_area_m2'],75000*(8.35/400)**2)
        payload,mime,_=case.service.export_workspace(case.session['session_id'],'marked-pdf',{'expected_revision':case.session['revision'],'mode':'steel','document_id':self.doc['id'],'item_ids':[]})
        pdf=PdfReader(BytesIO(payload));text='\n'.join(page.extract_text() for page in pdf.pages)
        self.assertIn('32.68 m²',text);self.assertEqual(mime,'application/pdf')
        # The two closed subpaths are painted together using even-odd fill.
        path=[];closed=0;painted=[]
        for operands,operator in pdf.pages[0].get_contents().operations:
            if operator==b'n':path=[];closed=0
            elif operator in (b'm',b'l'):path.append([float(value) for value in operands])
            elif operator==b'h':closed+=1
            elif operator==b'B*':painted.append((deepcopy(path),closed))
        self.assertEqual(len(painted),1);placed,closed=painted[0];self.assertEqual(closed,2)
        original=before['graphics']['records'][0]['geometry'];expected=original['points']+original['exclusions'][0]['points']
        offset=[placed[0][axis]-expected[0][axis] for axis in (0,1)]
        self.assertEqual([[point[axis]-offset[axis] for axis in (0,1)] for point in placed],expected)
        self.assertEqual(case.service.get(case.session['session_id'])['snapshot'],before)
        with self.assertRaisesRegex(ValidationError,'no items'):
            case.service.export_workspace(case.session['session_id'],'register-xlsx',{'expected_revision':case.session['revision'],'mode':'steel'})
        case.request.update(takeoffs=before);case.library.save_as(case.request);case.dialogs.opened=str(case.target);opened=case.library.open_file()
        self.assertEqual(opened['takeoffs']['graphics'],before['graphics']);self.assertEqual(opened['takeoffs']['items'],[])
        reopened=case.service.get(opened['takeoffs_session_id']);self.assertEqual(reopened['pdf_measure_results'][0]['id'],identifier)
        self.assertEqual(reopened['pdf_measure_results'][0]['net_area_m2'],result['net_area_m2'])
        self.assertEqual(sha256(case.documents.document_path(self.doc).read_bytes()).hexdigest(),self.doc['sha256'])
        self.command('update_calibration',calibration_id=calibration,changes={'distance_m':16.7})
        payload,_,_=case.service.export_workspace(case.session['session_id'],'marked-pdf',{'expected_revision':case.session['revision'],'mode':'steel','document_id':self.doc['id'],'item_ids':[]})
        retired='\n'.join(page.extract_text() for page in PdfReader(BytesIO(payload)).pages)
        self.assertIn('Scale needs review',retired);self.assertNotIn('32.68 m²',retired)


if __name__=='__main__':unittest.main()
