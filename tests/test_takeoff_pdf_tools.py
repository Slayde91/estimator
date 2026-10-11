"""Read-only page derivatives preserve source bytes, geometry and authority."""
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject, RectangleObject, TextStringObject
from reportlab.pdfgen import canvas

from estimator.catalog import ValidationError
from estimator.takeoff_pdf_worker import parse_pdf_stream
from estimator.takeoff_pdf_tools import build_pdf, selection, _SLOTS


def drawing(label, pages=4, change=None):
    content = BytesIO(); pdf = canvas.Canvas(content, pagesize=(220, 160), invariant=True)
    for number in range(1, pages+1):
        pdf.drawString(35, 70, f'{label} page {number}')
        pdf.setStrokeColorRGB(.1, .4, .7); pdf.rect(30, 35, 120, 80); pdf.showPage()
    pdf.save(); content.seek(0); writer = PdfWriter()
    for index, original in enumerate(PdfReader(content).pages):
        page = writer.add_page(original)
        page[NameObject('/CropBox')] = RectangleObject([10.125, 12.25, 205.875, 145.5])
        page[NameObject('/Rotate')] = NumberObject((index % 4)*90)
        page[NameObject('/UserUnit')] = FloatObject(1.25)
    if change: change(writer)
    result = BytesIO(); writer.write(result); return result.getvalue()


def static_comments(writer):
    page = writer.pages[0]
    appearance = DecodedStreamObject(); appearance.set_data(b'0 0 1 rg 0 0 20 20 re f')
    appearance.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                       NameObject('/BBox'): RectangleObject([0, 0, 20, 20])})
    note = DictionaryObject({NameObject('/Type'):NameObject('/Annot'), NameObject('/Subtype'):NameObject('/Text'),
        NameObject('/Rect'):RectangleObject([30,35,50,55]), NameObject('/Contents'):TextStringObject('A harmless source comment'),
        NameObject('/AP'):DictionaryObject({NameObject('/N'):writer._add_object(appearance)}),
        NameObject('/A'):DictionaryObject({NameObject('/S'):NameObject('/JavaScript'),NameObject('/JS'):TextStringObject('blocked()')})})
    popup = DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Popup'),
                             NameObject('/Rect'):RectangleObject([60,35,120,75])})
    note_ref, popup_ref = writer._add_object(note), writer._add_object(popup)
    note[NameObject('/Popup')] = popup_ref; popup[NameObject('/Parent')] = note_ref
    reply = DictionaryObject({NameObject('/Type'):NameObject('/Annot'),NameObject('/Subtype'):NameObject('/Text'),
        NameObject('/Rect'):RectangleObject([30,60,50,80]),NameObject('/Contents'):TextStringObject('A harmless reply'),NameObject('/IRT'):note_ref})
    page[NameObject('/Annots')] = ArrayObject([note_ref,popup_ref,writer._add_object(reply)])


def layers(writer, off=False):
    group = writer._add_object(DictionaryObject({NameObject('/Type'):NameObject('/OCG'),NameObject('/Name'):TextStringObject('Repeated layer name')}))
    page = writer.pages[0]; page['/Resources'][NameObject('/Properties')] = DictionaryObject({NameObject('/Layer'):group})
    original = page.get_contents().get_data(); stream = DecodedStreamObject()
    stream.set_data(b'/OC /Layer BDC\n'+original+b'\nEMC'); page[NameObject('/Contents')] = writer._add_object(stream)
    default = DictionaryObject({NameObject('/BaseState'):NameObject('/OFF' if off else '/ON'),
                                NameObject('/Order'):ArrayObject([group])})
    writer._root_object[NameObject('/OCProperties')] = DictionaryObject({NameObject('/OCGs'):ArrayObject([group]),NameObject('/D'):default})


class SourceResolver:
    def __init__(self): self.paths = {}; self.calls = []
    def document_path(self, document, verify=False):
        self.calls.append((document['id'],verify)); return self.paths[document['id']]


class TakeoffPDFToolsTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='ceasefire-page-tools-test-'); self.addCleanup(self.folder.cleanup)
        self.resolver = SourceResolver()
        self.snapshot = {'revision':7,'documents':[], 'items':[{'unchanged':'measurement identities'}],
                         'calibrations':[{'unchanged':'source calibration'}],'transfers':[{'unchanged':'calculator values'}],
                         'graphics':{'unchanged':'visual source identities'}}
        self.a = self.source(drawing('Alpha'), 'Alpha.pdf'); self.b = self.source(drawing('Beta',2), 'Beta.pdf')
    def source(self, payload, name):
        identifier = str(uuid4()); path = Path(self.folder.name)/(identifier+'.pdf'); path.write_bytes(payload)
        document = {'id':identifier,'name':name,'sha256':sha256(payload).hexdigest(),'size':len(payload),
                    'pages':parse_pdf_stream(BytesIO(payload))['pages']}
        self.resolver.paths[identifier] = path; self.snapshot['documents'].append(document); return document
    def export(self, operation='organise', documents=None, order=None, **fields):
        body = {'expected_revision':self.snapshot['revision'],'operation':operation,
                'document_ids':documents or [self.a['id']]}
        if operation != 'merge': body['page_order'] = order if order is not None else [4,2,1]
        return build_pdf(self.snapshot,{**body,**fields},self.resolver)
    def assert_pages(self, payload, expected):
        reader = PdfReader(BytesIO(payload)); self.assertEqual(len(reader.pages),len(expected))
        for index,(source,page) in enumerate(expected):
            self.assertIn(f'{source["name"].split(".")[0]} page {page}',reader.pages[index].extract_text())
        metadata = parse_pdf_stream(BytesIO(payload))['pages']
        self.assertEqual(metadata,[{**source['pages'][page-1],'page':index} for index,(source,page) in enumerate(expected,1)])
        return reader
    def test_merge_uses_document_order_and_preserves_every_original_and_draft_field(self):
        before = deepcopy(self.snapshot); originals = {key:path.read_bytes() for key,path in self.resolver.paths.items()}
        payload,kind,name = self.export('merge',[self.b['id'],self.a['id']])
        self.assertEqual((kind,name),('application/pdf','CEASEFIRE-Merged-PDF.pdf'))
        self.assert_pages(payload,[(self.b,1),(self.b,2),*( (self.a,n) for n in range(1,5))])
        self.assertEqual(self.snapshot,before)
        self.assertEqual(originals,{key:path.read_bytes() for key,path in self.resolver.paths.items()})
        self.assertEqual(self.resolver.calls,[(self.b['id'],True),(self.a['id'],True)])
    def test_organise_removes_and_reorders_without_rescaling_crop_rotation_or_userunit(self):
        payload,_,name = self.export(order=[4,1,3]); self.assertEqual(name,'CEASEFIRE-Organised-Pages.pdf')
        self.assert_pages(payload,[(self.a,4),(self.a,1),(self.a,3)])
    def test_extract_subset_keeps_output_order_and_original_page_content(self):
        payload,_,name = self.export('extract',order=[2,4]); self.assertEqual(name,'CEASEFIRE-Extracted-Pages.pdf')
        reader = self.assert_pages(payload,[(self.a,2),(self.a,4)])
        original = PdfReader(self.resolver.paths[self.a['id']])
        self.assertEqual(reader.pages[0].get_contents().get_data(),original.pages[1].get_contents().get_data())
    def test_invalid_requests_fail_before_source_resolution_or_child_process(self):
        invalid = [ {'expected_revision':True},{'expected_revision':6},{'path':'C:/private.pdf'}, {'filename':'private.pdf'},
            {'operation':'delete-original'},{'document_ids':[str(uuid4())]}, {'document_ids':[self.a['id'],self.a['id']]},
            {'document_ids':[True]}, {'document_ids':[]}, {'document_ids':[self.a['id'],self.b['id']]},
            {'page_order':[]},{'page_order':[True]},{'page_order':[1,1]},{'page_order':[0]},{'page_order':[5]},
            {'page_order':['1']},{'page_order':[1.0]}, {'page_order':None},{'signature_ids':[]}, {'item_ids':[]}]
        before = deepcopy(self.snapshot)
        with patch('estimator.takeoff_pdf_tools.subprocess.run',side_effect=AssertionError('Invalid request started child')):
            for fields in invalid:
                with self.subTest(fields=list(fields)),self.assertRaises(ValidationError): self.export(**fields)
        self.assertEqual(self.resolver.calls,[]); self.assertEqual(self.snapshot,before)
        for fields in ({'document_ids':[self.a['id']]},{'page_order':[1]}):
            with self.assertRaises(ValidationError): self.export('merge',[self.a['id'],self.b['id']],**fields)
    def test_combined_input_and_output_page_limits_fail_before_worker(self):
        state = deepcopy(self.snapshot)
        state['documents'][0]['size'] = 250*1024*1024
        with self.assertRaisesRegex(ValidationError,'combined'):
            selection(state,{'expected_revision':7,'operation':'merge','document_ids':[self.a['id'],self.b['id']]})
        state = deepcopy(self.snapshot); template = state['documents'][0]['pages'][0]
        state['documents'][0]['pages'] = [{**deepcopy(template),'page':n} for n in range(1,2001)]
        with self.assertRaisesRegex(ValidationError,'2,000'):
            selection(state,{'expected_revision':7,'operation':'merge','document_ids':[self.a['id'],self.b['id']]})
    def test_worker_rechecks_original_hash_and_geometry_before_copying(self):
        path = self.resolver.paths[self.a['id']]; original = path.read_bytes(); before = deepcopy(self.snapshot)
        path.write_bytes(original+b'\nChanged')
        with self.assertRaisesRegex(ValidationError,'changed before'): self.export()
        path.write_bytes(original); self.a['pages'][0]['user_unit'] = 1.5
        with self.assertRaisesRegex(ValidationError,'geometry changed'): self.export()
        self.a['pages'][0]['user_unit'] = 1.25; self.assertEqual(self.snapshot,before)
    def test_static_comments_appearances_and_popup_relationships_survive_without_actions(self):
        source = self.source(drawing('Comments',1,static_comments),'Comments.pdf')
        payload = self.export('extract',[source['id']],[1])[0]; page = PdfReader(BytesIO(payload)).pages[0]
        note,popup,reply = [value.get_object() for value in page['/Annots']]
        self.assertEqual(note['/Contents'],'A harmless source comment'); self.assertNotIn('/A',note); self.assertNotIn('/AA',note)
        self.assertEqual(note['/AP']['/N'].get_data(),b'0 0 1 rg 0 0 20 20 re f')
        self.assertEqual(note['/Popup'].indirect_reference,popup.indirect_reference)
        self.assertEqual(popup['/Parent'].indirect_reference,note.indirect_reference)
        self.assertEqual(note['/P'].indirect_reference,page.indirect_reference)
        self.assertEqual(reply['/IRT'].indirect_reference,note.indirect_reference)
        self.assertNotIn(b'blocked()',payload,'Reply relationships must not clone an unfiltered old annotation.')
    def test_widgets_attachments_and_dynamic_media_are_rejected_without_flattening(self):
        for subtype in ('/Widget','/FileAttachment','/RichMedia'):
            def annotate(writer):
                value = DictionaryObject({NameObject('/Subtype'):NameObject(subtype),NameObject('/Rect'):RectangleObject([20,20,40,40])})
                writer.pages[0][NameObject('/Annots')] = ArrayObject([writer._add_object(value)])
            source = self.source(drawing('Unsafe',1,annotate),'Unsafe.pdf')
            before = self.resolver.paths[source['id']].read_bytes()
            with self.subTest(subtype=subtype),self.assertRaisesRegex(ValidationError,'widgets, attachments'):
                self.export('extract',[source['id']],[1])
            self.assertEqual(self.resolver.paths[source['id']].read_bytes(),before)
    def test_fresh_catalog_drops_active_names_form_and_page_actions_and_link_destinations(self):
        def actions(writer):
            action = DictionaryObject({NameObject('/S'):NameObject('/JavaScript'),NameObject('/JS'):TextStringObject('blocked()')})
            writer._root_object[NameObject('/OpenAction')] = action
            writer._root_object[NameObject('/Names')] = DictionaryObject({NameObject('/JavaScript'):action})
            writer._root_object[NameObject('/AcroForm')] = DictionaryObject({NameObject('/Fields'):ArrayObject()})
            writer.pages[0][NameObject('/AA')] = DictionaryObject({NameObject('/O'):action})
            link = DictionaryObject({NameObject('/Subtype'):NameObject('/Link'),NameObject('/Rect'):RectangleObject([20,20,80,40]),NameObject('/A'):action})
            writer.pages[0][NameObject('/Annots')] = ArrayObject([writer._add_object(link)])
        source = self.source(drawing('Actions',1,actions),'Actions.pdf')
        reader = PdfReader(BytesIO(self.export('extract',[source['id']],[1])[0]))
        for key in ('/OpenAction','/Names','/AcroForm'): self.assertNotIn(key,reader.trailer['/Root'])
        self.assertNotIn('/AA',reader.pages[0]); self.assertNotIn('/A',reader.pages[0]['/Annots'][0].get_object())
    def test_merged_optional_content_keeps_distinct_same_name_layers_and_on_off_state(self):
        on = self.source(drawing('On',1,lambda writer:layers(writer,False)),'On.pdf')
        off = self.source(drawing('Off',1,lambda writer:layers(writer,True)),'Off.pdf')
        reader = PdfReader(BytesIO(self.export('merge',[off['id'],on['id']])[0])); config = reader.trailer['/Root']['/OCProperties']
        groups = config['/OCGs']; self.assertEqual(len(groups),2); self.assertNotEqual(groups[0],groups[1])
        self.assertEqual(config['/D']['/OFF'],[groups[0]]); self.assertEqual(config['/D']['/ON'],[groups[1]])
        for index,page in enumerate(reader.pages): self.assertEqual(page['/Resources']['/Properties'].raw_get('/Layer'),groups[index])
    def test_encrypted_and_invalid_magic_are_rejected_in_bounded_child(self):
        original = self.resolver.paths[self.a['id']].read_bytes(); writer = PdfWriter();writer.append(PdfReader(BytesIO(original)));writer.encrypt('private')
        output = BytesIO();writer.write(output)
        for payload,message in ((output.getvalue(),'Encrypted'),(b'not a PDF','valid PDF')):
            path = self.resolver.paths[self.a['id']];path.write_bytes(payload)
            self.a.update(sha256=sha256(payload).hexdigest(),size=len(payload))
            with self.subTest(message=message),self.assertRaisesRegex(ValidationError,message):self.export()
    def test_timeout_and_bad_completion_fail_closed_and_release_slot(self):
        with patch('estimator.takeoff_pdf_tools.subprocess.run',side_effect=subprocess.TimeoutExpired('worker',65)):
            with self.assertRaisesRegex(ValidationError,'time limit'):self.export()
        with patch('estimator.takeoff_pdf_tools.subprocess.run',return_value=subprocess.CompletedProcess([],0,b'{"bad":true}')):
            with self.assertRaisesRegex(ValidationError,'safely'):self.export()
        self.assert_pages(self.export(order=[1])[0],[(self.a,1)])
    def test_concurrent_job_is_rejected_without_mutation(self):
        self.assertTrue(_SLOTS.acquire(blocking=False))
        try:
            with self.assertRaisesRegex(ValidationError,'in progress'):self.export()
        finally:_SLOTS.release()
    def test_output_receipt_cannot_substitute_different_geometry_or_file_hash(self):
        payload = self.resolver.paths[self.a['id']].read_bytes()
        def spoof(command,**kwargs):
            output = Path(command[-1]);output.write_bytes(payload)
            receipt={'sha256':sha256(payload).hexdigest(),'size':len(payload),'pages':3,'metadata':self.a['pages'][:3]}
            return subprocess.CompletedProcess(command,0,json.dumps(receipt).encode())
        with patch('estimator.takeoff_pdf_tools.subprocess.run',side_effect=spoof):
            with self.assertRaisesRegex(ValidationError,'geometry did not match'):self.export(order=[4,2,1])


if __name__ == '__main__': unittest.main()
