"""Form definitions, authenticated submissions and immutable workflow sign-offs."""
import base64
import json
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from uuid import uuid4

from pypdf import PdfReader

from estimator.catalog import ValidationError
from estimator.crm_access import CRMAccess
from estimator.forms import FormError, Forms
from estimator.forms_http import FormsHTTP
from estimator.forms_pdf import render_form_pdf
from estimator.scheduler import SchedulerStore
from estimator.server import create_server


def identifier():
    return str(uuid4())


def field(name, kind='text', **options):
    return {'id': name, 'type': kind, 'label': name.title(), **options}


def template(**changes):
    return {'id': identifier(), 'version': 0, 'name': 'Inspection', 'description': '',
            'status': 'published', 'roles': ['editor','viewer','admin'], 'mode': 'timeline',
            'fields': [field('site',required=True)], 'settings': {}, **changes}


def entry(t, values, **changes):
    return {'id': identifier(), 'version': 0, 'template_id': t['id'], 'template_version': t['version'],
            'status': 'draft', 'values': values, **changes}


class FormsTests(unittest.TestCase):
    def test_rich_form_values_defaults_fixed_cells_and_legacy_text(self):
        rich = {'html':'<b>One</b> &amp; <i>two</i>'}
        fields = [field('note', 'textarea', required=True, default=rich), field('intro', 'instruction', help=rich),
                  field('rows', 'table', table_mode='fixed', default=[{'cell':rich}],
                        columns=[field('cell', 'textarea'), field('formula', 'formula', formula='=A1')])]
        settings = {'summary_fields':['note'], 'summary_cells':[{'field_id':'rows','row':0,'column_id':'cell'}]}
        t = self.store.save_template(self.editor, template(fields=fields, settings=settings))
        values = {'note':rich, 'rows':[{'cell':rich}]}
        result = self.store.save_entry(self.editor, entry(t, values, status='submitted'))
        self.assertEqual(result['values']['note'],rich)
        self.assertEqual(result['values']['rows'][0]['formula'],'One & two')
        self.assertEqual(result['summary_values'],{'note':'One & two', 'rows:0:cell':'One & two'})
        legacy = self.store.save_entry(self.editor, entry(t, {**values,'note':'<b>literal</b>'}))
        self.assertEqual(legacy['summary_values']['note'],'<b>literal</b>')
        for invalid in ('<a href="x">Link</a>', '<img src="x">', '<b>'*33+'a'+'</b>'*33):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                self.store.save_template(self.editor, template(fields=[field('i','instruction',help={'html':invalid})]))
            with self.assertRaises(ValidationError):
                self.store.save_entry(self.editor, entry(t, {**values,'note':{'html':invalid}}))
        with self.assertRaises(ValidationError):
            self.store.save_entry(self.editor, entry(t,{**values,'note':{'html':'<p><br></p>'}},status='submitted'))

    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)/'forms.sqlite3'
        self.admin = {'id':'boss','role':'admin','name':'Administrator'}
        self.editor = {'id':'sam','role':'editor','name':'Sam'}
        self.other = {'id':'alex','role':'editor','name':'Alex'}
        self.viewer = {'id':'joe','role':'viewer','name':'Joe'}
        self.staff = [self.admin,self.editor,self.other,self.viewer]
        self.store = Forms(self.path,lambda: self.staff,lambda: {'name':'Example Co','phone':'123'})

    def test_requested_entry_is_idempotent_private_and_fillable_by_assignee(self):
        t = self.store.save_template(self.admin,template(roles=['editor']))
        self.assertTrue(t['can_assign'])
        people = self.store.assignees(self.admin,t['id'],t['version'])['staff']
        self.assertEqual(people,[{'id':'sam','name':'Sam'},{'id':'alex','name':'Alex'}])
        data = {'id':identifier(),'template_id':t['id'],'template_version':t['version'],'member_id':'alex'}
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(lambda _: self.store.assign_entry(self.editor,data), range(2)))
        self.assertEqual(receipts[0],receipts[1])
        rows = self.store.entries(self.other)['entries']
        self.assertEqual(len(rows),1)
        self.assertEqual((rows[0]['status'],rows[0]['created_by'],rows[0]['assigned_to']),('requested','sam','alex'))
        self.assertTrue(rows[0]['can_edit'])
        self.assertEqual(self.store.entries(self.editor)['entries'],[])
        self.assertFalse(self.store.entry(self.admin,data['id'])['can_edit'])
        with self.assertRaises(FormError) as denied:
            self.store.assign_entry(self.editor,{**data,'member_id':'joe'})
        self.assertEqual(denied.exception.status,403)
        with self.assertRaises(FormError) as conflict:
            self.store.assign_entry(self.editor,{**data,'member_id':'sam'})
        self.assertEqual(conflict.exception.status,409)
        saved = self.store.save_entry(self.other,entry(t,{'site':'South'},id=data['id'],version=1))
        self.assertEqual((saved['status'],saved['assigned_to_name']),('draft','Alex'))
        done = self.store.save_entry(self.other,entry(t,{'site':'South'},id=data['id'],version=2,status='submitted'))
        self.assertEqual((done['status'],done['values']['site']),('submitted','South'))
        self.assertEqual(self.store.assign_entry(self.editor,data),receipts[0])
        self.assertEqual(self.store.entry(self.other,data['id'])['status'],'submitted')

    def test_assigned_workflow_restricts_first_stage_and_honours_permission_changes(self):
        stages = [{'id':'prep','name':'Prepare','roles':['editor'],'member_ids':['sam','alex']},
                  {'id':'review','name':'Review','roles':['admin']}]
        definition = template(mode='workflow',settings={'stages':stages})
        t = self.store.save_template(self.admin,definition)
        data = {'id':identifier(),'template_id':t['id'],'template_version':1,'member_id':'alex'}
        self.assertEqual([m['id'] for m in self.store.assignees(self.admin,t['id'],1)['staff']],['sam','alex'])
        with self.assertRaises(FormError):
            self.store.assign_entry(self.viewer,data)
        with self.assertRaises(FormError):
            self.store.assign_entry(self.admin,{**data,'member_id':'boss'})
        self.store.assign_entry(self.admin,data)
        self.assertEqual(self.store.entries(self.editor)['entries'],[])
        record = self.store.save_entry(self.other,entry(t,{'site':'South'},id=data['id'],version=1))
        self.assertEqual(self.store.entries(self.editor)['entries'],[])
        record = self.store.approve(self.other,{'id':data['id'],'version':record['version']})
        self.assertEqual(record['stage_id'],'review')
        self.assertTrue(self.store.entry(self.admin,data['id'])['can_approve'])
        self.store.save_template(self.admin,{**definition,'version':1,'roles':['admin'],'settings':{
            'stages':[{'id':'review','name':'Review','roles':['admin']}]}})
        with self.assertRaises(FormError):
            self.store.entry(self.other,data['id'])
        with self.assertRaises(FormError) as conflict:
            self.store.assign_entry(self.admin,data)
        self.assertEqual(conflict.exception.status,409)

    def test_entry_pdf_theme_survives_legacy_writes_retries_and_reopen(self):
        workflow = template(mode='workflow',settings={'stages':[{'id':'one','name':'Review','roles':['editor']}]})
        version = self.store.save_template(self.editor,workflow)
        data = entry(version,{'site':'West'})
        record = self.store.save_entry(self.editor,data)
        self.assertEqual(record['pdf_theme'],'ceasefire')
        with self.assertRaises(ValidationError):
            self.store.save_entry(self.editor,{**data,'version':1,'pdf_theme':'not-a-theme'})
        revised = {**data,'version':1,'pdf_theme':'forest'}
        self.assertEqual(self.store.save_entry(self.editor,revised)['version'],2)
        self.assertEqual(self.store.save_entry(self.editor,revised)['version'],2)
        legacy = self.store.save_entry(self.editor,{**data,'version':2})
        self.assertEqual(legacy['pdf_theme'],'forest')
        self.store.save_template(self.editor,{**workflow,'version':1,'name':'Revised template'})
        stage = {'id':record['id'],'version':3}
        signed = self.store.approve(self.editor,stage)
        self.assertEqual(self.store.approve(self.editor,stage),signed)
        reopened = self.store.reopen(self.editor,{'id':record['id'],'version':4})
        self.assertEqual((reopened['pdf_theme'],reopened['template_version']),('forest',1))
        self.assertEqual(self.store.entries(self.editor)['entries'][0]['pdf_theme'],'forest')

    def test_permissions_history_version_pin_and_immediate_revocation(self):
        definition = template(status='draft')
        draft = self.store.save_template(self.editor,definition)
        self.assertEqual(self.store.templates(self.viewer),{'templates':[]})
        with self.assertRaises(FormError):
            self.store.template(self.other,draft['id'])
        published = self.store.save_template(self.editor,{**definition,'version':1,'status':'published'})
        self.assertFalse(self.store.template(self.viewer,published['id'])['can_fill'])
        with self.assertRaises(FormError):
            self.store.history(self.viewer,published['id'])
        with self.assertRaises(FormError):
            self.store.template(self.other,published['id'],1)
        with self.assertRaises(FormError):
            self.store.save_template(self.other,{**definition,'version':2})
        with self.assertRaises(FormError):
            self.store.save_entry(self.viewer,entry(published,{}))
        saved = self.store.save_entry(self.other,entry(published,{'site':'Here'}))
        self.assertEqual(self.store.entries(self.editor)['entries'],[])
        self.assertEqual(self.store.entries(self.viewer)['entries'],[])
        renamed = self.store.save_template(self.editor,{**definition,'name':'New inspection','version':2,'status':'published',
            'fields':[field('new',required=True)]})
        with self.assertRaises(FormError):
            self.store.save_entry(self.editor,entry(published,{}))
        self.assertEqual(renamed['version'],3)
        submitted = self.store.save_entry(self.other,entry(published,{'site':'There'},id=saved['id'],version=1,status='submitted'))
        self.assertEqual(submitted['template']['name'],'Inspection')
        self.assertEqual(self.store.entry(self.viewer,saved['id'])['values'],{'site':'There'})
        self.assertEqual([row['version'] for row in self.store.history(self.editor,published['id'])['versions']],[3,2,1])
        with self.assertRaises(FormError):
            self.store.save_entry(self.other,entry(published,{'site':'Edited'},id=saved['id'],version=2))
        self.store.save_template(self.admin,{**definition,'version':3,'status':'published','roles':['admin']})
        self.assertEqual(self.store.entries(self.viewer),{'entries':[]})
        with self.assertRaises(FormError):
            self.store.entry(self.other,saved['id'])
        self.assertEqual(self.store.template(self.admin,published['id'],1)['status'],'draft')

    def test_concurrent_retries_and_distinct_counters(self):
        body = template(fields=[field('index','counter'),field('name')],settings={'summary_fields':['index','name']})
        t = self.store.save_template(self.editor,body)
        self.assertEqual(self.store.save_template(self.editor,body),t)
        with self.assertRaises(FormError) as conflict:
            self.store.save_template(self.editor,{**body,'name':'Changed'})
        self.assertEqual(conflict.exception.status,409)
        save = lambda data: self.store.save_entry(self.editor,data)
        same = entry(t,{'name':'First'})
        with ThreadPoolExecutor(3) as pool:
            first, retry, other = pool.map(save,[same,same,entry(t,{'name':'Second'})])
        self.assertEqual(first,retry)
        self.assertEqual(sorted([first['values']['index'],other['values']['index']]),[1,2])
        self.assertEqual([first['form_counter'], other['form_counter']], [first['values']['index'], other['values']['index']])
        self.assertEqual(first['summary_values'],first['values'])
        with self.assertRaises(ValidationError):
            save(entry(t,{'index':99},id=first['id'],version=1))
        self.assertEqual(Forms(self.path,lambda: [],lambda: {}).entry(self.editor,first['id']),first)

    def test_header_and_footer_counter_without_body_field_survives_revisions_and_prints(self):
        settings = {'header_layout': [{'kind':'counter','align':'left'}], 'footer_layout': [{'kind':'counter','align':'right'}]}
        original = template(settings=settings)
        t = self.store.save_template(self.admin, original)
        request_id = identifier()
        self.store.assign_entry(self.admin, {'id': request_id, 'template_id': t['id'], 'template_version': t['version'],
                                             'member_id': self.editor['id']})
        requested = self.store.entry(self.editor, request_id)
        self.assertIsNone(requested['form_counter'])
        second = self.store.save_entry(self.editor, entry(t, {'site':'Second'}))
        self.assertEqual(second['form_counter'], 2)
        first = self.store.save_entry(self.editor, entry(t, {'site':'First'}, id=request_id, version=requested['version']))
        self.assertEqual(first['form_counter'], 1)
        revised = self.store.save_template(self.admin, {**original, 'version':t['version'], 'name':'Revised'})
        third = self.store.save_entry(self.editor, entry(revised, {'site':'Third'}))
        self.assertEqual(third['form_counter'], 3)
        saved = self.store.save_entry(self.editor, entry(t, {'site':'Updated'}, id=second['id'], version=second['version']))
        reopened = Forms(self.path, lambda:self.staff, lambda:{}).entry(self.editor, saved['id'])
        self.assertEqual((reopened['form_counter'], reopened['template']['settings']['footer_layout']), (2,settings['footer_layout']))
        pdf = PdfReader(BytesIO(render_form_pdf(reopened, 'ocean', {}, [], lambda _:{})))
        lines = [line.strip() for page in pdf.pages for line in page.extract_text().splitlines()]
        self.assertEqual(lines.count('Form counter · 2'), 2)
        self.assertLess(lines.index('Form counter · 2'), lines.index('Inspection'))
        self.assertEqual(lines[-1], 'Form counter · 2')

    def test_workflow_permissions_lock_and_approval_identity(self):
        stages = [{'id':'record','name':'On site','roles':['editor'],'member_ids':['sam']},
                  {'id':'review','name':'Review','roles':['admin'],
                   'approval_conditions':[{'field_id':'outcome','value':'Accepted'}]}]
        definition = template(mode='workflow',settings={'stages':stages},fields=[
            field('site',required=True),field('signature','signature',required=True),
            field('approval','approval',stage_id='review',required=True),
            field('outcome','choice',stage_id='review',options=['Accepted','Rejected'])])
        t = self.store.save_template(self.admin,definition)
        self.assertFalse(t['can_fill'])
        self.assertFalse(self.store.template(self.other,t['id'])['can_fill'])
        with self.assertRaises(ValidationError):
            self.store.save_entry(self.editor,entry(t,{'approval':True}))
        saved = self.store.save_entry(self.editor,entry(t,{'signature':True}))
        self.assertEqual(saved['values']['signature']['member_id'],'sam')
        with self.assertRaises(ValidationError):
            self.store.approve(self.editor,{'id':saved['id'],'version':1})
        saved = self.store.save_entry(self.editor,entry(t,{'site':'Job','signature':saved['values']['signature']},
                                                     id=saved['id'],version=1))
        approval = {'id':saved['id'],'version':saved['version']}
        with self.assertRaises(FormError):
            self.store.approve(self.admin,approval)
        signed = self.store.approve(self.editor,approval)
        self.assertEqual(self.store.approve(self.editor,approval),signed)
        self.assertFalse(signed['can_edit'])
        self.assertEqual((signed['stage_id'],signed['approvals'][0]['member_id']),('review','sam'))
        with self.assertRaises(ValidationError):
            self.store.save_entry(self.admin,entry(t,{'site':'Retconned'},id=saved['id'],version=signed['version']))
        reviewed = self.store.save_entry(self.admin,entry(t,{'approval':True},id=saved['id'],version=signed['version']))
        self.assertEqual(reviewed['values']['site'],'Job')
        with self.assertRaisesRegex(ValidationError,'Approval requires Outcome to be Accepted'):
            self.store.approve(self.admin,{'id':saved['id'],'version':reviewed['version']})
        reviewed = self.store.save_entry(self.admin,entry(t,{'outcome':'Accepted','approval':True},id=saved['id'],version=reviewed['version']))
        done = self.store.approve(self.admin,{'id':saved['id'],'version':reviewed['version']})
        self.assertEqual(done['status'],'submitted')
        self.assertEqual(done['approvals'][-1]['member_id'],'boss')
        self.assertFalse(self.store.entry(self.viewer,done['id'])['can_edit'])
        with self.assertRaises(FormError):
            self.store.reopen(self.editor,{'id':saved['id'],'version':done['version']})
        replay = {'id':saved['id'],'version':done['version']}
        reopened = self.store.reopen(self.admin,replay)
        self.assertEqual(self.store.reopen(self.admin,replay),reopened)
        self.assertEqual(reopened['stage_id'],'review')
        self.assertEqual(reopened['reversals'][0]['original_approval'],done['approvals'][-1])
        self.assertEqual(reopened['values']['approval'],True)

    def test_stamp_survives_row_removal_and_profile_cannot_be_spoofed(self):
        self.store.personal = lambda *,owner_id: {'signature_image':'data:image/png;base64,YQ==','signature_name':owner_id+'.png'}
        t = self.store.save_template(self.editor,template(fields=[field('group','group',
            children=[field('name'),field('digital','signature'),field('manual','manual_signature')])]))
        image = 'data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nexample').decode()
        saved = self.store.save_entry(self.editor,entry(t,{'group':[{'name':'Other'},{'digital':True,
               'manual':{'image':image,'name':'External','company':'Company'}}]}))
        row = saved['values']['group'][1]
        self.assertEqual(row['digital']['signature_name'],'sam.png')
        self.assertEqual(row['manual']['captured_by'],'sam')
        updated = self.store.save_entry(self.editor,entry(t,{'group':[row]},id=saved['id'],version=1))
        self.assertEqual(updated['values']['group'],[row])
        for invalid in ([row,row],[{**row,'digital':True}],[{**row,'manual':{**row['manual'],'name':'Different'}}]):
            with self.assertRaises(ValidationError):
                self.store.save_entry(self.editor,entry(t,{'group':invalid},id=saved['id'],version=2))

    def test_staff_sign_on_uses_authenticated_member_and_preserves_signed_rows(self):
        self.store.personal = lambda *,owner_id: {'fields':{'name':'Sam Lincoln' if owner_id=='sam' else 'Alex Lee'}}
        t = self.store.save_template(self.admin,template(fields=[field('crew','group',children=[
            field('member','person',required=True),field('when','datetime',required=True),
            field('ink','manual_signature')])]))
        image = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()
        saved = self.store.save_entry(self.editor,entry(t,{'crew':[{'member':'alex','ink':{
            'name':'Alex','company':'Other company','image':image}}]}))
        row = saved['values']['crew'][0]
        self.assertEqual((row['member'],row['ink']['name'],row['ink']['company'],row['ink']['captured_by']),
                         ('sam','Sam Lincoln','Example Co','sam'))
        self.assertTrue(row['when'])
        self.store.personal = lambda *,owner_id: {'fields':{'name':'Changed name'}}
        for changed in ({**row,'member':'alex'},{**row,'when':'2026-01-01T12:00'}):
            with self.assertRaisesRegex(ValidationError,'signed row'):
                self.store.save_entry(self.editor,entry(t,{'crew':[changed]},id=saved['id'],version=1))
        unchanged = self.store.save_entry(self.editor,entry(t,{'crew':[row]},id=saved['id'],version=1,status='submitted'))
        self.assertEqual(unchanged['values']['crew'][0],row)

    def test_formula_conditions_dates_times_and_unselected_branch(self):
        fields = [field('table','table',columns=[
            field('begin','datetime'),field('end','datetime'),field('choice','choice',options=['Pass','Retry']),
            field('elapsed','formula',formula='=TIMEDIF(A1,B1,"H")'),
            field('days','formula',formula='=DATEDIF(A1,B1,"D")'),
            field('label','formula',formula='=IF(C1="pass","Accepted","Review")'),
            field('score','formula',formula='=IF(D1>=1.5,4,1/0)')])]
        values = {'table':[{'begin':'2026-11-15T23:00','end':'2026-11-16T01:30','choice':'Pass'}]}
        t = self.store.save_template(self.editor,template(fields=fields))
        row = self.store.save_entry(self.editor,entry(t,values,status='submitted'))['values']['table'][0]
        self.assertEqual([row[k] for k in ('elapsed','days','label','score')],['2.5','1','Accepted','4'])

    def test_table_calculation_bounds_pinned_values_and_cross_table_ranges(self):
        tables = [field('cost','table',columns=[
            field('qty','number'), field('unit','number'),field('amount','formula',formula='=A1*B1'),
            field('choice','choice',options=['L','M']),
            field('item','list_property',source_column='choice',mapping={'L':'Large','M':'Medium'})]),
            field('total','table',table_mode='fixed',default=[{}],columns=[
                field('grand','formula',formula='=SUM(Table1!C$1:C$2)'),
                field('mean','formula',formula='=AVERAGE(Table1!C$1:C$2)'),
                field('minimum','formula',formula='=MIN(Table1!A$1:A$2)'),
                field('mixed','formula',formula='=-(MAX(Table1!A$1:A$2)-5)/2')])]
        values = {'cost':[{'qty':2,'unit':4.5,'choice':'L','amount':'132'},{'qty':3,'unit':2}],
                  'total':[{'grand':'fake input'}]}
        t = self.store.save_template(self.editor,template(fields=tables))
        preview = FormsHTTP.calculate(self.editor,{'fields':tables,'values':values})['values']
        self.assertEqual(preview['cost'],[{'amount':'9','item':'Large'},{'amount':'6','item':''}])
        self.assertEqual(preview['total'],[{'grand':'15','mean':'7.5','minimum':'2','mixed':'1'}])
        submitted = self.store.save_entry(self.editor,entry(t,values,status='submitted'))
        self.assertEqual(submitted['values']['total'],preview['total'])
        self.assertEqual(submitted['values']['cost'][0]['amount'],'9')
        with self.assertRaises(ValidationError):
            self.store.save_entry(self.editor,entry(t,{**values,'total':[{},{}]}))
        for invalid in ('=open("file")','=2**2','=A1+', '=(' * 40+'1'+')'*40, '=SUM(Table1:Table2!)'):
            with self.subTest(invalid=invalid), self.assertRaises(ValidationError):
                self.store.save_template(self.editor,template(fields=[field('table','table',columns=[
                    field('calculated','formula',formula=invalid)])]))
        for expression,error in [('=A1','#CYCLE!'),('=1/0','#DIV/0!'),('=Table12!A1','#REF!')]:
            invalid = self.store.save_template(self.editor,template(fields=[field('table','table',columns=[
                field('calculated','formula',formula=expression)])]))
            saved = self.store.save_entry(self.editor,entry(invalid,{'table':[{}]}))
            self.assertEqual(saved['values']['table'][0]['calculated'],error)
            with self.assertRaises(ValidationError):
                self.store.save_entry(self.editor,entry(invalid,{'table':[{}]},status='submitted'))

    def test_register_cells_use_typed_saved_values_and_pinned_fixed_rows(self):
        fields = [field('site'),field('cost','table',table_mode='fixed',default=[{},{}], columns=[
            field('price','number'),field('net','formula',formula='=A1*2'),field('sign','signature'),
            field('okay','yes_no',explanation_on=['No'])])]
        cells = [{'field_id':'cost','row':0,'column_id':'price'},{'field_id':'cost','row':1,'column_id':'net'},
                 {'field_id':'cost','row':1,'column_id':'okay'}]
        definition = template(fields=fields,settings={'summary_fields':['site'],'summary_cells':cells})
        t = self.store.save_template(self.editor,definition)
        values = {'site':'Here','cost':[{'price':0},{'price':2.2,'net':'invented','okay':{'answer':'No','explanation':'Reason'}}]}
        saved = self.store.save_entry(self.editor,entry(t,values,status='submitted'))
        expected = {'site':'Here','cost:0:price':0,'cost:1:net':'4.4','cost:1:okay':'No'}
        self.assertEqual(saved['summary_values'],expected)
        self.store.save_template(self.editor,{**definition,'version':1,'settings':{'summary_fields':['site']}})
        self.assertEqual(self.store.entries(self.viewer)['entries'][0]['summary_values'],expected)
        invalid = [{**cells[0],'row':False},{**cells[0],'row':2},{**cells[0],'row':-1},{**cells[0],'column_id':'sign'},
                   {**cells[0],'field_id':'site'},{**cells[0],'column_id':'oops'}]
        for cell in invalid:
            with self.subTest(cell=cell), self.assertRaises(ValidationError):
                self.store.save_template(self.editor,template(fields=fields,settings={'summary_cells':[cell]}))
        for selections in [cells+[cells[0]],cells+[{'field_id':'cost','row':0,'column_id':'net'},{'field_id':'cost','row':1,'column_id':'price'}]]:
            with self.assertRaises(ValidationError):
                self.store.save_template(self.editor,template(fields=fields,settings={'summary_fields':['site'],'summary_cells':selections}))
        with self.assertRaises(ValidationError):
            self.store.save_template(self.editor,template(fields=[fields[0],{**fields[1],'table_mode':'dynamic'}],
                                                        settings={'summary_cells':cells}))

    def test_media_metadata_round_trip_bounds_access_and_sealed_profile(self):
        photo = field('media','photo',photo_size='xl',show_tags=True,show_description=True)
        t = self.store.save_template(self.editor,template(fields=[photo,field('plain','attachment'),
            field('profile','profile_company'),field('table','table',columns=[photo])]))
        plain = {'name':'image.png','type':'image/png','data':base64.b64encode(b'\x89PNG\r\n\x1a\nexample').decode()}
        marked = {**plain,'tags':['  Slab  ','L1'],'description':'  Before inspection  '}
        values = {'media':[marked,plain],'table':[{'media':[marked]}],'profile':True}
        saved = self.store.save_entry(self.editor,entry(t,values))
        cleaned = {**plain,'tags':['Slab','L1'],'description':'Before inspection'}
        self.assertEqual(saved['values']['media'],[cleaned,plain])
        self.assertEqual(saved['values']['table'][0]['media'],[cleaned])
        with self.assertRaises(FormError):
            self.store.entry(self.viewer,saved['id'])
        for change in ({'description':'x'*2001},{'tags':['x']*21},{'tags':[' Slab ','sLaB']},{'tags':[{}]},
                       {'tags':['x'*81]},{'member_id':'sam'}):
            with self.subTest(change=change), self.assertRaises(ValidationError):
                self.store.save_entry(self.editor,entry(t,{'media':[{**plain,**change}]}))
        for changed in ({'plain':[marked]},{'profile':'other'},{'profile':True},{'profile':''}):
            with self.assertRaises(ValidationError):
                self.store.save_entry(self.editor,entry(t,{**saved['values'],**changed},id=saved['id'],version=1))
        self.store.save_entry(self.editor,entry(t,saved['values'],id=saved['id'],version=1,status='submitted'))
        self.assertEqual(self.store.entry(self.viewer,saved['id'])['values']['media'],[cleaned,plain])

    def test_authorized_expiry_reminders_and_video(self):
        t = self.store.save_template(self.editor,template(fields=[
            field('expire','expiry_date',reminder_days=0),field('name'),field('movie','photo',photo_size='xl')],
            settings={'sort_field':'name','header_layout':[{'kind':'text','align':'left','text':'Site work'}]}))
        movie = {'name':'recording.mp4','type':'video/mp4','data':base64.b64encode(b'\0\0\0\x18ftypisom0000').decode()}
        self.store.save_entry(self.editor,entry(t,{'expire':'2026-12-31','name':'Job','movie':[movie]},status='submitted'))
        row, = self.store.entries(self.viewer)['entries']
        self.assertEqual(row['reminders'],[{'label':'Expire','date':'2026-12-31','days_before':0}])
        self.assertEqual(row['summary_values'],{'name':'Job'})
        self.assertNotIn('values',row)
        with self.assertRaises(ValidationError):
            self.store.save_entry(self.editor,entry(t,{'movie':[{**movie,'type':'video/webm'}]}))

    def test_typed_fields_identity_relationships_and_attachments(self):
        png = base64.b64encode(b'\x89PNG\r\n\x1a\nexample').decode()
        definition = template(fields=[
            field('outcome','yes_no',options=['Yes','No'],explanation_on=['No']),
            field('comments',required=True,condition={'field_id':'outcome','value':'No'}),
            field('members','group',children=[field('scan','scan_id'),field('signed','signature')]),
            field('name','profile_name'),field('phone','profile_phone'),field('employer','profile_company'),
            field('passport','staff_wallet'),field('period','datetime_range',timezone=True),
            field('rows','table',columns=[field('qty','number',required=True)]),field('photos','photo'),
            field('linked','relationship')],settings={'attachments':[{
                'name':'note.txt','type':'text/plain','data':'data:text/plain;base64,YQ=='}]})
        t = self.store.save_template(self.editor,definition)
        source = self.store.save_entry(self.other,entry(t,{}))
        values = {'outcome':'Yes','comments':'Hidden','members':[{'scan':'sam','signed':True}],
                  'name':True,'phone':True,'employer':True,'passport':True,
                  'period':{'start':'2026-10-20T10:00+11:00','end':'2026-10-20T10:00+10:00'},
                  'rows':[{'qty':0}], 'photos':[{'name':'site.png','type':'image/png','data':png}]}
        for bad in [{'members':[{'scan':'unknown'}]},{'members':[{'signed':{'member_id':'alex'}}]},
                {'passport':'sam'},{'linked':{'entry_id':source['id']}},{'rows':[{'extra':42}]},
                {'outcome':'No'},{'outcome':{'answer':'No','explanation':'Issue'},'comments':''},
                {'period':{'start':'2026-02-31T12:30+11:00','end':''}},
                {'photos':[{'name':'test.png','type':'image/png','data':'YQ=='}]}]:
            with self.subTest(bad=bad):
                with self.assertRaises(ValidationError):
                    self.store.save_entry(self.editor,entry(t,{**values,**bad},status='submitted'))
        saved = self.store.save_entry(self.editor,entry(t,values,status='submitted'))
        self.assertNotIn('comments',saved['values'])
        self.assertEqual(saved['values']['members'][0]['signed']['member_id'],'sam')
        self.assertEqual(saved['values']['passport']['role'],'editor')
        self.assertEqual([saved['values'][key] for key in ('name','phone','employer')],['Sam','123','Example Co'])
        linked = self.store.save_entry(self.other,entry(t,{'linked':{'entry_id':saved['id']}}))
        self.assertEqual(linked['values']['linked']['entry_id'],saved['id'])


