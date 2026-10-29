"""Global cover precedence, migration and signer artwork remain explicit and frozen."""
import base64
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import tempfile
from threading import Barrier
import unittest
import uuid

from PIL import Image
from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

from estimator.catalog import ValidationError
from estimator.certification import CertificationService, CertificationConflict, FIELDS, SIGNER_FIELDS, validate_options
from estimator.certification_signature import validate_signature, signature_reader
from estimator.company_settings import DEFAULTS
from estimator.pdf_cover import prepend_cover_pdf
from estimator.pdf_download_covers import KINDS, PdfDownloadCovers, PdfCoverConflict
from estimator.storage import Store


def pdf(text):
    output=BytesIO(); canvas=Canvas(output); canvas.drawString(30, 500, text); canvas.save()
    return output.getvalue()


def cover(text):
    return 'data:application/pdf;base64,'+base64.b64encode(pdf(text)).decode()


def signature(colour='black', format='PNG', size=(180,60)):
    output=BytesIO(); Image.new('RGB',size,colour).save(output,format=format)
    return 'data:image/'+('png' if format=='PNG' else 'jpeg')+';base64,'+base64.b64encode(output.getvalue()).decode()


def text_pages(payload):
    return [page.extract_text().strip() for page in PdfReader(BytesIO(payload)).pages]


class PdfDownloadCoverTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'state.sqlite3')
        self.service=CertificationService(self.store,renderer=lambda *a,**k:pdf('BODY'))
        self.covers=self.service.covers

    def test_catalog_is_finite_ordered_persistent_and_defaults_empty(self):
        items=self.covers.list()['items']
        self.assertEqual(len(items),18)
        self.assertEqual([(row['kind'],row['label']) for row in items],list(KINDS))
        self.assertEqual(len({row['kind'] for row in items}),18)
        self.assertTrue(all(not row['has_cover'] and 'cover_pdf' not in row and row['cover_pdf_name']=='' and row['version']==1 for row in items))
        self.assertEqual(PdfDownloadCovers(Store(self.store.path)).list(),self.covers.list())
        self.assertEqual(self.store.company_settings(),DEFAULTS)

    def test_main_then_specific_then_content_with_identical_covers_kept_twice(self):
        main={'cover_pdf':cover('MAIN')};specific={'cover_pdf':cover('SPECIFIC')};body=pdf('BODY')
        self.assertEqual(text_pages(prepend_cover_pdf(body,main,specific)),['MAIN','SPECIFIC','BODY'])
        self.assertEqual(text_pages(prepend_cover_pdf(body,main,main)),['MAIN','MAIN','BODY'])
        self.assertEqual(text_pages(prepend_cover_pdf(body,{},specific)),['SPECIFIC','BODY'])
        self.assertIs(prepend_cover_pdf(body,{},{}),body)
        self.assertEqual(text_pages(body),['BODY'])

    def test_per_kind_cas_retry_clear_and_isolation(self):
        original=self.covers.list();saved=self.covers.save('estimate',cover('ONE'),'One.pdf',1)
        self.assertEqual(saved['version'],2)
        self.assertEqual(self.covers.save('estimate',saved['cover_pdf'],'One.pdf',1),saved)
        with self.assertRaises(PdfCoverConflict):self.covers.save('estimate',cover('OTHER'),'Other.pdf',1)
        cleared=self.covers.save('estimate',None,'',2)
        self.assertEqual(cleared['version'],3);self.assertIsNone(cleared['cover_pdf'])
        self.assertEqual(PdfDownloadCovers(self.store).get('estimate'),cleared)
        self.assertEqual(self.covers.metadata(self.covers.get('certification')),original['items'][0])
        self.assertEqual(self.store.company_settings(),DEFAULTS)

    def test_concurrent_kind_edits_have_one_winner(self):
        gate=Barrier(2)
        def save(label):
            gate.wait(timeout=10)
            try:return self.covers.save('estimate',cover(label),label+'.pdf',1)
            except PdfCoverConflict:return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:outcomes=list(pool.map(save,['First','Second']))
        self.assertEqual(outcomes.count('conflict'),1)
        self.assertEqual(self.covers.get('estimate')['version'],2)

    def test_invalid_kind_pdf_name_and_version_never_change_a_row(self):
        before=self.covers.list()
        for kind,value,name,version in [('unknown',None,'',1),('estimate','not PDF','Bad.pdf',1),
                ('estimate',cover('BAD'),'../Bad.pdf',1),('estimate',None,None,1),
                ('estimate',None,'\ud800',1),('estimate',None,'',True),('estimate',None,'',0)]:
            with self.subTest(kind=kind,name=name,version=version),self.assertRaises(ValidationError):self.covers.save(kind,value,name,version)
        self.assertEqual(self.covers.list(),before)

    def test_legacy_cover_seeds_once_without_rewriting_documents_or_pdf(self):
        selected={'cover_pdf':cover('LEGACY'),'cover_pdf_name':'Legacy.pdf','scopes':[]}
        old=self.service.create({'name':'Entered signer'},options=selected)
        generated=self.service.generate(old['id'],old['fields'],1,str(uuid.uuid4()),DEFAULTS)
        frozen=self.service.revision_pdf(old['id'],1)
        self.service.create({'project':'Newer saved document with no local cover'})
        with self.store.connect() as db:
            before=db.execute('SELECT * FROM certification_documents').fetchall()
            revisions=db.execute('SELECT * FROM certification_revisions').fetchall()
            db.execute('DROP TABLE pdf_download_covers')
        upgraded=CertificationService(Store(self.store.path))
        row=upgraded.covers.get('certification')
        self.assertEqual(row['cover_pdf'],selected['cover_pdf'])
        self.assertEqual(row['provenance'],{'source':'legacy_certificate_cover','document_id':old['id']})
        self.assertEqual(upgraded.get(old['id']),generated['document'])
        self.assertEqual(upgraded.revision_pdf(old['id'],1),frozen)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT * FROM certification_documents').fetchall(),before)
            self.assertEqual(db.execute('SELECT * FROM certification_revisions').fetchall(),revisions)
        upgraded.covers.save('certification',None,'',1)
        restarted=CertificationService(Store(self.store.path),renderer=lambda *a,**k:pdf('NEXT BODY'))
        self.assertIsNone(restarted.covers.get('certification')['cover_pdf'])
        later=restarted.generate(old['id'],old['fields'],2,str(uuid.uuid4()),DEFAULTS)
        self.assertEqual(text_pages(restarted.revision_pdf(old['id'],later['revision']['revision'])),['NEXT BODY'])
        self.assertEqual(restarted.get(old['id'])['options'],selected)

    def test_signature_validation_decodes_and_rejects_unsafe_or_malformed_images(self):
        for image,name in [(signature(),'Signed.png'),(signature(format='JPEG'),'Signed.jpg')]:
            self.assertEqual(validate_signature(image,name),(image,name))
            self.assertEqual(signature_reader(image).getSize(),(180,60))
        self.assertEqual(validate_signature(None,'Old name'),(None,''))
        for image,name in [('data:image/svg+xml;base64,PHN2Zz4=','Signed.svg'),('data:image/png;base64,YmFk','Bad.png'),
                           (signature(),'../Signed.png'),(signature(size=(2001,2001)),'Large.png'),
                           (signature().replace('image/png','image/jpeg'),'Wrong.jpg')]:
            with self.subTest(name=name),self.assertRaises(ValidationError):validate_signature(image,name)

    def test_indexed_png_transparency_and_jpeg_orientation_are_preserved(self):
        indexed=Image.new('P',(24,12),0);indexed.putpalette([255,255,255,0,0,0]+[0]*762)
        indexed.putpixel((8,5),1);indexed.info['transparency']=0
        output=BytesIO();indexed.save(output,format='PNG',transparency=0)
        value='data:image/png;base64,'+base64.b64encode(output.getvalue()).decode()
        from estimator.certification_report import render_certificate_pdf
        payload=render_certificate_pdf(dict.fromkeys(FIELDS,''),company=DEFAULTS,
                certificate_id=str(uuid.uuid4()),revision=1,created_at='2026-10-30T00:00:00+00:00',signature=value)
        images=[item.get_object() for page in PdfReader(BytesIO(payload)).pages
                for item in page.get('/Resources',{}).get('/XObject',{}).values()]
        self.assertTrue(any(image.get('/Width')==24 and '/SMask' in image for image in images))
        jpeg=Image.new('RGB',(30,10),'white');exif=Image.Exif();exif[274]=6
        output=BytesIO();jpeg.save(output,format='JPEG',exif=exif)
        value='data:image/jpeg;base64,'+base64.b64encode(output.getvalue()).decode()
        validate_signature(value,'Rotated.jpg')
        self.assertEqual(signature_reader(value).getSize(),(10,30))

    def test_signature_defaults_cas_legacy_clients_and_revision_snapshot(self):
        entered={**dict.fromkeys(SIGNER_FIELDS,''),'name':'Signer'}
        image=signature();saved=self.service.save_defaults(entered,1,signature_image=image,signature_name='Signer.png')
        self.assertEqual(saved['version'],2);self.assertEqual(saved['signature_image'],image)
        self.assertEqual(self.service.save_defaults(entered,1,signature_image=image,signature_name='Signer.png'),saved)
        old_client=self.service.save_defaults({**entered,'position':'Installer'},2)
        self.assertEqual(old_client['signature_image'],image)
        with self.assertRaises(CertificationConflict):self.service.save_defaults(entered,1,signature_image=None,signature_name='')
        selected={'cover_pdf':None,'cover_pdf_name':'','scopes':[],'signature_image':image,'signature_name':'Signer.png'}
        document=self.service.create({'name':'Signer'},str(uuid.uuid4()),options=selected)
        captured=[]
        def render(*args,**kwargs):captured.append(kwargs.get('signature'));return pdf('SIGNED BODY')
        service=CertificationService(self.store,renderer=render)
        request=str(uuid.uuid4());generated=service.generate(document['id'],document['fields'],1,request,DEFAULTS,options=selected)
        frozen=service.revision_pdf(document['id'],1)
        self.assertEqual(captured,[image])
        self.service.save_defaults(entered,3,signature_image=signature('red'),signature_name='New.png')
        replay=service.generate(document['id'],document['fields'],1,request,DEFAULTS,options=selected)
        self.assertEqual(replay['revision'],generated['revision']);self.assertEqual(captured,[image])
        self.assertEqual(service.revision_pdf(document['id'],1),frozen)
        self.assertEqual(service.get(document['id'])['options'],selected)
        with self.assertRaises(CertificationConflict):service.generate(document['id'],document['fields'],1,request,DEFAULTS,options={**selected,'signature_name':'Changed.png'})
        for bad in ({**selected,'signature_image':'bad'},{k:v for k,v in selected.items() if k!='signature_name'}):
            with self.assertRaises(ValidationError):validate_options(bad)
