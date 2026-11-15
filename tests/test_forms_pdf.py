from base64 import b64encode
from io import BytesIO
import unittest

from PIL import Image
from pypdf import PdfReader

from estimator.forms_pdf import render_form_pdf


class FormPdfTests(unittest.TestCase):
    def test_rich_defaults_responses_and_table_instructions_use_real_pdf_fonts(self):
        rich = {'html':'<p><b>Bold ink</b> <i>Italic ink</i></p><ol><li>First item</li></ol>'}
        fields = [{'id':'instructions','type':'instruction','label':'Directions','help':rich},
                  {'id':'notes','type':'textarea','label':'Notes'},
                  {'id':'table','type':'table','label':'Rows','columns':[
                      {'id':'step','type':'instruction','label':'Step','help':{'html':'<u>Table directions</u>'}},
                      {'id':'memo','type':'textarea','label':'Memo'}]}]
        template = {'id':'t','name':'Rich form','version':1,'fields':fields,'settings':{}}
        entry = {'id':'e','version':1,'created_by_name':'Tester','template':template,
                 'values':{'notes':rich,'table':[{'memo':'<b>plain text</b>'}]}}
        pdf = PdfReader(BytesIO(render_form_pdf(entry,'ocean',{},[],lambda _:{})))
        runs = []
        def visit(text, cm, tm, font, size):
            if text.strip() and font:
                runs.append((text.strip(),font.get('/BaseFont','')))
        extracted = pdf.pages[0].extract_text(visitor_text=visit)
        self.assertIn('1. First item',extracted)
        self.assertIn('Table directions',extracted)
        self.assertIn('<b>plain text</b>',extracted)
        self.assertTrue(any('Bold ink' in s and 'Bold' in f for s,f in runs))
        self.assertTrue(any('Italic ink' in s and 'Italic' in f for s,f in runs))

    def test_saved_images_signatures_hidden_fields_and_group_photo_appendix(self):
        image = BytesIO()
        Image.new('RGB',(100,40),'red').save(image,format='PNG')
        data = b64encode(image.getvalue()).decode()
        photo = {'name':'Site photo.png','type':'image/png','data':data,'description':'After inspection'}
        fields = [{'id':'private','type':'text','label':'Internal notes','hide_in_pdf':True},
                  {'id':'show','type':'choice','label':'Show details'},
                  {'id':'secret','type':'text','label':'Withheld details','condition':{'field_id':'show','value':'Yes'}},
                  {'id':'group','type':'group','label':'Site visits','children':[
                      {'id':'photos','type':'photo','label':'Photos','photo_size':'large','show_description':True}]},
                  {'id':'signed','type':'manual_signature','label':'Signed by'},
                  {'id':'staff','type':'scan_id','label':'Staff ID'},
                  {'id':'international','type':'text','label':'Location'},
                  {'id':'schedule','type':'table','label':'Schedule','columns':[{'id':'job','type':'text','label':'Job code'}]},
                  {'id':'file','type':'attachment','label':'Evidence file'}]
        values = {'private':'Confidential text','show':'No','secret':'Hidden answer','staff':'a1','international':'Site 检测',
                  'file':[{'type':'image/png','data':b64encode(b'Invalid image').decode(),'name':'attachment.png'}],
                  'group':[{'photos':[photo]}],
                  'signed':{'name':'Amanda','company':'Example','image':'data:image/png;base64,'+data,'at':'2026-11-15T08:30:00Z'}}
        template = {'id':'template','version':1,'name':'Site report','settings':{'photo_appendix':True,'photos_per_page':2},'fields':fields}
        entry = {'id':'entry','template':template,'created_by_name':'Staff','values':values,'version':2}
        pdf = PdfReader(BytesIO(render_form_pdf(entry,'ocean',{'name':'Test'},[{'id':'a1','name':'Alex Staff'}],lambda _:{})))
        self.assertEqual(len(pdf.pages),2)
        first,last = [page.extract_text() for page in pdf.pages]
        for item in ('Site visits','Site photo.png','After inspection','Amanda','Example','15/11/2026',
                     'Job code','Alex Staff','a1','attachment.png','Image unavailable in this PDF.','检测'):
            self.assertIn(item,first)
        for item in ('Internal notes','Withheld details','Hidden answer','Confidential text'):
            self.assertNotIn(item,first+last)
        self.assertIn('Photo appendix',last)
        self.assertIn('Site photo.png',last)
        for page in pdf.pages:
            self.assertGreater(len(page.images),0)
            self.assertLess(page.mediabox.width,page.mediabox.height)