class FormsHTTPTests(unittest.TestCase):
    def test_settings_enforced_through_http(self):
        with TemporaryDirectory() as folder:
            root = Path(folder)
            server = create_server(0,root/'local.sqlite3',edition='standard',library_directory=root/'library')
            thread = Thread(target=server.serve_forever,daemon=True)
            thread.start()
            def request(path,body=None,cookie='',member=None):
                connection = HTTPConnection('127.0.0.1',server.server_port,timeout=10)
                headers = {'Content-Type':'application/json','Cookie':cookie}
                if member is not None:
                    headers['X-CRM-Member'] = member
                try:
                    connection.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
                    response = connection.getresponse()
                    return response.status,json.loads(response.read()),response.getheader('Set-Cookie')
                finally:
                    connection.close()
            try:
                scheduler = SchedulerStore(root/'local-scheduler.sqlite3')
                access = CRMAccess(root/'local-access.sqlite3',scheduler)
                password = 'Synthetic-Forms-Access-Test'
                bootstrap = scheduler.write('setup',{'name':'Admin','email':'admin@example.test','password':password})
                worker = scheduler.write('members/save',{'name':'User','email':'worker@example.test','password':password,
                                               'role':'worker','active':True,'base_rate':'0'},bootstrap['token'])
                admin = bootstrap['user']['id']
                cookie = request('/api/access/login',{'email':'admin@example.test','password':password})[2].split(';')[0]
                unassigned = request('/api/access/login',{'email':'worker@example.test','password':password})[2].split(';')[0]
                self.assertEqual(request('/api/forms/staff')[0],401)
                self.assertEqual(request('/api/forms/staff',cookie=unassigned)[0],403)
                self.assertEqual(request('/api/forms/templates',cookie=cookie,member=worker['id'])[0],409)
                access.assign({'member_id':worker['id'],'role':'viewer','version':0},bootstrap['token'])
                body = template()
                self.assertEqual(request('/api/forms/template/save',body,cookie,worker['id'])[0],409)
                self.assertEqual(request('/api/forms/template/save',body,unassigned,worker['id'])[0],403)
                status,t,_ = request('/api/forms/template/save',body,cookie,admin)
                self.assertEqual(status,200)
                self.assertEqual(request('/api/forms/entry/save',entry(t,{'site':'X'}),unassigned,worker['id'])[0],403)
                status,saved,_ = request('/api/forms/entry/save',entry(t,{'site':'X'},status='submitted'),cookie,admin)
                self.assertEqual(status,200)
                self.assertEqual(saved['created_by'],admin)
                self.assertEqual(request('/api/forms/entries',cookie=unassigned)[1]['entries'][0]['id'],saved['id'])
                self.assertEqual(request('/api/forms/template/history?id='+t['id'],cookie=unassigned)[0],404)
                pdf_path = '/api/forms/entry/pdf?id=' + saved['id']
                self.assertEqual(request(pdf_path + '&version=99',cookie=cookie)[0],409)
                self.assertEqual(request(pdf_path + '&theme=unknown',cookie=cookie)[0],400)
                access.assign({'member_id':worker['id'],'role':'none','version':1},bootstrap['token'])
                self.assertEqual(request(pdf_path,cookie=unassigned)[0],403)
                self.assertEqual(request('/api/forms/entry?id='+saved['id'],cookie=unassigned)[0],403)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
